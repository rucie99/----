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

export function groupExecutionLines(lines = []) {
  const groups = [];
  const groupByMajor = new Map();

  for (const line of lines) {
    let group = groupByMajor.get(line.majorName);
    if (!group) {
      group = { majorName: line.majorName, lines: [] };
      groupByMajor.set(line.majorName, group);
      groups.push(group);
    }
    group.lines.push(line);
  }

  return groups.map((group) => ({
    ...group,
    totals: calculateExecutionTotals(group.lines),
  }));
}
