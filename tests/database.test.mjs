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

test("확정된 버전의 계약금액은 프로젝트 동기화에 영향을 받지 않는다", () => {
  const database = new AppDatabase(":memory:");
  database.upsertProjects([{ code: "TEST-FIX", name: "계약금액 고정", contractAmount: 100_000_000, status: PROJECT_STATUS.ACTIVE }]);
  const project = database.listProjects()[0];
  const snapshot = database.createSnapshot(project.id);
  database.setSnapshotStatus(snapshot.id, SNAPSHOT_STATUS.CONFIRMED, { actorName: "김담당" });

  database.upsertProjects([{ code: "TEST-FIX", name: "계약금액 고정", contractAmount: 50_000_000, status: PROJECT_STATUS.ACTIVE }]);

  const reread = database.getSnapshot(snapshot.id);
  assert.equal(reread.contractAmount, 100_000_000);
  assert.equal(reread.totals.contractAmount, 100_000_000);
  assert.equal(reread.totals.profitAmount, 100_000_000);
  assert.equal(reread.projectContractAmount, 50_000_000);
  assert.equal(reread.contractAmountChanged, true);
  assert.equal(reread.confirmedBy, "김담당");
  database.close();
});

test("작성중 버전은 계약금액을 현재 프로젝트 값으로 다시 맞출 수 있다", () => {
  const database = new AppDatabase(":memory:");
  database.upsertProjects([{ code: "TEST-REFRESH", name: "갱신", contractAmount: 10_000_000, status: PROJECT_STATUS.ACTIVE }]);
  const project = database.listProjects()[0];
  const snapshot = database.createSnapshot(project.id);
  database.upsertProjects([{ code: "TEST-REFRESH", name: "갱신", contractAmount: 30_000_000, status: PROJECT_STATUS.ACTIVE }]);

  const refreshed = database.refreshSnapshotContractAmount(snapshot.id);
  assert.equal(refreshed.contractAmount, 30_000_000);
  assert.equal(refreshed.contractAmountChanged, false);
  database.close();
});

test("먼저 저장된 내용이 있으면 오래된 기준으로 덮어쓰지 못한다", () => {
  const database = new AppDatabase(":memory:");
  database.upsertProjects([{ code: "TEST-LOCK", name: "동시편집", contractAmount: 1_000_000, status: PROJECT_STATUS.ACTIVE }]);
  const snapshot = database.createSnapshot(database.listProjects()[0].id);
  const staleRevision = snapshot.revision;

  database.updateSnapshotLines(snapshot.id, [{ id: snapshot.lines[0].id, executionBudget: 5_000, remark: "먼저" }], { expectedRevision: staleRevision });

  assert.throws(
    () => database.updateSnapshotLines(snapshot.id, [{ id: snapshot.lines[0].id, executionBudget: 9_000, remark: "나중" }], { expectedRevision: staleRevision }),
    /다른 사용자가/,
  );
  assert.equal(database.getSnapshot(snapshot.id).lines[0].executionBudget, 5_000);
  database.close();
});

test("입고 내역을 지우거나 다시 조회로 교체할 수 있다", () => {
  const database = new AppDatabase(":memory:");
  database.upsertProjects([{ code: "TEST-RECEIPT", name: "입고 정리", contractAmount: 10_000_000, status: PROJECT_STATUS.ACTIVE }]);
  const snapshot = database.createSnapshot(database.listProjects()[0].id);
  const item = snapshot.lines.flatMap((line) => line.items)[0];
  const receipt = (sourceKey, amount) => ({ sourceKey, receiptNo: sourceKey, itemCode: item.itemCode, itemName: item.itemName, receiptDate: "20260501", amount, vatAmount: 0 });

  database.importReceipts(snapshot.id, [receipt("A", 1_000_000), receipt("B", 2_000_000)]);
  assert.equal(database.getSnapshot(snapshot.id).totals.purchaseAmount, 3_000_000);

  // 기간을 좁혀 다시 불러오면 기존 내역이 남지 않아야 합니다.
  const replaced = database.importReceipts(snapshot.id, [receipt("B", 2_000_000)], { replace: true });
  assert.equal(replaced.snapshot.totals.purchaseAmount, 2_000_000);
  assert.equal(replaced.snapshot.receipts.length, 1);

  const removed = database.deleteReceipts(snapshot.id);
  assert.equal(removed.deletedCount, 1);
  assert.equal(removed.snapshot.totals.purchaseAmount, 0);
  database.close();
});

test("제외된 입고 건수와 품번을 함께 알려준다", () => {
  const database = new AppDatabase(":memory:");
  database.upsertProjects([{ code: "TEST-SKIP", name: "제외 안내", contractAmount: 1_000_000, status: PROJECT_STATUS.ACTIVE }]);
  const snapshot = database.createSnapshot(database.listProjects()[0].id);
  const result = database.importReceipts(snapshot.id, [
    { sourceKey: "X", receiptNo: "X", itemCode: "UNKNOWN-1", itemName: "미연결", receiptDate: "20260501", amount: 100, vatAmount: 0 },
    { sourceKey: "Y", receiptNo: "Y", itemCode: "UNKNOWN-2", itemName: "미연결", receiptDate: "20260501", amount: 200, vatAmount: 0 },
  ]);
  assert.equal(result.importedCount, 0);
  assert.equal(result.skippedCount, 2);
  assert.deepEqual(result.skippedItemCodes.sort(), ["UNKNOWN-1", "UNKNOWN-2"]);
  database.close();
});

test("작성중 버전만 삭제할 수 있고 이름은 바꿀 수 있다", () => {
  const database = new AppDatabase(":memory:");
  database.upsertProjects([{ code: "TEST-DEL", name: "버전 정리", contractAmount: 1_000_000, status: PROJECT_STATUS.ACTIVE }]);
  const projectId = database.listProjects()[0].id;
  const draft = database.createSnapshot(projectId);
  const renamed = database.renameSnapshot(draft.id, "1차 검토본");
  assert.equal(renamed.title, "1차 검토본");

  const confirmed = database.createSnapshot(projectId);
  database.setSnapshotStatus(confirmed.id, SNAPSHOT_STATUS.CONFIRMED);
  assert.throws(() => database.deleteSnapshot(confirmed.id), /확정된 버전은 삭제할 수 없습니다/);

  database.deleteSnapshot(draft.id);
  assert.equal(database.listSnapshots(projectId).length, 1);
  database.close();
});

test("대분류와 중분류 순서를 위아래로 바꿀 수 있다", () => {
  const database = new AppDatabase(":memory:");
  const before = database.listCategories().map((major) => major.name);
  database.moveCategory("major", database.listCategories()[1].id, "up");
  const after = database.listCategories().map((major) => major.name);
  assert.deepEqual(after.slice(0, 2), [before[1], before[0]]);

  // 맨 위에서 더 올리면 아무 일도 일어나지 않습니다.
  assert.equal(database.moveCategory("major", database.listCategories()[0].id, "up"), false);
  database.close();
});

test("한 버전 안에서 같은 품번이 두 중분류에 들어가 이중 집계되지 않는다", () => {
  const database = new AppDatabase(":memory:");
  const major = database.listCategories()[0];
  const middle = database.createMiddleCategory({ majorCategoryId: major.id, name: "중복 검증용" });
  // 품번은 전역 유일이므로, 기존 연결을 옮겨 같은 코드가 두 곳에 걸리는 상황을 흉내 냅니다.
  const existing = major.middleCategories[0].items[0];
  database.db.prepare("UPDATE item_mappings SET middle_category_id = ? WHERE item_code = ?").run(middle.id, existing.itemCode);

  database.upsertProjects([{ code: "TEST-DUP", name: "이중집계", contractAmount: 1_000_000, status: PROJECT_STATUS.ACTIVE }]);
  const snapshot = database.createSnapshot(database.listProjects()[0].id);
  const occurrences = snapshot.lines.flatMap((line) => line.items).filter((item) => item.itemCode === existing.itemCode);
  assert.equal(occurrences.length, 1);
  database.close();
});

test("최초 실행 시 관리자 계정을 만들고, 마지막 관리자는 잠글 수 없다", () => {
  const database = new AppDatabase(":memory:");
  const created = database.ensureBootstrapAdmin();
  assert.equal(created.loginId, "admin");
  assert.ok(created.password.length >= 12);
  assert.equal(database.ensureBootstrapAdmin(), null);

  const admin = database.findUserByLoginId("admin");
  assert.equal(admin.mustChangePassword, true);
  assert.throws(() => database.updateUser(admin.id, { role: "VIEWER" }), /마지막 관리자/);
  assert.throws(() => database.deleteUser(admin.id), /마지막 관리자/);

  database.createUser({ loginId: "admin2", name: "두 번째 관리자", role: "ADMIN" });
  const updated = database.updateUser(admin.id, { role: "VIEWER" });
  assert.equal(updated.role, "VIEWER");
  database.close();
});

test("동기화는 조회 결과에 없는 프로젝트를 정리하되 집행서는 지키다", () => {
  const database = new AppDatabase(":memory:");
  database.upsertProjects([
    { code: "KEEP-1", name: "계속 있는 프로젝트", contractAmount: 1_000_000, status: PROJECT_STATUS.ACTIVE },
    { code: "GONE-EMPTY", name: "집행서 없는 프로젝트", contractAmount: 2_000_000, status: PROJECT_STATUS.ACTIVE },
    { code: "GONE-USED", name: "집행서 있는 프로젝트", contractAmount: 3_000_000, status: PROJECT_STATUS.ACTIVE },
  ]);
  const used = database.listProjects().find((project) => project.code === "GONE-USED");
  const snapshot = database.createSnapshot(used.id);
  database.setSnapshotStatus(snapshot.id, SNAPSHOT_STATUS.CONFIRMED);

  const { projects, summary } = database.upsertProjects(
    [{ code: "KEEP-1", name: "계속 있는 프로젝트", contractAmount: 1_500_000, status: PROJECT_STATUS.ACTIVE }],
    { reconcile: true },
  );

  assert.equal(summary.received, 1);
  assert.equal(summary.removed, 1);   // 집행서 없는 프로젝트만 삭제
  assert.equal(summary.archived, 1);  // 집행서 있는 프로젝트는 보관
  assert.equal(projects.length, 2);
  assert.equal(projects.find((p) => p.code === "GONE-EMPTY"), undefined);

  // 확정된 집행서와 그 계약금액은 그대로 남아야 합니다.
  const kept = database.getSnapshot(snapshot.id);
  assert.equal(kept.status, SNAPSHOT_STATUS.CONFIRMED);
  assert.equal(kept.contractAmount, 3_000_000);
  assert.equal(projects.find((p) => p.code === "GONE-USED").isArchived, true);
  assert.equal(projects.find((p) => p.code === "KEEP-1").isArchived, false);
  assert.equal(projects.find((p) => p.code === "KEEP-1").contractAmount, 1_500_000);
  database.close();
});

test("0건을 받아도 집행서가 달린 프로젝트는 남고 시험 데이터만 정리된다", () => {
  const database = new AppDatabase(":memory:");
  database.upsertProjects([
    { code: "DEMO-A", name: "시험용 A", contractAmount: 1_000_000, status: PROJECT_STATUS.ACTIVE },
    { code: "DEMO-B", name: "시험용 B", contractAmount: 2_000_000, status: PROJECT_STATUS.ACTIVE },
  ]);
  const withSnapshot = database.listProjects().find((project) => project.code === "DEMO-B");
  database.createSnapshot(withSnapshot.id);

  const { projects, summary } = database.upsertProjects([], { reconcile: true });
  assert.equal(summary.received, 0);
  assert.equal(summary.removed, 1);
  assert.equal(summary.archived, 1);
  assert.deepEqual(projects.map((project) => project.code), ["DEMO-B"]);
  assert.equal(projects[0].isArchived, true);
  database.close();
});

test("보관된 프로젝트가 다시 조회되면 보관 표시가 풀린다", () => {
  const database = new AppDatabase(":memory:");
  database.upsertProjects([{ code: "P-1", name: "프로젝트", contractAmount: 1_000, status: PROJECT_STATUS.ACTIVE }]);
  database.createSnapshot(database.listProjects()[0].id);
  database.upsertProjects([], { reconcile: true });
  assert.equal(database.listProjects()[0].isArchived, true);

  const { summary } = database.upsertProjects(
    [{ code: "P-1", name: "프로젝트", contractAmount: 1_000, status: PROJECT_STATUS.ACTIVE }],
    { reconcile: true },
  );
  assert.equal(summary.restored, 1);
  assert.equal(database.listProjects()[0].isArchived, false);
  database.close();
});

test("대조를 끄면 기존 프로젝트를 건드리지 않는다", () => {
  const database = new AppDatabase(":memory:");
  database.upsertProjects([{ code: "OLD", name: "기존", contractAmount: 1_000, status: PROJECT_STATUS.ACTIVE }]);
  const { projects, summary } = database.upsertProjects([{ code: "NEW", name: "신규", contractAmount: 2_000, status: PROJECT_STATUS.ACTIVE }]);
  assert.equal(summary.removed, 0);
  assert.equal(summary.archived, 0);
  assert.equal(projects.length, 2);
  database.close();
});
