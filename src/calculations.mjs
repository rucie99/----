export function toWon(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.round(parsed);
}

export function calculateSummary(contractAmount, purchaseAmount) {
  const contract = toWon(contractAmount);
  const purchase = toWon(purchaseAmount);
  const profit = contract - purchase;
  const profitRate = contract === 0 ? 0 : Math.round((profit / contract) * 1_000_000) / 10_000;

  return {
    contractAmount: contract,
    purchaseAmount: purchase,
    profitAmount: profit,
    profitRate,
  };
}

export function calculateBudget(executionBudget, purchaseAmount) {
  const budget = toWon(executionBudget);
  const purchase = toWon(purchaseAmount);
  return {
    executionBudget: budget,
    purchaseAmount: purchase,
    balanceAmount: budget - purchase,
    executionRate: budget === 0 ? 0 : Math.round((purchase / budget) * 1_000_000) / 10_000,
  };
}

export function calculateExecutionTotals(lines = []) {
  const executionBudget = lines.reduce((sum, line) => sum + toWon(line.executionBudget), 0);
  const purchaseAmount = lines.reduce((sum, line) => sum + toWon(line.purchaseAmount), 0);
  return calculateBudget(executionBudget, purchaseAmount);
}

/**
 * 라인을 대분류 › 중분류로 묶습니다.
 *
 * 라인 하나는 '소분류' 또는 소분류가 없는 '중분류' 한 줄입니다.
 * 소분류가 2개 이상인 중분류만 중분류 소계(showSubtotal)를 둡니다. 1개면 소계가 그 줄과 같아 생략합니다.
 * 대분류 합계(totals)는 라인만 더하므로 중분류 소계가 이중으로 더해지지 않습니다.
 */
export function groupExecutionLines(lines = []) {
  const groups = [];
  const groupByMajor = new Map();

  for (const line of lines) {
    let group = groupByMajor.get(line.majorName);
    if (!group) {
      group = { majorName: line.majorName, lines: [], middles: [], middleByName: new Map() };
      groupByMajor.set(line.majorName, group);
      groups.push(group);
    }
    group.lines.push(line);
    let middle = group.middleByName.get(line.middleName);
    if (!middle) {
      middle = { middleName: line.middleName, lines: [] };
      group.middleByName.set(line.middleName, middle);
      group.middles.push(middle);
    }
    middle.lines.push(line);
  }

  return groups.map(({ middleByName, ...group }) => ({
    ...group,
    middles: group.middles.map((middle) => {
      const hasMinors = middle.lines.some((line) => Boolean(line.minorName));
      return {
        ...middle,
        hasMinors,
        showSubtotal: hasMinors && middle.lines.length >= 2,
        totals: calculateExecutionTotals(middle.lines),
      };
    }),
    totals: calculateExecutionTotals(group.lines),
  }));
}

/** 표에 그릴 행 수(라인 + 중분류 소계 + 대분류 합계). Excel 행 번호를 미리 잡는 데 씁니다. */
export function countExecutionRows(groups = []) {
  return groups.reduce((sum, group) => sum
    + group.lines.length
    + group.middles.filter((middle) => middle.showSubtotal).length
    + 1, 0);
}
