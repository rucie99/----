import test from "node:test";
import assert from "node:assert/strict";

import { loginAsAdmin, startTestServer } from "./helpers/server.mjs";
import { AppDatabase } from "../src/database.mjs";
import { PROJECT_STATUS, RESET_CONFIRM_PHRASE, SNAPSHOT_STATUS } from "../src/constants.mjs";
import { translateDatabaseError } from "../src/errors.mjs";

test("설정 버전마다 분류가 따로 관리된다", () => {
  const database = new AppDatabase(":memory:");
  const base = database.getCurrentCategorySetId();
  const baseCount = database.listCategories(base).length;

  const next = database.createCategorySet({ title: "2027년 기준" });
  assert.equal(database.listCategories(next.id).length, 0, "새 버전은 비어 있어야 합니다");

  database.createMajorCategory({ name: "신규 대분류", categorySetId: next.id });
  assert.equal(database.listCategories(next.id).length, 1);
  assert.equal(database.listCategories(base).length, baseCount, "다른 버전은 영향받지 않아야 합니다");

  // 같은 대분류명이라도 버전이 다르면 등록됩니다.
  const baseName = database.listCategories(base)[0].name;
  assert.doesNotThrow(() => database.createMajorCategory({ name: baseName, categorySetId: next.id }));
  // DB 계층은 원문을 던지고, 화면으로 나가기 전에 HTTP 계층이 한국어로 바꿉니다.
  assert.throws(() => database.createMajorCategory({ name: baseName, categorySetId: base }), /UNIQUE constraint failed/);
  assert.match(
    translateDatabaseError(new Error("UNIQUE constraint failed: major_categories.category_set_id, major_categories.name")).message,
    /같은 대분류명/,
  );
  database.close();
});

test("설정 버전을 복제하면 분류와 품번이 그대로 따라온다", () => {
  const database = new AppDatabase(":memory:");
  const source = database.getCurrentCategorySetId();
  const before = database.listCategories(source);
  const beforeItems = before.reduce((sum, major) => sum + major.middleCategories.reduce((n, m) => n + m.items.length, 0), 0);

  const copy = database.createCategorySet({ title: "복제본", cloneFromId: source });
  const after = database.listCategories(copy.id);
  const afterItems = after.reduce((sum, major) => sum + major.middleCategories.reduce((n, m) => n + m.items.length, 0), 0);

  assert.equal(after.length, before.length);
  assert.deepEqual(after.map((m) => m.name), before.map((m) => m.name));
  assert.equal(afterItems, beforeItems);

  // 복제본을 고쳐도 원본은 그대로여야 합니다.
  database.deleteMajorCategory(after[0].id);
  assert.equal(database.listCategories(copy.id).length, before.length - 1);
  assert.equal(database.listCategories(source).length, before.length);
  database.close();
});

test("집행서는 만들 때의 설정 버전을 따라가고, 이후 설정을 바꿔도 흔들리지 않는다", () => {
  const database = new AppDatabase(":memory:");
  database.upsertProjects([{ code: "P-SET", name: "설정 검증", contractAmount: 1_000_000, status: PROJECT_STATUS.ACTIVE }]);
  const projectId = database.listProjects()[0].id;

  const v1 = database.assertCategorySet(database.getCurrentCategorySetId());
  const first = database.createSnapshot(projectId);
  assert.equal(first.categorySetId, v1.id);
  assert.equal(first.categorySetLabel, `v${v1.versionNo} · ${v1.title}`);
  const firstLineCount = first.lines.length;

  // 새 설정 버전을 만들고 사용 중으로 지정
  const v2 = database.createCategorySet({ title: "축소 기준", cloneFromId: v1.id });
  database.deleteMajorCategory(database.listCategories(v2.id)[0].id);
  database.setCurrentCategorySet(v2.id);

  const second = database.createSnapshot(projectId);
  assert.equal(second.categorySetId, v2.id);
  assert.equal(second.categorySetLabel, `v${v2.versionNo} · 축소 기준`);
  assert.ok(second.lines.length < firstLineCount, "줄어든 설정이 반영되어야 합니다");

  // 먼저 만든 집행서는 그대로
  assert.equal(database.getSnapshot(first.id).lines.length, firstLineCount);
  assert.equal(database.getSnapshot(first.id).categorySetLabel, `v${v1.versionNo} · ${v1.title}`);

  // 원하는 설정 버전을 골라 만들 수도 있어야 합니다.
  const chosen = database.createSnapshot(projectId, { categorySetId: v1.id });
  assert.equal(chosen.categorySetId, v1.id);
  assert.equal(chosen.lines.length, firstLineCount);

  // 복제본은 원본이 쓰던 설정을 이어받습니다.
  const cloned = database.createSnapshot(projectId, { cloneSnapshotId: second.id });
  assert.equal(cloned.categorySetId, v2.id);
  database.close();
});

test("사용 중이거나 집행서가 딸린 설정 버전은 삭제할 수 없다", () => {
  const database = new AppDatabase(":memory:");
  database.upsertProjects([{ code: "P-DEL", name: "삭제 검증", contractAmount: 1_000, status: PROJECT_STATUS.ACTIVE }]);
  const current = database.assertCategorySet(database.getCurrentCategorySetId());
  assert.throws(() => database.deleteCategorySet(current.id), /사용 중인 설정 버전/);

  const spare = database.createCategorySet({ title: "예비", cloneFromId: current.id });
  database.setCurrentCategorySet(spare.id);
  database.createSnapshot(database.listProjects()[0].id, { categorySetId: current.id });
  assert.throws(() => database.deleteCategorySet(current.id), /집행서가 1건 있어/);

  const unused = database.createCategorySet({ title: "안 쓰는 버전" });
  assert.doesNotThrow(() => database.deleteCategorySet(unused.id));
  database.close();
});

test("초기화는 집행서와 프로젝트만 지우고 설정·사용자는 남긴다", () => {
  const database = new AppDatabase(":memory:");
  database.ensureBootstrapAdmin();
  database.upsertProjects([
    { code: "R-1", name: "초기화 대상", contractAmount: 1_000_000, status: PROJECT_STATUS.ACTIVE },
    { code: "R-2", name: "초기화 대상2", contractAmount: 2_000_000, status: PROJECT_STATUS.ACTIVE },
  ]);
  const projectId = database.listProjects()[0].id;
  const snapshot = database.createSnapshot(projectId);
  const item = snapshot.lines.flatMap((line) => line.items)[0];
  database.importReceipts(snapshot.id, [
    { sourceKey: "A", receiptNo: "A", itemCode: item.itemCode, itemName: item.itemName, receiptDate: "20260501", amount: 500, vatAmount: 0 },
  ]);
  database.setSnapshotStatus(snapshot.id, SNAPSHOT_STATUS.CONFIRMED);

  const counts = database.countResettableData();
  assert.equal(counts.projects, 2);
  assert.equal(counts.snapshots, 1);
  assert.equal(counts.confirmedSnapshots, 1);
  assert.equal(counts.receipts, 1);

  const categoriesBefore = database.listCategories().length;
  const setsBefore = database.listCategorySets().length;
  const removed = database.resetOperationalData();

  assert.deepEqual(removed, counts);
  assert.equal(database.listProjects().length, 0);
  assert.equal(database.countResettableData().snapshots, 0);
  assert.equal(database.countResettableData().receipts, 0);
  // 남아야 하는 것들
  assert.equal(database.listCategories().length, categoriesBefore);
  assert.equal(database.listCategorySets().length, setsBefore);
  assert.ok(database.findUserByLoginId("admin"));
  database.close();
});

test("초기화 API 는 확인 문구가 정확할 때만 실행된다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  await loginAsAdmin(server);

  const bootstrap = await server.client.request("/api/bootstrap");
  const project = bootstrap.data.projects[0];
  await server.client.request(`/api/projects/${project.id}/snapshots`, { method: "POST", body: {} });

  const preview = await server.client.request("/api/admin/reset");
  assert.equal(preview.status, 200);
  assert.equal(preview.data.confirmPhrase, RESET_CONFIRM_PHRASE);
  assert.ok(preview.data.counts.snapshots >= 1);

  for (const confirm of ["", "초기화", "모두초기화", " 지워 "]) {
    const rejected = await server.client.request("/api/admin/reset", { method: "POST", body: { confirm } });
    assert.equal(rejected.status, 400, `'${confirm}' 는 거부되어야 합니다`);
    assert.match(rejected.data.message, /정확히 입력/);
  }
  // 거부된 뒤에도 자료는 그대로여야 합니다.
  assert.ok((await server.client.request("/api/admin/reset")).data.counts.snapshots >= 1);

  const done = await server.client.request("/api/admin/reset", { method: "POST", body: { confirm: RESET_CONFIRM_PHRASE } });
  assert.equal(done.status, 200);
  assert.ok(done.data.removed.snapshots >= 1);
  assert.equal(done.data.projects.length, 0);

  const after = await server.client.request("/api/admin/reset");
  assert.equal(after.data.counts.snapshots, 0);
  assert.equal(after.data.counts.projects, 0);

  // 분류 설정은 남아 있어야 합니다.
  const categories = await server.client.request("/api/categories");
  assert.ok(categories.data.length > 0);

  const logs = await server.client.request("/api/audit-logs?limit=50");
  assert.ok(logs.data.rows.some((row) => row.action === "DATA_RESET"));
});

test("조회자는 초기화도 설정 버전 변경도 할 수 없다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  await loginAsAdmin(server);

  const created = await server.client.request("/api/users", {
    method: "POST",
    body: { loginId: "viewer9", name: "조회자", role: "VIEWER" },
  });
  const { createClient } = await import("./helpers/server.mjs");
  const viewer = createClient(server.origin);
  await viewer.request("/api/auth/login", {
    method: "POST", csrf: false,
    body: { loginId: "viewer9", password: created.data.temporaryPassword },
  });
  await viewer.request("/api/auth/password", {
    method: "POST",
    body: { currentPassword: created.data.temporaryPassword, newPassword: "Viewer!pass1234" },
  });

  assert.equal((await viewer.request("/api/admin/reset")).status, 403);
  assert.equal((await viewer.request("/api/admin/reset", { method: "POST", body: { confirm: RESET_CONFIRM_PHRASE } })).status, 403);
  assert.equal((await viewer.request("/api/category-sets", { method: "POST", body: { title: "몰래" } })).status, 403);
  // 조회는 허용됩니다.
  assert.equal((await viewer.request("/api/category-sets")).status, 200);
});
