import test from "node:test";
import assert from "node:assert/strict";

import { loginAsAdmin, startTestServer } from "./helpers/server.mjs";
import { USER_ROLE } from "../src/constants.mjs";

test("로그인하지 않으면 자료 API가 401을 돌려주고 홈은 로그인 화면으로 보낸다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  const bootstrap = await server.client.request("/api/bootstrap");
  assert.equal(bootstrap.status, 401);

  const home = await server.client.request("/");
  assert.equal(home.status, 302);
  assert.equal(home.response.headers.get("location"), "/login");

  const health = await server.client.request("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.data.status, "ok");
});

test("최초 관리자는 임시 비밀번호를 바꾸기 전까지 다른 기능을 쓸 수 없다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  const login = await server.client.request("/api/auth/login", {
    method: "POST",
    csrf: false,
    body: { loginId: server.bootstrapAdmin.loginId, password: server.bootstrapAdmin.password },
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.mustChangePassword, true);

  const blocked = await server.client.request("/api/bootstrap");
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, "PASSWORD_CHANGE_REQUIRED");

  const weak = await server.client.request("/api/auth/password", {
    method: "POST",
    body: { currentPassword: server.bootstrapAdmin.password, newPassword: "1234" },
  });
  assert.equal(weak.status, 400);
  assert.match(weak.data.message, /10자 이상/);

  const changed = await server.client.request("/api/auth/password", {
    method: "POST",
    body: { currentPassword: server.bootstrapAdmin.password, newPassword: "Admin!test1234" },
  });
  assert.equal(changed.status, 200);

  const bootstrap = await server.client.request("/api/bootstrap");
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.data.permissions.canAdminister, true);
});

test("CSRF 토큰이 없거나 다른 출처에서 온 변경 요청은 거부한다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  await loginAsAdmin(server);

  const withoutToken = await server.client.request("/api/major-categories", {
    method: "POST",
    csrf: false,
    body: { name: "토큰없음" },
  });
  assert.equal(withoutToken.status, 403);
  assert.match(withoutToken.data.message, /보안 토큰/);

  const foreignOrigin = await server.client.request("/api/major-categories", {
    method: "POST",
    headers: { Origin: "https://evil.example.com" },
    body: { name: "다른출처" },
  });
  assert.equal(foreignOrigin.status, 403);
  assert.match(foreignOrigin.data.message, /출처/);

  const allowed = await server.client.request("/api/major-categories", {
    method: "POST",
    headers: { Origin: server.origin },
    body: { name: "정상등록" },
  });
  assert.equal(allowed.status, 201);
});

test("조회자는 저장할 수 없고 관리자 화면에도 접근할 수 없다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  await loginAsAdmin(server);

  const created = await server.client.request("/api/users", {
    method: "POST",
    body: { loginId: "viewer1", name: "조회 사용자", role: USER_ROLE.VIEWER },
  });
  assert.equal(created.status, 201);

  const viewer = (await import("./helpers/server.mjs")).createClient(server.origin);
  await viewer.request("/api/auth/login", {
    method: "POST",
    csrf: false,
    body: { loginId: "viewer1", password: created.data.temporaryPassword },
  });
  await viewer.request("/api/auth/password", {
    method: "POST",
    body: { currentPassword: created.data.temporaryPassword, newPassword: "Viewer!pass1234" },
  });

  const bootstrap = await viewer.request("/api/bootstrap");
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.data.permissions.canEdit, false);
  assert.equal(bootstrap.data.permissions.canAdminister, false);

  const project = bootstrap.data.projects[0];
  const forbiddenCreate = await viewer.request(`/api/projects/${project.id}/snapshots`, { method: "POST", body: {} });
  assert.equal(forbiddenCreate.status, 403);

  const forbiddenAdmin = await viewer.request("/api/users");
  assert.equal(forbiddenAdmin.status, 403);

  const forbiddenSettings = await viewer.request("/api/major-categories", { method: "POST", body: { name: "권한없음" } });
  assert.equal(forbiddenSettings.status, 403);
});

test("데이터베이스 제약 위반은 한국어 안내로 바뀌어 나간다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  await loginAsAdmin(server);

  const first = await server.client.request("/api/major-categories", { method: "POST", body: { name: "중복분류" } });
  assert.equal(first.status, 201);

  const duplicate = await server.client.request("/api/major-categories", { method: "POST", body: { name: "중복분류" } });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.code, "DUPLICATE");
  assert.match(duplicate.data.message, /이미 같은 대분류명이 있습니다/);
  assert.doesNotMatch(duplicate.data.message, /UNIQUE|constraint/i);
});

test("확정한 버전의 계약금액은 프로젝트를 다시 동기화해도 바뀌지 않는다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  await loginAsAdmin(server);

  const bootstrap = await server.client.request("/api/bootstrap");
  const project = bootstrap.data.projects[0];
  const created = await server.client.request(`/api/projects/${project.id}/snapshots`, { method: "POST", body: {} });
  const snapshotId = created.data.id;
  assert.equal(created.data.contractAmount, project.contractAmount);

  const confirmed = await server.client.request(`/api/snapshots/${snapshotId}/status`, {
    method: "PUT",
    body: { status: "CONFIRMED" },
  });
  assert.equal(confirmed.status, 200);
  assert.ok(confirmed.data.confirmedBy);

  // 프로젝트 계약금액이 바뀐 상황을 직접 만듭니다.
  server.database.upsertProjects([{
    code: project.code,
    name: project.name,
    contractAmount: project.contractAmount + 123_000_000,
    status: project.status,
  }]);

  const reread = await server.client.request(`/api/snapshots/${snapshotId}`);
  assert.equal(reread.data.contractAmount, project.contractAmount);
  assert.equal(reread.data.contractAmountChanged, true);
  assert.equal(reread.data.totals.contractAmount, project.contractAmount);

  // 확정된 버전은 계약금액 갱신도 막습니다.
  const refresh = await server.client.request(`/api/snapshots/${snapshotId}/contract-amount/refresh`, { method: "POST" });
  assert.equal(refresh.status, 409);
});

test("다른 사용자가 먼저 저장하면 뒤늦은 저장을 409로 막는다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  await loginAsAdmin(server);

  const bootstrap = await server.client.request("/api/bootstrap");
  const project = bootstrap.data.projects[0];
  const created = await server.client.request(`/api/projects/${project.id}/snapshots`, { method: "POST", body: {} });
  const snapshot = created.data;
  const staleRevision = snapshot.revision;

  const first = await server.client.request(`/api/snapshots/${snapshot.id}/lines`, {
    method: "PUT",
    body: {
      expectedRevision: staleRevision,
      lines: [{ id: snapshot.lines[0].id, executionBudget: 1_000_000, remark: "먼저" }],
    },
  });
  assert.equal(first.status, 200);
  assert.equal(first.data.revision, staleRevision + 1);

  const second = await server.client.request(`/api/snapshots/${snapshot.id}/lines`, {
    method: "PUT",
    body: {
      expectedRevision: staleRevision,
      lines: [{ id: snapshot.lines[0].id, executionBudget: 2_000_000, remark: "나중" }],
    },
  });
  assert.equal(second.status, 409);
  assert.equal(second.data.code, "STALE");

  const current = await server.client.request(`/api/snapshots/${snapshot.id}`);
  assert.equal(current.data.lines[0].executionBudget, 1_000_000);
});

test("입고 조회 기간을 벗어나거나 뒤집히면 거부하고, 전체 삭제로 되돌릴 수 있다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  await loginAsAdmin(server);

  const bootstrap = await server.client.request("/api/bootstrap");
  const project = bootstrap.data.projects[0];
  const created = await server.client.request(`/api/projects/${project.id}/snapshots`, { method: "POST", body: {} });
  const snapshotId = created.data.id;

  const reversed = await server.client.request(`/api/snapshots/${snapshotId}/receipts/import`, {
    method: "POST",
    body: { fromDate: "2026-05-01", toDate: "2026-04-01" },
  });
  assert.equal(reversed.status, 400);
  assert.match(reversed.data.message, /시작일이 종료일보다/);

  const tooWide = await server.client.request(`/api/snapshots/${snapshotId}/receipts/import`, {
    method: "POST",
    body: { fromDate: "2000-01-01", toDate: "2026-01-01" },
  });
  assert.equal(tooWide.status, 400);
  assert.match(tooWide.data.message, /최대/);

  const imported = await server.client.request(`/api/snapshots/${snapshotId}/receipts/import`, {
    method: "POST",
    body: { fromDate: "2026-01-01", toDate: "2026-06-30" },
  });
  assert.equal(imported.status, 200);
  assert.ok(imported.data.importedCount > 0);
  assert.ok(imported.data.snapshot.totals.purchaseAmount > 0);

  const cleared = await server.client.request(`/api/snapshots/${snapshotId}/receipts`, { method: "DELETE" });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.snapshot.totals.purchaseAmount, 0);
  assert.equal(cleared.data.snapshot.receipts.length, 0);
});

test("public 폴더 밖의 파일은 정적 경로로 내려주지 않는다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  for (const path of [
    "/../config/appsettings.json",
    "/..%2fconfig%2fappsettings.json",
    "/%2e%2e/src/server.mjs",
    "/../../etc/passwd",
  ]) {
    const result = await server.client.request(path);
    assert.equal(result.status, 404, `${path} 는 404 여야 합니다`);
  }

  const styles = await server.client.request("/styles.css");
  assert.equal(styles.status, 200);
  assert.match(styles.response.headers.get("content-security-policy") || "", /frame-ancestors 'self'/);
});

test("활동 기록에 로그인과 버전 확정이 남는다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  await loginAsAdmin(server);

  const bootstrap = await server.client.request("/api/bootstrap");
  const project = bootstrap.data.projects[0];
  const created = await server.client.request(`/api/projects/${project.id}/snapshots`, { method: "POST", body: {} });
  await server.client.request(`/api/snapshots/${created.data.id}/status`, { method: "PUT", body: { status: "CONFIRMED" } });

  const logs = await server.client.request("/api/audit-logs?limit=50");
  assert.equal(logs.status, 200);
  const actions = logs.data.rows.map((row) => row.action);
  assert.ok(actions.includes("LOGIN"));
  assert.ok(actions.includes("SNAPSHOT_CREATED"));
  assert.ok(actions.includes("SNAPSHOT_CONFIRMED"));
  assert.ok(logs.data.rows.every((row) => row.loginId === "admin"));
});
