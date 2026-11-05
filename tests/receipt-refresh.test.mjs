import test from "node:test";
import assert from "node:assert/strict";

import { loginAsAdmin, startTestServer } from "./helpers/server.mjs";
import { AppDatabase } from "../src/database.mjs";
import { splitDateRange } from "../src/amarance-client.mjs";
import { PROJECT_STATUS } from "../src/constants.mjs";

function receipt(key, amount, itemCode = "MAT-1001") {
  return { sourceKey: key, receiptNo: key, itemCode, itemName: itemCode, receiptDate: "20261001", amount, vatAmount: 0 };
}

function newSnapshot(database) {
  database.upsertProjects([{ code: "P-REF", name: "새로 고침", contractAmount: 1_000_000, status: PROJECT_STATUS.ACTIVE }]);
  return database.createSnapshot(database.listProjects()[0].id);
}

test("긴 기간은 조회 한도 이하로 나눠 빈틈 · 겹침 없이 이어 붙인다", () => {
  assert.deepEqual(splitDateRange("20250101", "20260131", 366), [
    { from: "20250101", to: "20260101" },
    { from: "20260102", to: "20260131" },
  ]);
  assert.deepEqual(splitDateRange("20261001", "20261001", 7), [{ from: "20261001", to: "20261001" }]);
  assert.equal(splitDateRange("20260101", "20261231", 7).length, 53);
});

test("불러온 기간과 시각을 기록하고, 추가로 불러오면 기간을 넓힌다", () => {
  const database = new AppDatabase(":memory:");
  const snapshot = newSnapshot(database);
  assert.deepEqual(database.getSnapshot(snapshot.id).receiptSource, { from: null, to: null, fetchedAt: null, excludedCount: 0 });

  database.importReceipts(snapshot.id, [receipt("A", 100)], { range: { from: "20260301", to: "20260331" } });
  database.importReceipts(snapshot.id, [receipt("B", 200)], { range: { from: "20260101", to: "20260215" } });
  const source = database.getSnapshot(snapshot.id).receiptSource;
  assert.equal(source.from, "20260101");
  assert.equal(source.to, "20260331");
  assert.ok(source.fetchedAt);

  // 지우고 다시 조회하면 그 기간으로 바뀝니다.
  database.importReceipts(snapshot.id, [receipt("C", 300)], { replace: true, range: { from: "20260201", to: "20260228" } });
  assert.deepEqual(database.getReceiptRange(snapshot.id).from, "20260201");

  // 전체 삭제하면 처음 상태로 돌아갑니다.
  database.deleteReceipts(snapshot.id);
  assert.equal(database.getReceiptRange(snapshot.id), null);
  database.close();
});

test("새로 고침은 새 입고 · 금액 변경 · 사라진 입고를 세고, 직접 뺀 입고는 다시 넣지 않는다", () => {
  const database = new AppDatabase(":memory:");
  const snapshot = newSnapshot(database);
  const range = { from: "20261001", to: "20261031" };
  database.importReceipts(snapshot.id, [receipt("A", 100), receipt("B", 200), receipt("C", 300)], { range });

  // 사용자가 C 를 직접 뺍니다.
  const c = database.getSnapshot(snapshot.id).receipts.find((row) => row.sourceKey === "C");
  database.deleteReceipt(snapshot.id, c.id);

  // 아마란스10 에서는 A 금액이 바뀌고, B 가 취소되고, D 가 새로 생겼습니다(C 는 그대로).
  const refreshed = database.importReceipts(snapshot.id, [receipt("A", 150), receipt("C", 300), receipt("D", 400), receipt("D", 400)], {
    replace: true, keepExclusions: true, range,
  });
  assert.equal(refreshed.addedCount, 1);
  assert.equal(refreshed.changedCount, 1);
  assert.equal(refreshed.removedCount, 1);
  assert.equal(refreshed.excludedCount, 1);
  const keys = refreshed.snapshot.receipts.map((row) => row.sourceKey).sort();
  assert.deepEqual(keys, ["A", "D"]);
  assert.equal(refreshed.snapshot.receiptSource.excludedCount, 1);
  database.close();
});

test("API: 새로 고침은 불러온 적이 있는 작성중 버전에서만 되고, 기간이 길면 나눠 조회한다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  await loginAsAdmin(server);
  const bootstrap = await server.client.request("/api/bootstrap");
  const snapshot = (await server.client.request(`/api/projects/${bootstrap.data.projects[0].id}/snapshots`, { method: "POST", body: {} })).data;

  const before = await server.client.request(`/api/snapshots/${snapshot.id}/receipts/refresh`, { method: "POST", body: {} });
  assert.equal(before.status, 400);
  assert.match(before.data.message, /불러온 적이 없습니다/);

  const imported = await server.client.request(`/api/snapshots/${snapshot.id}/receipts/import`, {
    method: "POST", body: { fromDate: "2026-01-01", toDate: "2026-10-31" },
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.data.snapshot.receiptSource.from, "20260101");

  // 조회 한도를 30일로 줄여도, 새로 고침은 10개월을 나눠서 조회합니다.
  server.database.saveSecuritySettings({ ...server.database.getSecuritySettings(), receiptMaxRangeDays: 30 });
  let calls = 0;
  const original = server.app.amarance.fetchReceipts.bind(server.app.amarance);
  server.app.amarance.fetchReceipts = async (args) => { calls += 1; return original(args); };
  const refreshed = await server.client.request(`/api/snapshots/${snapshot.id}/receipts/refresh`, { method: "POST", body: {} });
  assert.equal(refreshed.status, 200);
  assert.ok(calls >= 10, `나눠서 조회해야 합니다 (호출 ${calls}번)`);
  assert.equal(refreshed.data.addedCount, 0);
  assert.equal(refreshed.data.snapshot.receipts.length, imported.data.snapshot.receipts.length);
});
