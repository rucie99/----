import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateBudget,
  calculateExecutionTotals,
  calculateSummary,
  countExecutionRows,
  groupExecutionLines,
} from "../src/calculations.mjs";

test("계약금액과 매입금액으로 예상 이익률을 계산한다", () => {
  const summary = calculateSummary(100_000_000, 72_000_000);
  assert.equal(summary.profitAmount, 28_000_000);
  assert.equal(summary.profitRate, 28);
});

test("실행예산이 없으면 집행률은 0으로 계산한다", () => {
  const budget = calculateBudget(0, 3_000_000);
  assert.equal(budget.balanceAmount, -3_000_000);
  assert.equal(budget.executionRate, 0);
});

test("대분류별 중분류 소계와 집행률을 계산한다", () => {
  const groups = groupExecutionLines([
    { majorName: "자재비", executionBudget: 10_000_000, purchaseAmount: 6_000_000 },
    { majorName: "자재비", executionBudget: 5_000_000, purchaseAmount: 3_000_000 },
    { majorName: "제작비", executionBudget: 8_000_000, purchaseAmount: 2_000_000 },
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].totals, {
    executionBudget: 15_000_000,
    purchaseAmount: 9_000_000,
    balanceAmount: 6_000_000,
    executionRate: 60,
  });
  assert.equal(groups[1].totals.executionRate, 25);
});

test("전체 중분류 합계의 집행률을 계산한다", () => {
  const totals = calculateExecutionTotals([
    { executionBudget: 20_000_000, purchaseAmount: 8_000_000 },
    { executionBudget: 10_000_000, purchaseAmount: 7_000_000 },
  ]);

  assert.equal(totals.executionBudget, 30_000_000);
  assert.equal(totals.purchaseAmount, 15_000_000);
  assert.equal(totals.executionRate, 50);
});

test("소분류가 2개 이상인 중분류만 중분류 소계를 둔다", () => {
  const groups = groupExecutionLines([
    { majorName: "구매품비", middleName: "구입품비", minorName: "구입품비", executionBudget: 1_000, purchaseAmount: 600 },
    { majorName: "구매품비", middleName: "구입품비", minorName: "재고사용", executionBudget: 500, purchaseAmount: 100 },
    { majorName: "구매품비", middleName: "특이아이템", minorName: "", executionBudget: 200, purchaseAmount: 0 },
    { majorName: "제작비", middleName: "측정비", minorName: "측정비(외주,내작)", executionBudget: 300, purchaseAmount: 0 },
  ]);

  const [purchase, production] = groups;
  assert.deepEqual(purchase.middles.map((middle) => [middle.middleName, middle.hasMinors, middle.showSubtotal]), [
    ["구입품비", true, true],
    ["특이아이템", false, false],
  ]);
  assert.equal(purchase.middles[0].totals.executionBudget, 1_500);
  assert.equal(purchase.middles[0].totals.purchaseAmount, 700);
  // 대분류 합계는 라인만 더하므로 중분류 소계가 이중으로 들어가지 않습니다.
  assert.equal(purchase.totals.executionBudget, 1_700);
  assert.deepEqual(production.middles.map((middle) => [middle.hasMinors, middle.showSubtotal]), [[true, false]]);
  // 라인 4 + 중분류 소계 1 + 대분류 합계 2
  assert.equal(countExecutionRows(groups), 7);
});
