import test from "node:test";
import assert from "node:assert/strict";

import { createClient, loginAsAdmin, startTestServer } from "./helpers/server.mjs";
import { AppDatabase } from "../src/database.mjs";
import { createProjectSyncScheduler, nextProjectSync } from "../src/project-sync.mjs";
import { PROJECT_STATUS } from "../src/constants.mjs";

const at = (text) => new Date(text);

test("자동 동기화 다음 예정 시각: 매일 · 시간마다 · 수동 동기화 · 실패 뒤 쉬기", () => {
  const daily = { enabled: true, mode: "daily", time: "06:00", intervalHours: 6 };
  const now = at("2026-11-05T09:00:00");
  // 오늘 06:00 이 지났는데 그 뒤로 성공한 적이 없으면 지금
  assert.equal(nextProjectSync(daily, { lastOkAt: "2026-11-04T06:00:00" }, now).getTime(), now.getTime());
  // 오늘 06:00 뒤에 (수동이라도) 성공했으면 내일 06:00
  assert.equal(nextProjectSync(daily, { lastOkAt: "2026-11-05T07:30:00" }, now).getTime(), at("2026-11-06T06:00:00").getTime());
  // 아직 06:00 전이면 오늘 06:00
  assert.equal(nextProjectSync(daily, {}, at("2026-11-05T05:00:00")).getTime(), at("2026-11-05T06:00:00").getTime());

  const interval = { enabled: true, mode: "interval", time: "06:00", intervalHours: 6 };
  assert.equal(nextProjectSync(interval, { lastOkAt: "2026-11-05T08:00:00" }, now).getTime(), at("2026-11-05T14:00:00").getTime());
  assert.equal(nextProjectSync(interval, {}, now).getTime(), now.getTime());

  // 자동 동기화가 방금 실패했으면 30분 뒤에 다시 시도합니다.
  const failed = { lastOkAt: null, lastAutoAttempt: { at: "2026-11-05T08:50:00", ok: false } };
  assert.equal(nextProjectSync(interval, failed, now).getTime(), at("2026-11-05T09:20:00").getTime());

  assert.equal(nextProjectSync({ ...daily, enabled: false }, {}, now), null);
});

test("예약 시각이 되면 한 번 동기화하고, 기록을 남긴다", async () => {
  const database = new AppDatabase(":memory:");
  let calls = 0;
  const amarance = {
    async searchProjects() {
      calls += 1;
      return [{ code: "AUTO-1", name: "자동 동기화 프로젝트", contractAmount: 1_000, status: PROJECT_STATUS.ACTIVE }];
    },
    getConfiguration: () => ({ mode: "LIVE", companyCode: "1000" }),
  };
  const scheduler = createProjectSyncScheduler({ database, amarance });

  assert.equal(await scheduler.runIfDue(), false, "꺼져 있으면 돌지 않습니다");
  database.saveProjectSyncSchedule({ enabled: true, mode: "interval", intervalHours: 6, time: "06:00" });
  assert.equal(await scheduler.runIfDue(), true);
  assert.equal(await scheduler.runIfDue(), false, "방금 했으면 6시간 뒤까지 기다립니다");
  assert.equal(calls, 1);
  assert.ok(database.listProjects().some((project) => project.code === "AUTO-1"));

  const status = database.getProjectSyncStatus();
  assert.equal(status.last.trigger, "auto");
  assert.equal(status.last.ok, true);
  const audit = database.db.prepare("SELECT login_id AS loginId, detail FROM audit_logs WHERE action = 'PROJECT_SYNCED'").get();
  assert.equal(audit.loginId, "system");
  assert.match(audit.detail, /^\[자동\]/);

  assert.throws(() => database.saveProjectSyncSchedule({ enabled: true, mode: "daily", time: "25:00" }), /00:00 ~ 23:59/);
  database.close();
});

test("기성집행서 목록은 모든 프로젝트의 버전과 금액 요약, 최신 버전 여부를 준다", () => {
  const database = new AppDatabase(":memory:");
  database.upsertProjects([
    { code: "L-1", name: "목록 1", contractAmount: 1_000_000, status: PROJECT_STATUS.ACTIVE },
    { code: "L-2", name: "목록 2", contractAmount: 500_000, status: PROJECT_STATUS.ACTIVE },
  ]);
  const [first, second] = database.listProjects().sort((a, b) => a.code.localeCompare(b.code));
  const v1 = database.createSnapshot(first.id);
  const line = v1.lines.find((item) => item.items.some((entry) => entry.itemCode === "MAT-1001"));
  database.updateSnapshotLines(v1.id, [{ id: line.id, executionBudget: 400_000, remark: "" }]);
  database.importReceipts(v1.id, [
    { sourceKey: "A", receiptNo: "A", itemCode: "MAT-1001", itemName: "본체", receiptDate: "20261001", amount: 300_000, vatAmount: 0 },
    { sourceKey: "B", receiptNo: "B", itemCode: "LOOSE", itemName: "미연결", receiptDate: "20261001", amount: 50_000, vatAmount: 0 },
  ]);
  database.createSnapshot(first.id, { cloneSnapshotId: v1.id });

  const list = database.listAllSnapshots();
  assert.equal(list.length, 2);
  const old = list.find((item) => item.id === v1.id);
  assert.equal(old.isLatest, false);
  assert.equal(old.executionBudget, 400_000);
  assert.equal(old.purchaseAmount, 300_000, "미분류 입고는 매입금액에 넣지 않습니다");
  assert.equal(old.unmappedCount, 1);
  assert.equal(old.profitRate, 70);
  assert.equal(old.executionRate, 75);
  assert.equal(list.find((item) => item.id !== v1.id).isLatest, true);

  const projects = database.listProjectsWithStats();
  assert.equal(projects.find((project) => project.id === first.id).snapshotCount, 2);
  assert.equal(projects.find((project) => project.id === first.id).latestVersionNo, 2);
  assert.equal(projects.find((project) => project.id === second.id).snapshotCount, 0);
  database.close();
});

test("API: 목록 · 프로젝트 · 동기화 상태는 조회자도 보고, 자동 동기화 설정은 관리자만 바꾼다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  await loginAsAdmin(server);

  const synced = await server.client.request("/api/projects/sync", { method: "POST", body: {} });
  assert.equal(synced.status, 200);
  assert.equal(synced.data.sync.last.trigger, "manual");

  const saved = await server.client.request("/api/project-sync/schedule", { method: "PUT", body: { enabled: true, mode: "daily", time: "07:30" } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.schedule.time, "07:30");
  assert.ok(saved.data.nextAt);

  const created = await server.client.request("/api/users", { method: "POST", body: { loginId: "viewer1", name: "조회자", role: "VIEWER" } });
  const viewer = createClient(server.origin);
  await viewer.request("/api/auth/login", { method: "POST", csrf: false, body: { loginId: "viewer1", password: created.data.temporaryPassword } });
  await viewer.request("/api/auth/password", { method: "POST", body: { currentPassword: created.data.temporaryPassword, newPassword: "Viewer!pass2026" } });

  const projects = await viewer.request("/api/projects");
  assert.equal(projects.status, 200);
  assert.ok(projects.data.projects.length > 0);
  assert.equal(projects.data.sync.schedule.enabled, true);
  assert.equal((await viewer.request("/api/snapshots")).status, 200);
  assert.equal((await viewer.request("/api/project-sync/schedule", { method: "PUT", body: { enabled: false } })).status, 403);
  assert.equal((await viewer.request("/api/projects/sync", { method: "POST", body: {} })).status, 403);
});
