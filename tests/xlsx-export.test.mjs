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
  assert.match(worksheet, /자재비 소계/);
  assert.match(worksheet, /2개 품번/);
  assert.doesNotMatch(worksheet, /itemCode/);
  assert.match(worksheet, /paperSize="9" orientation="landscape" fitToWidth="1"/);
  assert.match(worksheet, /IF\(D15=0,0,E15\/D15\)/);
});
