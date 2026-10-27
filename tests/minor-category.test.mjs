import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loginAsAdmin, startTestServer } from "./helpers/server.mjs";
import { AppDatabase } from "../src/database.mjs";
import { PROJECT_STATUS } from "../src/constants.mjs";
import { translateDatabaseError } from "../src/errors.mjs";

/** 데모 분류의 '자재비 › 구매품'(품번 MAT-1001, MAT-1002)을 찾습니다. */
function purchaseMiddle(database, categorySetId = null) {
  const major = database.listCategories(categorySetId).find((item) => item.name === "자재비");
  return { major, middle: major.middleCategories.find((item) => item.name === "구매품") };
}

function createProject(database, code = "P-MINOR") {
  database.upsertProjects([{ code, name: "소분류 검증", contractAmount: 10_000_000, status: PROJECT_STATUS.ACTIVE }]);
  return database.listProjects().find((project) => project.code === code).id;
}

test("첫 소분류를 만들면 중분류에 바로 붙어 있던 품번이 그 소분류로 옮겨진다", () => {
  const database = new AppDatabase(":memory:");
  const { middle } = purchaseMiddle(database);
  assert.equal(middle.items.length, 2);
  assert.deepEqual(middle.minorCategories, []);

  const first = database.createMinorCategory({ middleCategoryId: middle.id, name: "구입품비" });
  assert.equal(first.movedItemCount, 2);
  const second = database.createMinorCategory({ middleCategoryId: middle.id, name: "재고사용" });
  assert.equal(second.movedItemCount, 0);

  const after = purchaseMiddle(database).middle;
  assert.equal(after.items.length, 0, "중분류에 바로 붙은 품번은 남지 않아야 합니다");
  assert.deepEqual(after.minorCategories.map((minor) => [minor.name, minor.items.length]), [["구입품비", 2], ["재고사용", 0]]);

  // 소분류가 생긴 중분류에는 품번을 바로 붙일 수 없고, 소분류를 골라야 합니다.
  assert.throws(() => database.createItemMapping({ middleCategoryId: middle.id, itemCode: "NEW-1", itemName: "신규" }), /소분류를 골라/);
  const mapped = database.createItemMapping({ minorCategoryId: second.id, itemCode: "NEW-1", itemName: "신규" });
  assert.equal(mapped.middleCategoryId, middle.id);
  assert.equal(purchaseMiddle(database).middle.minorCategories[1].items[0].itemCode, "NEW-1");

  const mappedTo = database.listMappedItemCodes().find((row) => row.itemCode === "NEW-1");
  assert.equal(mappedTo.minorName, "재고사용");

  assert.throws(() => database.createMinorCategory({ middleCategoryId: middle.id, name: "재고사용" }), /UNIQUE constraint failed/);
  assert.match(
    translateDatabaseError(new Error("UNIQUE constraint failed: minor_categories.middle_category_id, minor_categories.name")).message,
    /같은 소분류명/,
  );
  database.close();
});

test("소분류를 지우면 그 품번도 함께 지워지고, 중분류를 지우면 소분류도 지워진다", () => {
  const database = new AppDatabase(":memory:");
  const { middle } = purchaseMiddle(database);
  const first = database.createMinorCategory({ middleCategoryId: middle.id, name: "구입품비" });
  database.createMinorCategory({ middleCategoryId: middle.id, name: "재고사용" });

  assert.equal(database.deleteMinorCategory(first.id), "구입품비");
  const after = purchaseMiddle(database).middle;
  assert.deepEqual(after.minorCategories.map((minor) => minor.name), ["재고사용"]);
  assert.equal(database.listMappedItemCodes().filter((row) => row.itemCode.startsWith("MAT-")).length, 0);

  database.deleteMiddleCategory(middle.id);
  assert.equal(Number(database.db.prepare("SELECT COUNT(*) AS count FROM minor_categories").get().count), 0);
  database.close();
});

test("집행서는 소분류마다 한 줄을 만들고, 소분류 순서를 따른다", () => {
  const database = new AppDatabase(":memory:");
  const { middle } = purchaseMiddle(database);
  const first = database.createMinorCategory({ middleCategoryId: middle.id, name: "구입품비" });
  const second = database.createMinorCategory({ middleCategoryId: middle.id, name: "재고사용" });
  database.createItemMapping({ minorCategoryId: second.id, itemCode: "STOCK-1", itemName: "재고품" });
  // 재고사용을 위로 올립니다.
  assert.equal(database.moveCategory("minor", second.id, "up"), true);

  const snapshot = database.createSnapshot(createProject(database));
  const purchaseLines = snapshot.lines.filter((line) => line.majorName === "자재비" && line.middleName === "구매품");
  assert.deepEqual(purchaseLines.map((line) => line.minorName), ["재고사용", "구입품비"]);
  assert.deepEqual(purchaseLines[1].items.map((item) => item.itemCode), ["MAT-1001", "MAT-1002"]);
  // 소분류가 없는 중분류는 예전처럼 한 줄이고 소분류명은 비어 있습니다.
  const pipe = snapshot.lines.find((line) => line.middleName === "배관자재");
  assert.equal(pipe.minorName, "");

  // 입고금액은 소분류 줄에 집계됩니다.
  database.importReceipts(snapshot.id, [
    { sourceKey: "R1", receiptNo: "R1", itemCode: "MAT-1001", itemName: "본체", receiptDate: "20260501", amount: 700, vatAmount: 70 },
    { sourceKey: "R2", receiptNo: "R2", itemCode: "STOCK-1", itemName: "재고품", receiptDate: "20260501", amount: 300, vatAmount: 30 },
  ]);
  const reloaded = database.getSnapshot(snapshot.id);
  const byMinor = Object.fromEntries(reloaded.lines.filter((line) => line.minorName).map((line) => [line.minorName, line.purchaseAmount]));
  assert.deepEqual(byMinor, { 재고사용: 300, 구입품비: 700 });
  assert.equal(reloaded.totals.purchaseAmount, 1_000);

  // 버전을 복제해도 소분류 구성과 예산이 따라옵니다.
  database.updateSnapshotLines(snapshot.id, [{ id: purchaseLines[0].id, executionBudget: 5_000, remark: "재고" }]);
  const cloned = database.createSnapshot(snapshot.projectId, { cloneSnapshotId: snapshot.id });
  const clonedLines = cloned.lines.filter((line) => line.middleName === "구매품");
  assert.deepEqual(clonedLines.map((line) => [line.minorName, line.executionBudget, line.remark]), [["재고사용", 5_000, "재고"], ["구입품비", 0, ""]]);

  // 이후 설정을 바꿔도 이미 만든 집행서는 그대로입니다.
  database.deleteMinorCategory(first.id);
  assert.equal(database.getSnapshot(snapshot.id).lines.filter((line) => line.middleName === "구매품").length, 2);
  database.close();
});

test("설정 버전을 복제하면 소분류와 소분류 품번도 새 버전의 소분류에 붙는다", () => {
  const database = new AppDatabase(":memory:");
  const source = database.getCurrentCategorySetId();
  const { middle } = purchaseMiddle(database, source);
  database.createMinorCategory({ middleCategoryId: middle.id, name: "구입품비" });
  database.createMinorCategory({ middleCategoryId: middle.id, name: "재고사용" });

  const copy = database.createCategorySet({ title: "복제본", cloneFromId: source });
  const copied = purchaseMiddle(database, copy.id).middle;
  assert.deepEqual(copied.minorCategories.map((minor) => [minor.name, minor.items.length]), [["구입품비", 2], ["재고사용", 0]]);
  const originalIds = purchaseMiddle(database, source).middle.minorCategories.map((minor) => minor.id);
  assert.ok(copied.minorCategories.every((minor) => !originalIds.includes(minor.id)), "새 버전은 자기 소분류를 가져야 합니다");
  const copiedMapping = database.db.prepare("SELECT minor_category_id AS minorId FROM item_mappings WHERE category_set_id = ? AND item_code = 'MAT-1001'").get(copy.id);
  assert.equal(copiedMapping.minorId, copied.minorCategories[0].id);

  const sets = database.listCategorySets();
  assert.equal(sets.find((set) => set.id === source).minorCount, 2);
  assert.equal(sets.find((set) => set.id === copy.id).minorCount, 2);
  database.close();
});

test("소분류 이전에 만든 DB 를 열면 컬럼이 추가되고 기존 집행서는 그대로 보인다", () => {
  const directory = mkdtempSync(join(tmpdir(), "minor-migrate-"));
  const path = join(directory, "legacy.db");
  try {
    const legacy = new AppDatabase(path);
    const snapshotId = legacy.createSnapshot(createProject(legacy, "P-LEGACY")).id;
    const lineCount = legacy.getSnapshot(snapshotId).lines.length;
    // 소분류 도입 전 스키마로 되돌립니다.
    legacy.db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE item_mappings_old (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_set_id INTEGER NOT NULL REFERENCES category_sets(id) ON DELETE CASCADE,
        middle_category_id INTEGER NOT NULL REFERENCES middle_categories(id) ON DELETE CASCADE,
        item_code TEXT NOT NULL,
        item_name TEXT NOT NULL,
        UNIQUE(category_set_id, item_code)
      );
      INSERT INTO item_mappings_old (id, category_set_id, middle_category_id, item_code, item_name)
        SELECT id, category_set_id, middle_category_id, item_code, item_name FROM item_mappings;
      DROP TABLE item_mappings;
      ALTER TABLE item_mappings_old RENAME TO item_mappings;
      DROP TABLE minor_categories;
      ALTER TABLE snapshot_lines DROP COLUMN minor_name;
      ALTER TABLE snapshot_lines DROP COLUMN minor_sort;
    `);
    legacy.close();

    const upgraded = new AppDatabase(path);
    assert.ok(upgraded.columnNames("item_mappings").has("minor_category_id"));
    assert.ok(upgraded.columnNames("snapshot_lines").has("minor_name"));
    const snapshot = upgraded.getSnapshot(snapshotId);
    assert.equal(snapshot.lines.length, lineCount);
    assert.ok(snapshot.lines.every((line) => line.minorName === ""));
    assert.equal(purchaseMiddle(upgraded).middle.items.length, 2);

    // 올라간 DB 에서도 소분류를 바로 쓸 수 있어야 합니다.
    const minor = upgraded.createMinorCategory({ middleCategoryId: purchaseMiddle(upgraded).middle.id, name: "구입품비" });
    assert.equal(minor.movedItemCount, 2);
    upgraded.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("관리자는 API 로 소분류를 만들고 소분류에 품번을 연결할 수 있다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  await loginAsAdmin(server);

  const categories = (await server.client.request("/api/categories")).data;
  const middle = categories.find((major) => major.name === "자재비").middleCategories.find((item) => item.name === "구매품");

  const created = await server.client.request("/api/minor-categories", { method: "POST", body: { middleCategoryId: middle.id, name: "구입품비" } });
  assert.equal(created.status, 201);
  assert.equal(created.data.movedItemCount, 2);
  const second = await server.client.request("/api/minor-categories", { method: "POST", body: { middleCategoryId: middle.id, name: "재고사용" } });
  assert.equal(second.status, 201);

  const duplicate = await server.client.request("/api/minor-categories", { method: "POST", body: { middleCategoryId: middle.id, name: "재고사용" } });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.data.message, /같은 소분류명/);

  const direct = await server.client.request("/api/item-mappings", { method: "POST", body: { middleCategoryId: middle.id, itemCode: "API-1", itemName: "직접" } });
  assert.equal(direct.status, 400);
  const linked = await server.client.request("/api/item-mappings", { method: "POST", body: { minorCategoryId: second.data.id, itemCode: "API-1", itemName: "소분류" } });
  assert.equal(linked.status, 201);

  const renamed = await server.client.request(`/api/minor-categories/${second.data.id}`, { method: "PUT", body: { name: "재고 사용" } });
  assert.equal(renamed.status, 204);
  const moved = await server.client.request(`/api/minor-categories/${second.data.id}/move`, { method: "POST", body: { direction: "up" } });
  assert.equal(moved.status, 200);
  const minors = moved.data.categories.find((major) => major.name === "자재비").middleCategories.find((item) => item.id === middle.id).minorCategories;
  assert.deepEqual(minors.map((minor) => minor.name), ["재고 사용", "구입품비"]);

  const removed = await server.client.request(`/api/minor-categories/${created.data.id}`, { method: "DELETE" });
  assert.equal(removed.status, 204);
});
