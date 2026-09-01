const API_ENDPOINTS = Object.freeze({
  BOOTSTRAP: "/api/bootstrap",
  CATEGORIES: "/api/categories",
  MAJOR_CATEGORIES: "/api/major-categories",
  MIDDLE_CATEGORIES: "/api/middle-categories",
  ITEM_MAPPINGS: "/api/item-mappings",
  ITEM_SEARCH: "/api/amarance/items/search",
  AMARANCE_SETTINGS: "/api/amarance/settings",
  AMARANCE_SETTINGS_TEST: "/api/amarance/settings/test",
  PROJECT_SYNC: "/api/projects/sync",
});

const SNAPSHOT_STATUS = Object.freeze({ DRAFT: "DRAFT", CONFIRMED: "CONFIRMED" });
const SCREEN = Object.freeze({ STATEMENT: "statement", SETTINGS: "settings", AMARANCE: "amarance" });
const REPORT_STATUS_LABEL = Object.freeze({ DRAFT: "작성중", CONFIRMED: "확정" });

const state = {
  projects: [],
  categories: [],
  snapshots: [],
  snapshot: null,
  selectedProjectId: null,
  selectedMajorId: null,
  selectedMiddleId: null,
  amaranceSettings: null,
};

const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatWon(value) {
  return `${Math.round(Number(value) || 0).toLocaleString("ko-KR")}원`;
}

function parseBudgetInput(value) {
  const digits = String(value ?? "").replace(/[^0-9]/g, "");
  return digits ? Number(digits) : 0;
}

function formatBudgetInput(input) {
  input.value = parseBudgetInput(input.value).toLocaleString("ko-KR");
}

function formatPercent(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function formatDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function calculateLineTotals(lines) {
  const executionBudget = lines.reduce((sum, line) => sum + (Number(line.executionBudget) || 0), 0);
  const purchaseAmount = lines.reduce((sum, line) => sum + (Number(line.purchaseAmount) || 0), 0);
  return {
    executionBudget,
    purchaseAmount,
    balanceAmount: executionBudget - purchaseAmount,
    executionRate: executionBudget === 0 ? 0 : (purchaseAmount / executionBudget) * 100,
  };
}

function groupStatementLines(lines) {
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
  return groups.map((group) => ({ ...group, totals: calculateLineTotals(group.lines) }));
}

function itemCountText(items = []) {
  return items.length === 0 ? "미설정" : `${items.length.toLocaleString("ko-KR")}개 품번`;
}

function progressMarkup(rate, className = "") {
  const progress = Math.max(0, Math.min(100, Number(rate) || 0));
  return `<div class="progress ${Number(rate) > 100 ? "over" : ""} ${className}"><div class="progress-track"><div class="progress-bar" style="width:${progress}%"></div></div><span>${formatPercent(rate)}</span></div>`;
}

function snapshotExportEndpoint(snapshotId) {
  return `/api/snapshots/${snapshotId}/export.xlsx`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "요청 처리에 실패했습니다.");
  return data;
}

async function busy(action) {
  elements.loading.classList.remove("hidden");
  try {
    return await action();
  } catch (error) {
    showToast(error.message || "처리 중 오류가 발생했습니다.", true);
    throw error;
  } finally {
    elements.loading.classList.add("hidden");
  }
}

let toastTimer;
function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast show${isError ? " error" : ""}`;
  toastTimer = setTimeout(() => { elements.toast.className = "toast"; }, 2600);
}

function askText({ title, label, initial = "" }) {
  return new Promise((resolve) => {
    elements.textDialogTitle.textContent = title;
    elements.textDialogLabel.textContent = label;
    elements.textDialogInput.value = initial;
    const handleClose = () => {
      elements.textDialog.removeEventListener("close", handleClose);
      resolve(elements.textDialog.returnValue === "confirm" ? elements.textDialogInput.value.trim() : null);
    };
    elements.textDialog.addEventListener("close", handleClose);
    elements.textDialog.showModal();
    setTimeout(() => elements.textDialogInput.focus(), 0);
  });
}

elements.textDialogForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!elements.textDialogInput.value.trim()) return;
  elements.textDialog.close("confirm");
});

function setScreen(screen) {
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.screen === screen));
  elements.statementScreen.classList.toggle("active", screen === SCREEN.STATEMENT);
  elements.settingsScreen.classList.toggle("active", screen === SCREEN.SETTINGS);
  elements.amaranceSettingsScreen.classList.toggle("active", screen === SCREEN.AMARANCE);
  elements.pageTitle.textContent = screen === SCREEN.STATEMENT
    ? "기성집행서"
    : screen === SCREEN.SETTINGS ? "분류 · 품번 설정" : "아마란스10 설정";
}

function renderAmaranceSettings() {
  const settings = state.amaranceSettings;
  if (!settings) return;
  elements.amaranceMode.value = settings.mode;
  elements.amaranceBaseUrl.value = settings.baseUrl || "";
  elements.amaranceCompanyCode.value = settings.companyCode || "";
  elements.amaranceCallerName.value = settings.callerName || "";
  elements.amaranceGroupSeq.value = settings.groupSeq || "";
  elements.amaranceAccessToken.value = "";
  elements.amaranceHashKey.value = "";
  elements.clearAccessToken.checked = false;
  elements.clearHashKey.checked = false;
  elements.accessTokenStatus.textContent = settings.accessTokenConfigured ? "저장됨" : "미저장";
  elements.hashKeyStatus.textContent = settings.hashKeyConfigured ? "저장됨" : "미저장";
  elements.accessTokenStatus.classList.toggle("ready", settings.accessTokenConfigured);
  elements.hashKeyStatus.classList.toggle("ready", settings.hashKeyConfigured);
  const authenticationReady = Boolean(settings.callerName && settings.groupSeq && settings.accessTokenConfigured && settings.hashKeyConfigured);
  elements.integrationSummary.innerHTML = `
    <span class="${settings.mode === "LIVE" ? "ready" : "pending"}">${settings.mode}</span>
    <span class="${authenticationReady ? "ready" : "pending"}">서버 인증 ${authenticationReady ? "준비" : "미완료"}</span>
    <span class="ready">입고 조회 준비</span>
  `;
  elements.connectionMode.textContent = settings.mode;
}

function renderProjects() {
  elements.projectSelect.innerHTML = state.projects.map((project) => `
    <option value="${project.id}">${escapeHtml(project.code)} · ${escapeHtml(project.name)}</option>
  `).join("");
  if (!state.selectedProjectId && state.projects.length) state.selectedProjectId = state.projects[0].id;
  elements.projectSelect.value = String(state.selectedProjectId || "");
  const project = state.projects.find((item) => item.id === Number(state.selectedProjectId));
  elements.projectMeta.innerHTML = project ? `
    <strong>${formatWon(project.contractAmount)}</strong>
    <span>${project.status === "ACTIVE" ? "진행 프로젝트" : "완료 프로젝트"}</span>
  ` : "";
}

async function loadSnapshots(preferredSnapshotId = null) {
  if (!state.selectedProjectId) return;
  state.snapshots = await api(`/api/projects/${state.selectedProjectId}/snapshots`);
  const selectedId = preferredSnapshotId || state.snapshots[0]?.id;
  if (!selectedId) {
    state.snapshot = null;
    renderSnapshot();
    return;
  }
  state.snapshot = await api(`/api/snapshots/${selectedId}`);
  renderSnapshot();
}

function renderSnapshot() {
  const hasSnapshot = Boolean(state.snapshot);
  elements.emptySnapshot.classList.toggle("hidden", hasSnapshot);
  elements.snapshotContent.classList.toggle("hidden", !hasSnapshot);
  elements.cloneSnapshotButton.disabled = !hasSnapshot;
  if (!hasSnapshot) return;

  const snapshot = state.snapshot;
  elements.snapshotSelect.innerHTML = state.snapshots.map((item) => `
    <option value="${item.id}">v${item.versionNo} · ${escapeHtml(item.title)}</option>
  `).join("");
  elements.snapshotSelect.value = String(snapshot.id);
  const isDraft = snapshot.status === SNAPSHOT_STATUS.DRAFT;
  elements.snapshotStatus.textContent = isDraft ? "작성중" : "확정";
  elements.snapshotStatus.className = `badge ${isDraft ? "draft" : "confirmed"}`;
  elements.snapshotDate.textContent = `저장 ${formatDateTime(snapshot.updatedAt)}`;
  elements.toggleSnapshotStatusButton.textContent = isDraft ? "버전 확정" : "확정됨";
  elements.toggleSnapshotStatusButton.disabled = !isDraft;
  elements.saveStatementButton.disabled = !isDraft;

  elements.contractAmount.textContent = formatWon(snapshot.totals.contractAmount);
  elements.executionBudget.textContent = formatWon(snapshot.totals.executionBudget);
  elements.budgetBalance.textContent = `예산잔액 ${formatWon(snapshot.totals.budgetBalance)}`;
  elements.purchaseAmount.textContent = formatWon(snapshot.totals.purchaseAmount);
  elements.profitAmount.textContent = formatWon(snapshot.totals.profitAmount);
  elements.profitRate.textContent = `이익률 ${formatPercent(snapshot.totals.profitRate)}`;
  renderStatementRows();
  renderReceipts();
}

function renderStatementRows() {
  const snapshot = state.snapshot;
  const isDraft = snapshot.status === SNAPSHOT_STATUS.DRAFT;
  const groups = groupStatementLines(snapshot.lines);
  if (snapshot.lines.length === 0) {
    elements.statementRows.innerHTML = '<tr><td class="empty-row" colspan="8">스냅샷에 포함된 중분류가 없습니다.</td></tr>';
  } else {
    elements.statementRows.innerHTML = groups.map((group) => {
      const lines = group.lines.map((line, index) => `
        <tr class="statement-line" data-line-id="${line.id}">
          ${index === 0 ? `<td class="major-cell merged-major-cell" rowspan="${group.lines.length}">${escapeHtml(group.majorName)}</td>` : ""}
          <td class="middle-cell">${escapeHtml(line.middleName)}</td>
          <td><span class="item-count ${line.items.length ? "" : "missing"}">${itemCountText(line.items)}</span></td>
          <td class="number-cell"><input class="inline-input budget-input" type="text" inputmode="numeric" autocomplete="off" value="${Number(line.executionBudget).toLocaleString("ko-KR")}" ${isDraft ? "" : "disabled"}></td>
          <td class="number-cell">${formatWon(line.purchaseAmount)}</td>
          <td class="number-cell ${line.balanceAmount < 0 ? "negative" : ""}">${formatWon(line.balanceAmount)}</td>
          <td>${progressMarkup(line.executionRate)}</td>
          <td><input class="inline-input remark-input" value="${escapeHtml(line.remark)}" maxlength="200" ${isDraft ? "" : "disabled"}></td>
        </tr>`).join("");
      return `${lines}
        <tr class="group-subtotal">
          <td colspan="3"><strong>${escapeHtml(group.majorName)} 소계</strong><span>중분류 ${group.lines.length.toLocaleString("ko-KR")}개</span></td>
          <td class="number-cell">${formatWon(group.totals.executionBudget)}</td>
          <td class="number-cell">${formatWon(group.totals.purchaseAmount)}</td>
          <td class="number-cell ${group.totals.balanceAmount < 0 ? "negative" : ""}">${formatWon(group.totals.balanceAmount)}</td>
          <td>${progressMarkup(group.totals.executionRate, "subtotal-progress")}</td>
          <td></td>
        </tr>`;
    }).join("");
  }
  const overallTotals = calculateLineTotals(snapshot.lines);
  elements.statementTotals.innerHTML = `
    <tr><td colspan="3">전체 합계</td><td class="number-cell">${formatWon(snapshot.totals.executionBudget)}</td><td class="number-cell">${formatWon(snapshot.totals.purchaseAmount)}</td><td class="number-cell ${snapshot.totals.budgetBalance < 0 ? "negative" : ""}">${formatWon(snapshot.totals.budgetBalance)}</td><td>${progressMarkup(overallTotals.executionRate, "total-progress")}</td><td></td></tr>
  `;
  attachStatementInputEvents();
}

function attachStatementInputEvents() {
  const inputs = [...elements.statementRows.querySelectorAll(".statement-line .inline-input:not(:disabled)")];
  for (const input of inputs) {
    if (input.classList.contains("budget-input")) {
      input.addEventListener("focus", () => {
        input.value = String(parseBudgetInput(input.value));
      });
      input.addEventListener("input", () => {
        input.value = input.value.replace(/[^0-9]/g, "");
      });
      input.addEventListener("blur", () => formatBudgetInput(input));
    }
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      if (input.classList.contains("budget-input")) formatBudgetInput(input);
      const currentIndex = inputs.indexOf(input);
      const nextIndex = event.shiftKey ? currentIndex - 1 : currentIndex + 1;
      const nextInput = inputs[nextIndex];
      if (nextInput) {
        nextInput.focus();
        nextInput.select();
      } else if (!event.shiftKey) {
        elements.saveStatementButton.focus();
      }
    });
  }
}

function renderPrintReport() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const groups = groupStatementLines(snapshot.lines);
  const overallTotals = calculateLineTotals(snapshot.lines);
  const detailRows = groups.map((group) => {
    const lines = group.lines.map((line, index) => `
      <tr>
        ${index === 0 ? `<td class="print-major" rowspan="${group.lines.length}">${escapeHtml(group.majorName)}</td>` : ""}
        <td>${escapeHtml(line.middleName)}</td>
        <td class="print-center">${itemCountText(line.items)}</td>
        <td class="print-number">${formatWon(line.executionBudget)}</td>
        <td class="print-number">${formatWon(line.purchaseAmount)}</td>
        <td class="print-number ${line.balanceAmount < 0 ? "negative" : ""}">${formatWon(line.balanceAmount)}</td>
        <td class="print-number">${formatPercent(line.executionRate)}</td>
        <td>${escapeHtml(line.remark || "")}</td>
      </tr>`).join("");
    return `${lines}
      <tr class="print-subtotal">
        <td colspan="3">${escapeHtml(group.majorName)} 소계 · 중분류 ${group.lines.length.toLocaleString("ko-KR")}개</td>
        <td class="print-number">${formatWon(group.totals.executionBudget)}</td>
        <td class="print-number">${formatWon(group.totals.purchaseAmount)}</td>
        <td class="print-number ${group.totals.balanceAmount < 0 ? "negative" : ""}">${formatWon(group.totals.balanceAmount)}</td>
        <td class="print-number">${formatPercent(group.totals.executionRate)}</td>
        <td></td>
      </tr>`;
  }).join("");

  elements.printReport.innerHTML = `
    <div class="print-report-header">
      <div class="print-title-block"><span>PROJECT EXECUTION REPORT</span><h1>기 성 집 행 서</h1></div>
      <table class="approval-table"><thead><tr><th>작성</th><th>검토</th><th>승인</th></tr></thead><tbody><tr><td></td><td></td><td></td></tr></tbody></table>
    </div>
    <table class="print-meta-table">
      <tr><th>프로젝트</th><td>${escapeHtml(snapshot.projectCode)} · ${escapeHtml(snapshot.projectName)}</td><th>버전</th><td>v${snapshot.versionNo} · ${REPORT_STATUS_LABEL[snapshot.status]}</td><th>저장일</th><td>${formatDateTime(snapshot.updatedAt)}</td></tr>
    </table>
    <div class="print-summary">
      <div><span>계약금액</span><strong>${formatWon(snapshot.totals.contractAmount)}</strong></div>
      <div><span>실행예산</span><strong>${formatWon(snapshot.totals.executionBudget)}</strong></div>
      <div><span>누적 매입금액</span><strong>${formatWon(snapshot.totals.purchaseAmount)}</strong></div>
      <div><span>예상 이익</span><strong>${formatWon(snapshot.totals.profitAmount)}</strong></div>
      <div><span>예상 이익률</span><strong>${formatPercent(snapshot.totals.profitRate)}</strong></div>
    </div>
    <table class="print-detail-table">
      <colgroup><col class="print-col-major"><col class="print-col-middle"><col class="print-col-items"><col class="print-col-money"><col class="print-col-money"><col class="print-col-money"><col class="print-col-rate"><col></colgroup>
      <thead><tr><th>대분류</th><th>중분류</th><th>연결 품번</th><th>실행예산</th><th>매입금액 소계</th><th>예산잔액</th><th>집행률</th><th>비고</th></tr></thead>
      <tbody>${detailRows || '<tr><td colspan="8" class="print-empty">스냅샷에 포함된 중분류가 없습니다.</td></tr>'}</tbody>
      <tfoot><tr><td colspan="3">전체 합계</td><td class="print-number">${formatWon(overallTotals.executionBudget)}</td><td class="print-number">${formatWon(overallTotals.purchaseAmount)}</td><td class="print-number ${overallTotals.balanceAmount < 0 ? "negative" : ""}">${formatWon(overallTotals.balanceAmount)}</td><td class="print-number">${formatPercent(overallTotals.executionRate)}</td><td></td></tr></tfoot>
    </table>
    <div class="print-report-footer"><span>연결 품번은 상세 코드 대신 중분류별 건수로 표기했습니다.</span><span>출력 ${formatDateTime(new Date())}</span></div>`;
}

function renderReceipts() {
  const receipts = state.snapshot.receipts;
  elements.receiptCount.textContent = `${receipts.length.toLocaleString("ko-KR")}건`;
  elements.receiptRows.innerHTML = receipts.length ? receipts.map((receipt) => `
    <tr><td>${escapeHtml(receipt.receiptDate)}</td><td>${escapeHtml(receipt.receiptNo)}</td><td>${escapeHtml(receipt.itemCode)}</td><td>${escapeHtml(receipt.itemName)}</td><td class="number-cell">${formatWon(receipt.amount)}</td><td class="number-cell">${formatWon(receipt.vatAmount)}</td></tr>
  `).join("") : '<tr><td class="empty-row" colspan="6">불러온 입고 내역이 없습니다.</td></tr>';
}

async function saveStatement() {
  const lines = [...elements.statementRows.querySelectorAll(".statement-line")].map((row) => ({
    id: Number(row.dataset.lineId),
    executionBudget: parseBudgetInput(row.querySelector(".budget-input").value),
    remark: row.querySelector(".remark-input").value,
  }));
  state.snapshot = await busy(() => api(`/api/snapshots/${state.snapshot.id}/lines`, {
    method: "PUT",
    body: JSON.stringify({ lines }),
  }));
  renderSnapshot();
  showToast(`${lines.length.toLocaleString("ko-KR")}개 중분류의 실행예산과 비고를 저장했습니다.`);
}

async function createSnapshot(cloneCurrent = false) {
  if (!state.selectedProjectId) return;
  const body = cloneCurrent && state.snapshot ? { cloneSnapshotId: state.snapshot.id } : {};
  const created = await busy(() => api(`/api/projects/${state.selectedProjectId}/snapshots`, { method: "POST", body: JSON.stringify(body) }));
  await loadSnapshots(created.id);
  showToast(cloneCurrent ? "이전 내용을 복제해 새 버전을 만들었습니다." : "현재 설정으로 새 버전을 만들었습니다.");
}

function selectedMajor() {
  return state.categories.find((major) => major.id === Number(state.selectedMajorId));
}

function selectedMiddle() {
  return selectedMajor()?.middleCategories.find((middle) => middle.id === Number(state.selectedMiddleId));
}

function renderSettings() {
  if (!selectedMajor() && state.categories.length) state.selectedMajorId = state.categories[0].id;
  if (!selectedMiddle() && selectedMajor()?.middleCategories.length) state.selectedMiddleId = selectedMajor().middleCategories[0].id;
  renderMajorList();
  renderMiddleList();
  renderMappedItems();
}

function renderMajorList() {
  elements.majorList.innerHTML = state.categories.length ? state.categories.map((major) => `
    <div class="master-row ${major.id === Number(state.selectedMajorId) ? "selected" : ""}" data-major-id="${major.id}">
      <button class="select-major">${escapeHtml(major.name)}</button>
      <span class="count">${major.middleCategories.length}</span>
      <button class="row-action edit-major" title="수정">수정</button>
      <button class="row-action danger delete-major" title="삭제">삭제</button>
    </div>
  `).join("") : '<div class="settings-placeholder">대분류를 추가해 주세요.</div>';
  elements.majorList.querySelectorAll(".select-major").forEach((button) => button.addEventListener("click", () => {
    state.selectedMajorId = Number(button.closest(".master-row").dataset.majorId);
    state.selectedMiddleId = selectedMajor()?.middleCategories[0]?.id || null;
    elements.itemSearchResults.classList.add("hidden");
    renderSettings();
  }));
  elements.majorList.querySelectorAll(".edit-major").forEach((button) => button.addEventListener("click", () => editMajor(button.closest(".master-row"))));
  elements.majorList.querySelectorAll(".delete-major").forEach((button) => button.addEventListener("click", () => deleteMajor(button.closest(".master-row"))));
}

function renderMiddleList() {
  const major = selectedMajor();
  elements.middleList.innerHTML = major?.middleCategories.length ? major.middleCategories.map((middle) => `
    <div class="master-row ${middle.id === Number(state.selectedMiddleId) ? "selected" : ""}" data-middle-id="${middle.id}">
      <button class="select-middle">${escapeHtml(middle.name)}</button>
      <span class="count">${middle.items.length}</span>
      <button class="row-action edit-middle">수정</button>
      <button class="row-action danger delete-middle">삭제</button>
    </div>
  `).join("") : `<div class="settings-placeholder">${major ? "중분류를 추가해 주세요." : "먼저 대분류를 선택하세요."}</div>`;
  elements.middleList.querySelectorAll(".select-middle").forEach((button) => button.addEventListener("click", () => {
    state.selectedMiddleId = Number(button.closest(".master-row").dataset.middleId);
    elements.itemSearchResults.classList.add("hidden");
    renderSettings();
  }));
  elements.middleList.querySelectorAll(".edit-middle").forEach((button) => button.addEventListener("click", () => editMiddle(button.closest(".master-row"))));
  elements.middleList.querySelectorAll(".delete-middle").forEach((button) => button.addEventListener("click", () => deleteMiddle(button.closest(".master-row"))));
}

function renderMappedItems() {
  const middle = selectedMiddle();
  if (!middle) {
    elements.mappedItemList.innerHTML = '<div class="settings-placeholder">품번을 연결할 중분류를 선택하세요.</div>';
    return;
  }
  elements.mappedItemList.innerHTML = `<p class="mapped-heading">${escapeHtml(selectedMajor().name)} 〉 ${escapeHtml(middle.name)} · ${middle.items.length}개 품번</p>` + (middle.items.length ? middle.items.map((item) => `
    <div class="mapped-row" data-item-id="${item.id}"><code>${escapeHtml(item.itemCode)}</code><span>${escapeHtml(item.itemName)}</span><button class="row-action danger delete-item">연결 해제</button></div>
  `).join("") : '<div class="settings-placeholder">연결된 품번이 없습니다.<br>위에서 아마란스10 품번을 검색해 추가하세요.</div>');
  elements.mappedItemList.querySelectorAll(".delete-item").forEach((button) => button.addEventListener("click", () => deleteItem(button.closest(".mapped-row"))));
}

async function refreshCategories() {
  state.categories = await api(API_ENDPOINTS.CATEGORIES);
  renderSettings();
}

async function addMajor() {
  const name = await askText({ title: "대분류 추가", label: "대분류명" });
  if (!name) return;
  await busy(() => api(API_ENDPOINTS.MAJOR_CATEGORIES, { method: "POST", body: JSON.stringify({ name, sortOrder: state.categories.length + 1 }) }));
  await refreshCategories();
  showToast("대분류를 추가했습니다.");
}

async function editMajor(row) {
  const major = state.categories.find((item) => item.id === Number(row.dataset.majorId));
  const name = await askText({ title: "대분류 수정", label: "대분류명", initial: major.name });
  if (!name) return;
  await busy(() => api(`${API_ENDPOINTS.MAJOR_CATEGORIES}/${major.id}`, { method: "PUT", body: JSON.stringify({ name, sortOrder: major.sortOrder }) }));
  await refreshCategories();
  showToast("대분류를 수정했습니다.");
}

async function deleteMajor(row) {
  const major = state.categories.find((item) => item.id === Number(row.dataset.majorId));
  if (!window.confirm(`'${major.name}' 대분류와 하위 설정을 삭제할까요?\n기존 스냅샷에는 영향을 주지 않습니다.`)) return;
  await busy(() => api(`${API_ENDPOINTS.MAJOR_CATEGORIES}/${major.id}`, { method: "DELETE" }));
  state.selectedMajorId = null;
  state.selectedMiddleId = null;
  await refreshCategories();
  showToast("대분류를 삭제했습니다.");
}

async function addMiddle() {
  const major = selectedMajor();
  if (!major) return showToast("먼저 대분류를 선택해 주세요.", true);
  const name = await askText({ title: "중분류 추가", label: `${major.name}의 중분류명` });
  if (!name) return;
  await busy(() => api(API_ENDPOINTS.MIDDLE_CATEGORIES, { method: "POST", body: JSON.stringify({ majorCategoryId: major.id, name, sortOrder: major.middleCategories.length + 1 }) }));
  await refreshCategories();
  showToast("중분류를 추가했습니다.");
}

async function editMiddle(row) {
  const major = selectedMajor();
  const middle = major.middleCategories.find((item) => item.id === Number(row.dataset.middleId));
  const name = await askText({ title: "중분류 수정", label: "중분류명", initial: middle.name });
  if (!name) return;
  await busy(() => api(`${API_ENDPOINTS.MIDDLE_CATEGORIES}/${middle.id}`, { method: "PUT", body: JSON.stringify({ majorCategoryId: major.id, name, sortOrder: middle.sortOrder }) }));
  await refreshCategories();
  showToast("중분류를 수정했습니다.");
}

async function deleteMiddle(row) {
  const middle = selectedMajor().middleCategories.find((item) => item.id === Number(row.dataset.middleId));
  if (!window.confirm(`'${middle.name}' 중분류와 연결 품번을 삭제할까요?\n기존 스냅샷에는 영향을 주지 않습니다.`)) return;
  await busy(() => api(`${API_ENDPOINTS.MIDDLE_CATEGORIES}/${middle.id}`, { method: "DELETE" }));
  state.selectedMiddleId = null;
  await refreshCategories();
  showToast("중분류를 삭제했습니다.");
}

async function searchItems() {
  const query = elements.itemSearchInput.value.trim();
  const items = await busy(() => api(API_ENDPOINTS.ITEM_SEARCH, { method: "POST", body: JSON.stringify({ query }) }));
  elements.itemSearchResults.classList.remove("hidden");
  elements.itemSearchResults.innerHTML = items.length ? items.map((item) => `
    <div class="search-result"><code>${escapeHtml(item.itemCode)}</code><span>${escapeHtml(item.itemName)}</span><button data-code="${escapeHtml(item.itemCode)}" data-name="${escapeHtml(item.itemName)}">연결</button></div>
  `).join("") : '<div class="settings-placeholder">검색 결과가 없습니다.</div>';
  elements.itemSearchResults.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => addItem(button.dataset.code, button.dataset.name)));
}

async function addItem(itemCode, itemName) {
  const middle = selectedMiddle();
  if (!middle) return showToast("품번을 연결할 중분류를 선택해 주세요.", true);
  await busy(() => api(API_ENDPOINTS.ITEM_MAPPINGS, { method: "POST", body: JSON.stringify({ middleCategoryId: middle.id, itemCode, itemName }) }));
  await refreshCategories();
  showToast(`${itemCode} 품번을 연결했습니다.`);
}

async function deleteItem(row) {
  await busy(() => api(`${API_ENDPOINTS.ITEM_MAPPINGS}/${row.dataset.itemId}`, { method: "DELETE" }));
  await refreshCategories();
  showToast("품번 연결을 해제했습니다.");
}

document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => setScreen(button.dataset.screen)));
elements.projectSelect.addEventListener("change", async () => {
  state.selectedProjectId = Number(elements.projectSelect.value);
  renderProjects();
  await busy(() => loadSnapshots());
});
elements.snapshotSelect.addEventListener("change", async () => {
  state.snapshot = await busy(() => api(`/api/snapshots/${elements.snapshotSelect.value}`));
  renderSnapshot();
});
elements.newSnapshotButton.addEventListener("click", () => createSnapshot(false));
elements.emptyNewSnapshotButton.addEventListener("click", () => createSnapshot(false));
elements.cloneSnapshotButton.addEventListener("click", () => createSnapshot(true));
elements.toggleSnapshotStatusButton.addEventListener("click", async () => {
  const status = SNAPSHOT_STATUS.CONFIRMED;
  state.snapshot = await busy(() => api(`/api/snapshots/${state.snapshot.id}/status`, { method: "PUT", body: JSON.stringify({ status }) }));
  await loadSnapshots(state.snapshot.id);
  showToast("버전을 확정했습니다. 이후 변경은 새 버전에서 진행해 주세요.");
});
elements.importReceiptsButton.addEventListener("click", async () => {
  const result = await busy(() => api(`/api/snapshots/${state.snapshot.id}/receipts/import`, {
    method: "POST",
    body: JSON.stringify({ fromDate: elements.fromDate.value, toDate: elements.toDate.value }),
  }));
  state.snapshot = result.snapshot;
  renderSnapshot();
  showToast(`${result.importedCount.toLocaleString("ko-KR")}건의 입고금액을 반영했습니다.`);
});
elements.saveStatementButton.addEventListener("click", saveStatement);
elements.printStatementButton.addEventListener("click", () => {
  renderPrintReport();
  window.print();
});
elements.exportExcelButton.addEventListener("click", () => {
  if (!state.snapshot) return;
  const link = document.createElement("a");
  link.href = snapshotExportEndpoint(state.snapshot.id);
  document.body.append(link);
  link.click();
  link.remove();
  showToast("기성집행서 Excel 파일을 생성합니다.");
});
elements.syncProjectsButton.addEventListener("click", async () => {
  state.projects = await busy(() => api(API_ENDPOINTS.PROJECT_SYNC, { method: "POST", body: "{}" }));
  renderProjects();
  await loadSnapshots();
  showToast("프로젝트 정보를 동기화했습니다.");
});
elements.addMajorButton.addEventListener("click", addMajor);
elements.addMiddleButton.addEventListener("click", addMiddle);
elements.itemSearchButton.addEventListener("click", searchItems);
elements.itemSearchInput.addEventListener("keydown", (event) => { if (event.key === "Enter") searchItems(); });
elements.amaranceSettingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = {
    mode: elements.amaranceMode.value,
    baseUrl: elements.amaranceBaseUrl.value.trim(),
    companyCode: elements.amaranceCompanyCode.value.trim(),
    callerName: elements.amaranceCallerName.value.trim(),
    accessToken: elements.amaranceAccessToken.value,
    hashKey: elements.amaranceHashKey.value,
    groupSeq: elements.amaranceGroupSeq.value.trim(),
    clearAccessToken: elements.clearAccessToken.checked,
    clearHashKey: elements.clearHashKey.checked,
  };
  state.amaranceSettings = await busy(() => api(API_ENDPOINTS.AMARANCE_SETTINGS, { method: "PUT", body: JSON.stringify(body) }));
  renderAmaranceSettings();
  showToast("아마란스10 연동 설정을 저장했습니다.");
});
elements.testAmaranceButton.addEventListener("click", async () => {
  const result = await busy(() => api(API_ENDPOINTS.AMARANCE_SETTINGS_TEST, { method: "POST", body: "{}" }));
  showToast(result.message);
});

window.addEventListener("beforeprint", renderPrintReport);

async function initialize() {
  const today = new Date();
  elements.today.textContent = new Intl.DateTimeFormat("ko-KR", { dateStyle: "full" }).format(today);
  elements.toDate.value = today.toISOString().slice(0, 10);
  elements.fromDate.value = `${today.getFullYear()}-01-01`;
  const bootstrap = await busy(() => api(API_ENDPOINTS.BOOTSTRAP));
  state.projects = bootstrap.projects;
  state.categories = bootstrap.categories;
  state.amaranceSettings = bootstrap.amarance;
  state.selectedProjectId = state.projects[0]?.id || null;
  renderProjects();
  renderSettings();
  renderAmaranceSettings();
  await loadSnapshots();
}

initialize().catch(() => {});
