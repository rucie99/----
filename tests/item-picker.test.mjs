import test from "node:test";
import assert from "node:assert/strict";

import { createClient, loginAsAdmin, startTestServer } from "./helpers/server.mjs";
import { AppDatabase } from "../src/database.mjs";
import { filterItems } from "../src/amarance-client.mjs";
import { PROJECT_STATUS } from "../src/constants.mjs";

function middleOf(database, majorName, middleName) {
  return database.listCategories().find((major) => major.name === majorName)
    .middleCategories.find((middle) => middle.name === middleName);
}

test("'품번 시작' 검색은 품번 앞자리로만 고르고 하이픈은 그대로 비교한다", () => {
  const items = [
    { itemCode: "ET-000002", itemName: "볼레버", specification: "" },
    { itemCode: "ET-000001", itemName: "핸들손잡이", specification: "" },
    { itemCode: "ETC-01", itemName: "기타", specification: "" },
    { itemCode: "BE-000001", itemName: "ET- 표기 품명", specification: "" },
  ];
  assert.deepEqual(filterItems(items, "et-", { prefix: true }).map((item) => item.itemCode), ["ET-000001", "ET-000002"]);
  assert.deepEqual(filterItems(items, "ET", { prefix: true }).map((item) => item.itemCode), ["ET-000001", "ET-000002", "ETC-01"]);
  // 포함 검색은 품명까지 봅니다.
  assert.ok(filterItems(items, "et-").some((item) => item.itemCode === "BE-000001"));
});

test("여러 품번을 한 번에 연결하고, 다른 곳에 연결된 품번은 옮기기를 켤 때만 옮긴다", () => {
  const database = new AppDatabase(":memory:");
  const pipe = middleOf(database, "자재비", "배관자재");
  const elec = middleOf(database, "자재비", "전기자재");
  const items = [
    { itemCode: "NEW-1", itemName: "신규1" },
    { itemCode: "NEW-2", itemName: "신규2" },
    { itemCode: "PIPE-2001", itemName: "스테인리스 배관" },
    { itemCode: "ELEC-3001", itemName: "전력 케이블" },
  ];

  const first = database.createItemMappings({ middleCategoryId: pipe.id, items });
  assert.deepEqual(first, { linked: 2, moved: 0, unchanged: 1, skipped: 1, skippedCodes: ["ELEC-3001"] });

  const moved = database.createItemMappings({ middleCategoryId: pipe.id, items, move: true });
  assert.equal(moved.moved, 1);
  assert.equal(moved.unchanged, 3);
  assert.deepEqual(middleOf(database, "자재비", "전기자재").items, []);
  assert.deepEqual(middleOf(database, "자재비", "배관자재").items.map((item) => item.itemCode).sort(), ["ELEC-3001", "NEW-1", "NEW-2", "PIPE-2001"]);
  assert.ok(elec);

  assert.throws(() => database.createItemMappings({ middleCategoryId: pipe.id, items: [] }), /연결할 품번을 골라/);
  database.close();
});

test("입고됐지만 연결 안 된 품번은 같은 입고가 여러 버전에 있어도 한 번만 센다", () => {
  const database = new AppDatabase(":memory:");
  database.upsertProjects([{ code: "P-RECV", name: "미연결 집계", contractAmount: 1_000, status: PROJECT_STATUS.ACTIVE }]);
  const projectId = database.listProjects()[0].id;
  const receipts = [
    { sourceKey: "R1:1", receiptNo: "R1", itemCode: "LOOSE-1", itemName: "미연결 부품", receiptDate: "20261001", amount: 300, vatAmount: 30 },
    { sourceKey: "R2:1", receiptNo: "R2", itemCode: "LOOSE-1", itemName: "미연결 부품", receiptDate: "20261003", amount: 200, vatAmount: 20 },
    { sourceKey: "R3:1", receiptNo: "R3", itemCode: "MAT-1001", itemName: "제어반 본체", receiptDate: "20261003", amount: 900, vatAmount: 90 },
  ];
  database.importReceipts(database.createSnapshot(projectId).id, receipts);
  database.importReceipts(database.createSnapshot(projectId).id, receipts);

  const loose = database.listReceivedUnmappedItems().map((row) => ({ ...row }));
  assert.deepEqual(loose, [{
    itemCode: "LOOSE-1", itemName: "미연결 부품", specification: "",
    receiptCount: 2, receiptAmount: 500, lastReceiptDate: "20261003",
  }]);

  database.createItemMappings({ middleCategoryId: middleOf(database, "자재비", "배관자재").id, items: [{ itemCode: "LOOSE-1", itemName: "미연결 부품" }] });
  assert.deepEqual(database.listReceivedUnmappedItems(), []);
  database.close();
});

test("API: 품번 검색 창의 접두어 · 미연결 범위 검색과 일괄 연결", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  await loginAsAdmin(server);
  const categories = (await server.client.request("/api/categories")).data;
  const pipe = categories.find((major) => major.name === "자재비").middleCategories.find((middle) => middle.name === "배관자재");

  const prefix = await server.client.request("/api/amarance/items/search", { method: "POST", body: { query: "MAT-", mode: "prefix", limit: 2000 } });
  assert.equal(prefix.status, 200);
  assert.deepEqual(prefix.data.items.map((item) => item.itemCode), ["MAT-1001", "MAT-1002"]);
  assert.ok(prefix.data.items.every((item) => item.mappedTo && item.mappedMiddleId));

  const bulk = await server.client.request("/api/item-mappings/bulk", {
    method: "POST",
    body: { middleCategoryId: pipe.id, items: prefix.data.items.map(({ itemCode, itemName }) => ({ itemCode, itemName })), move: true },
  });
  assert.equal(bulk.status, 200);
  assert.equal(bulk.data.moved, 2);

  const received = await server.client.request("/api/amarance/items/search", { method: "POST", body: { query: "", scope: "received" } });
  assert.equal(received.status, 200);
  assert.equal(received.data.total, 0);
});

test("API: 작성자는 미분류 품번을 이 버전에만 연결하고, 분류 설정은 바꾸지 못한다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  await loginAsAdmin(server);
  const created = await server.client.request("/api/users", { method: "POST", body: { loginId: "writer", name: "작성자", role: "EDITOR" } });
  const writerPassword = created.data.temporaryPassword;
  assert.ok(writerPassword, "임시 비밀번호가 와야 합니다");

  const bootstrap = await server.client.request("/api/bootstrap");
  const snapshot = (await server.client.request(`/api/projects/${bootstrap.data.projects[0].id}/snapshots`, { method: "POST", body: {} })).data;
  server.database.importReceipts(snapshot.id, [
    { sourceKey: "U1", receiptNo: "U1", itemCode: "LOOSE-9", itemName: "미연결", receiptDate: "20261001", amount: 700, vatAmount: 70 },
  ]);
  const line = snapshot.lines.find((item) => item.middleName === "배관자재");

  const writer = createClient(server.origin);
  await writer.request("/api/auth/login", { method: "POST", csrf: false, body: { loginId: "writer", password: writerPassword } });
  await writer.request("/api/auth/password", { method: "POST", body: { currentPassword: writerPassword, newPassword: "Writer!pass2026" } });

  const linked = await writer.request(`/api/snapshots/${snapshot.id}/items`, {
    method: "POST",
    body: { lineId: line.id, itemCode: "LOOSE-9", itemName: "미연결", alsoSettings: true },
  });
  assert.equal(linked.status, 200);
  assert.equal(linked.data.settings, "skipped", "작성자는 분류 설정에 연결하지 않습니다");
  assert.equal(linked.data.snapshot.unmapped.count, 0);
  assert.ok(!server.database.listMappedItemCodes().some((row) => row.itemCode === "LOOSE-9"));
});
