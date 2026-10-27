import test from "node:test";
import assert from "node:assert/strict";

import { createSnapshotWorkbook } from "../src/xlsx-export.mjs";

function readStoredZipEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const dataLength = buffer.readUInt32LE(offset + 18);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const filename = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    entries.set(filename, buffer.subarray(dataStart, dataStart + dataLength).toString("utf8"));
    offset = dataStart + dataLength;
  }
  return entries;
}

const snapshot = {
  projectCode: "P-2026-001",
  projectName: "테스트 프로젝트",
  versionNo: 3,
  status: "DRAFT",
  updatedAt: "2026-08-06T09:00:00.000Z",
  lines: [
    { id: 1, majorName: "자재비", middleName: "구매품", executionBudget: 10_000_000, purchaseAmount: 6_000_000, balanceAmount: 4_000_000, executionRate: 60, remark: "", items: [{ itemCode: "A", itemName: "A" }, { itemCode: "B", itemName: "B" }] },
    { id: 2, majorName: "자재비", middleName: "배관자재", executionBudget: 5_000_000, purchaseAmount: 3_000_000, balanceAmount: 2_000_000, executionRate: 60, remark: "확인", items: [{ itemCode: "C", itemName: "C" }] },
    { id: 3, majorName: "제작비", middleName: "가공비", executionBudget: 8_000_000, purchaseAmount: 2_000_000, balanceAmount: 6_000_000, executionRate: 25, remark: "", items: [] },
  ],
  totals: {
    contractAmount: 40_000_000,
    executionBudget: 23_000_000,
    purchaseAmount: 11_000_000,
    budgetBalance: 12_000_000,
    profitAmount: 29_000_000,
    profitRate: 72.5,
  },
};

test("A4 가로 보고서 형식의 Excel 파일을 생성한다", () => {
  const workbook = createSnapshotWorkbook(snapshot, { generatedAt: "2026-08-06T10:00:00.000Z" });
  assert.equal(workbook.subarray(0, 2).toString("ascii"), "PK");

  const entries = readStoredZipEntries(workbook);
  assert.ok(entries.has("[Content_Types].xml"));
  assert.ok(entries.has("xl/worksheets/sheet1.xml"));
  assert.ok(entries.has("xl/styles.xml"));

  const worksheet = entries.get("xl/worksheets/sheet1.xml");
  assert.match(worksheet, /mergeCell ref="A10:A11"/);
  // 소분류가 없는 중분류는 중분류 · 소분류 칸을 합칩니다.
  assert.match(worksheet, /mergeCell ref="B10:C10"/);
  assert.match(worksheet, /자재비 합계/);
  assert.doesNotMatch(worksheet, /자재비 소계/);
  assert.match(worksheet, /2개 품번/);
  assert.doesNotMatch(worksheet, /itemCode/);
  assert.match(worksheet, /paperSize="9" orientation="landscape" fitToWidth="1"/);
  assert.match(worksheet, /IF\(E15=0,0,F15\/E15\)/);
});

test("소분류가 2개 이상인 중분류는 소계 행을 두고, 대분류 합계는 이를 다시 더하지 않는다", () => {
  const line = (id, majorName, middleName, minorName, executionBudget, purchaseAmount) => ({
    id, majorName, middleName, minorName, executionBudget, purchaseAmount,
    balanceAmount: executionBudget - purchaseAmount,
    executionRate: executionBudget ? (purchaseAmount / executionBudget) * 100 : 0,
    remark: "", items: [],
  });
  const workbook = createSnapshotWorkbook({
    ...snapshot,
    lines: [
      line(1, "구매품비", "구입품비", "구입품비", 1_000, 600),
      line(2, "구매품비", "구입품비", "재고사용", 500, 100),
      line(3, "구매품비", "특이아이템", "", 200, 0),
      line(4, "제작비", "측정비", "측정비(외주,내작)", 300, 0),
    ],
    totals: { ...snapshot.totals, executionBudget: 2_000, purchaseAmount: 700, budgetBalance: 1_300 },
  }, { generatedAt: "2026-08-06T10:00:00.000Z" });
  const worksheet = readStoredZipEntries(workbook).get("xl/worksheets/sheet1.xml");

  // 10·11 소분류 → 12 소계 → 13 특이아이템 → 14 구매품비 합계 → 15 측정비 → 16 제작비 합계 → 17 전체 합계
  assert.match(worksheet, /<c r="C12"[^>]*><is><t xml:space="preserve">소 계<\/t>/);
  assert.match(worksheet, /<c r="E12"[^>]*><f>SUM\(E10:E11\)<\/f><v>1500<\/v>/);
  assert.match(worksheet, /mergeCell ref="B10:B12"/);
  assert.match(worksheet, /mergeCell ref="A10:A13"/);
  // 대분류 합계는 라인 행만 더해 소계(12행)를 다시 더하지 않습니다.
  assert.match(worksheet, /<c r="E14"[^>]*><f>SUM\(E10:E11,E13\)<\/f><v>1700<\/v>/);
  assert.match(worksheet, /구매품비 합계 · 중분류 2개/);
  // 소분류가 하나뿐이면 소계 행 없이 바로 대분류 합계로 갑니다.
  assert.match(worksheet, /<c r="C15"[^>]*><is><t xml:space="preserve">측정비\(외주,내작\)<\/t>/);
  assert.match(worksheet, /<c r="E16"[^>]*><f>SUM\(E15\)<\/f>/);
  assert.match(worksheet, /<c r="E17"[^>]*><f>E14\+E16<\/f><v>2000<\/v>/);
  assert.match(worksheet, /<dimension ref="A1:I22"\/>/);
});
