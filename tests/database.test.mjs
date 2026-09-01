import test from "node:test";
import assert from "node:assert/strict";

import { AppDatabase } from "../src/database.mjs";
import { PROJECT_STATUS, SNAPSHOT_STATUS } from "../src/constants.mjs";

test("현재 설정을 스냅샷으로 저장하고 과거 버전을 유지한다", () => {
  const database = new AppDatabase(":memory:");
  database.upsertProjects([{ code: "TEST-001", name: "테스트 프로젝트", contractAmount: 100_000_000, status: PROJECT_STATUS.ACTIVE }]);
  const project = database.listProjects()[0];
  const first = database.createSnapshot(project.id);
  const firstLineCount = first.lines.length;

  database.createMiddleCategory({ majorCategoryId: database.listCategories()[0].id, name: "추가 중분류", sortOrder: 99 });
  const second = database.createSnapshot(project.id);

  assert.equal(database.getSnapshot(first.id).lines.length, firstLineCount);
  assert.equal(second.lines.length, firstLineCount + 1);
  assert.equal(second.versionNo, 2);
  database.close();
});

test("확정된 스냅샷은 수정할 수 없다", () => {
  const database = new AppDatabase(":memory:");
  database.upsertProjects([{ code: "TEST-002", name: "확정 테스트", contractAmount: 50_000_000, status: PROJECT_STATUS.ACTIVE }]);
  const snapshot = database.createSnapshot(database.listProjects()[0].id);
  database.setSnapshotStatus(snapshot.id, SNAPSHOT_STATUS.CONFIRMED);

  assert.throws(
    () => database.updateSnapshotLine(snapshot.id, snapshot.lines[0].id, { executionBudget: 1, remark: "수정" }),
    /확정된 버전/,
  );
  database.close();
});

test("여러 중분류의 실행예산과 비고를 한 번에 저장한다", () => {
  const database = new AppDatabase(":memory:");
  database.upsertProjects([{ code: "TEST-BULK", name: "일괄 저장", contractAmount: 80_000_000, status: PROJECT_STATUS.ACTIVE }]);
  const snapshot = database.createSnapshot(database.listProjects()[0].id);
  const saved = database.updateSnapshotLines(snapshot.id, [
    { id: snapshot.lines[0].id, executionBudget: 12_345_000, remark: "첫 번째" },
    { id: snapshot.lines[1].id, executionBudget: 6_789_000, remark: "두 번째" },
  ]);

  assert.equal(saved.lines[0].executionBudget, 12_345_000);
  assert.equal(saved.lines[0].remark, "첫 번째");
  assert.equal(saved.lines[1].executionBudget, 6_789_000);
  assert.equal(saved.lines[1].remark, "두 번째");
  assert.equal(saved.totals.executionBudget, 19_134_000);
  database.close();
});

test("스냅샷 품번과 일치하는 입고금액만 집계한다", () => {
  const database = new AppDatabase(":memory:");
  database.upsertProjects([{ code: "TEST-003", name: "입고 테스트", contractAmount: 10_000_000, status: PROJECT_STATUS.ACTIVE }]);
  const snapshot = database.createSnapshot(database.listProjects()[0].id);
  const mappedItem = snapshot.lines.flatMap((line) => line.items)[0];
  const result = database.importReceipts(snapshot.id, [
    { sourceKey: "A", receiptNo: "RV-A", itemCode: mappedItem.itemCode, itemName: mappedItem.itemName, receiptDate: "20260806", amount: 2_000_000, vatAmount: 200_000 },
    { sourceKey: "B", receiptNo: "RV-B", itemCode: "NOT-MAPPED", itemName: "미연결", receiptDate: "20260806", amount: 9_000_000, vatAmount: 900_000 },
  ]);

  assert.equal(result.importedCount, 1);
  assert.equal(result.snapshot.totals.purchaseAmount, 2_000_000);
  assert.equal(result.snapshot.totals.profitAmount, 8_000_000);
  database.close();
});

test("아마란스10 서버 인증값을 저장하고 다시 읽는다", () => {
  const database = new AppDatabase(":memory:");
  const saved = database.initializeAmaranceSettings({
    mode: "LIVE",
    baseUrl: "https://example.amaranth10.com/",
    companyCode: "1000",
    callerName: "CALLER_TEST",
    accessToken: "ACCESS_TEST",
    hashKey: "HASH_TEST",
    groupSeq: "GROUP_TEST",
    receiptDetailPath: "/apiproxy/detail",
  });

  assert.equal(saved.baseUrl, "https://example.amaranth10.com");
  assert.equal(saved.callerName, "CALLER_TEST");
  assert.equal(saved.accessToken, "ACCESS_TEST");
  assert.equal(saved.hashKey, "HASH_TEST");
  assert.equal(saved.groupSeq, "GROUP_TEST");
  database.close();
});
