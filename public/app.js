import { calculateBudget, calculateExecutionTotals, groupExecutionLines } from "/shared/calculations.mjs";

const API = Object.freeze({
  BOOTSTRAP: "/api/bootstrap",
  CATEGORIES: "/api/categories",
  MAJOR_CATEGORIES: "/api/major-categories",
  MIDDLE_CATEGORIES: "/api/middle-categories",
  ITEM_MAPPINGS: "/api/item-mappings",
  ITEM_SEARCH: "/api/amarance/items/search",
  AMARANCE_SETTINGS: "/api/amarance/settings",
  AMARANCE_SETTINGS_TEST: "/api/amarance/settings/test",
  SECURITY_SETTINGS: "/api/security/settings",
  PROJECT_SYNC: "/api/projects/sync",
  USERS: "/api/users",
  CATEGORY_SETS: "/api/category-sets",
  RESET: "/api/admin/reset",
  AUDIT_LOGS: "/api/audit-logs",
  LOGOUT: "/api/auth/logout",
  PASSWORD: "/api/auth/password",
});

const SNAPSHOT_STATUS = Object.freeze({ DRAFT: "DRAFT", CONFIRMED: "CONFIRMED" });
const SCREEN = Object.freeze({
  STATEMENT: "statement",
  SETTINGS: "settings",
  AMARANCE: "amarance",
  SECURITY: "security",
  USERS: "users",
  AUDIT: "audit",
});
const SCREEN_TITLE = Object.freeze({
  statement: "기성집행서",
  settings: "분류 · 품번 설정",
  amarance: "아마란스10 설정",
  security: "접속 · 보안",
  users: "사용자",
  audit: "활동 기록",
});
const REPORT_STATUS_LABEL = Object.freeze({ DRAFT: "작성중", CONFIRMED: "확정" });
const ROLE_LABEL = Object.freeze({ ADMIN: "관리자", EDITOR: "작성자", VIEWER: "조회자" });
const AUDIT_ACTION_LABEL = Object.freeze({
  LOGIN: "로그인", LOGIN_SSO: "아마란스10 진입", LOGIN_FAILED: "로그인 실패", LOGOUT: "로그아웃",
  PASSWORD_CHANGED: "비밀번호 변경", USER_CREATED: "사용자 추가", USER_UPDATED: "사용자 변경",
  USER_DELETED: "사용자 삭제", CATEGORY_CHANGED: "분류 변경", PROJECT_SYNCED: "프로젝트 동기화",
  SNAPSHOT_CREATED: "버전 생성", SNAPSHOT_UPDATED: "버전 저장", SNAPSHOT_CONFIRMED: "버전 확정",
  SNAPSHOT_DELETED: "버전 삭제", SNAPSHOT_RENAMED: "버전 이름 변경", CONTRACT_REFRESHED: "계약금액 갱신",
  RECEIPTS_IMPORTED: "입고 반영", RECEIPTS_DELETED: "입고 삭제",
  AMARANCE_SETTINGS_SAVED: "아마란스10 설정 저장", SECURITY_SETTINGS_SAVED: "보안 설정 저장",
  EXPORTED: "Excel 내보내기",
  CATEGORY_SET_CREATED: "설정 버전 생성", CATEGORY_SET_RENAMED: "설정 버전 이름 변경",
  CATEGORY_SET_ACTIVATED: "설정 버전 지정", CATEGORY_SET_DELETED: "설정 버전 삭제",
  DATA_RESET: "전체 초기화",
});
const AUDIT_PAGE_SIZE = 50;

const state = {
  user: null,
  permissions: { canEdit: false, canAdminister: false },
  csrfToken: "",
  projects: [],
  categories: [],
  categorySets: [],
  selectedCategorySetId: null,
  snapshots: [],
  snapshot: null,
  selectedProjectId: null,
  selectedMajorId: null,
  selectedMiddleId: null,
  amaranceSettings: null,
  ssoSettings: null,
  securitySettings: null,
  users: [],
  auditOffset: 0,
  auditTotal: 0,
  screen: SCREEN.STATEMENT,
  dirty: false,
  receiptSkipNotice: "",
};

const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));

// ------------------------------------------------------------------ 표시 도우미

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

function itemCountText(items = []) {
  return items.length === 0 ? "미설정" : `${items.length.toLocaleString("ko-KR")}개 품번`;
}

function progressMarkup(rate, className = "") {
  const numeric = Number(rate) || 0;
  const progress = Math.max(0, Math.min(100, numeric));
  const over = numeric > 100 ? " over" : "";
  // 인라인 style 은 CSP(style-src 'self')에 막히므로 폭은 삽입 후 JS 로 지정합니다.
  return `<div class="progress${over} ${className}"><div class="progress-track"><div class="progress-bar" data-progress="${progress}"></div></div><span>${formatPercent(numeric)}</span></div>`;
}

/** progressMarkup 으로 그린 막대의 폭을 실제로 적용합니다. */
function applyProgressWidths(root = document) {
  for (const bar of root.querySelectorAll(".progress-bar[data-progress]")) {
    bar.style.width = `${bar.dataset.progress}%`;
  }
}

/** 음수는 색 외에 기호로도 알아볼 수 있게 표시합니다. */
function amountCellMarkup(value) {
  const amount = Number(value) || 0;
  return amount < 0
    ? `<span class="negative">△ ${formatWon(Math.abs(amount))}</span>`
    : formatWon(amount);
}

// ------------------------------------------------------------------ 통신

async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(method === "GET" ? {} : { "X-CSRF-Token": state.csrfToken }),
      ...(options.headers || {}),
    },
  });
  if (response.status === 401) {
    window.location.replace("/login");
    throw new Error("로그인이 필요합니다.");
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (data.code === "PASSWORD_CHANGE_REQUIRED") {
      window.location.replace("/login");
    }
    const error = new Error(data.message || "요청 처리에 실패했습니다.");
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

let busyDepth = 0;
async function busy(action) {
  busyDepth += 1;
  elements.loading.classList.remove("hidden");
  try {
    return await action();
  } catch (error) {
    showToast(error.message || "처리 중 오류가 발생했습니다.", true);
    throw error;
  } finally {
    busyDepth -= 1;
    if (busyDepth <= 0) {
      busyDepth = 0;
      elements.loading.classList.add("hidden");
    }
  }
}

/** 화면 흐름을 끊지 않아야 하는 곳에서 오류를 토스트로만 알리고 넘어갑니다. */
function ignoreFailure(promise) {
  return promise.catch(() => {});
}

let toastTimer;
function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast show${isError ? " error" : ""}`;
  toastTimer = setTimeout(() => { elements.toast.className = "toast"; }, isError ? 5200 : 2800);
}

// ------------------------------------------------------------------ 대화상자

// 취소 버튼은 제출 대상이 아니므로(입력란 Enter 가 확인으로 가도록) 직접 닫아 줍니다.
// Esc 는 <dialog> 기본 동작으로 닫히며, returnValue 가 "confirm" 이 아니라 취소로 처리됩니다.
for (const button of document.querySelectorAll("[data-dialog-cancel]")) {
  button.addEventListener("click", () => {
    document.getElementById(button.dataset.dialogCancel)?.close("cancel");
  });
}

function openDialog(dialog, onClose) {
  const handleClose = () => {
    dialog.removeEventListener("close", handleClose);
    onClose(dialog.returnValue);
  };
  dialog.addEventListener("close", handleClose);
  dialog.showModal();
}

function askText({ title, label, initial = "", confirmLabel = "저장" }) {
  return new Promise((resolve) => {
    elements.textDialogTitle.textContent = title;
    elements.textDialogLabel.textContent = label;
    elements.textDialogInput.value = initial;
    elements.textDialogConfirm.textContent = confirmLabel;
    openDialog(elements.textDialog, (returnValue) => {
      resolve(returnValue === "confirm" ? elements.textDialogInput.value.trim() : null);
    });
    setTimeout(() => {
      elements.textDialogInput.focus();
      elements.textDialogInput.select();
    }, 0);
  });
}

function askConfirm({ title, message, confirmLabel = "확인", danger = false }) {
  return new Promise((resolve) => {
    elements.confirmDialogTitle.textContent = title;
    elements.confirmDialogMessage.textContent = message;
    elements.confirmDialogConfirm.textContent = confirmLabel;
    elements.confirmDialogConfirm.classList.toggle("danger", danger);
    openDialog(elements.confirmDialog, (returnValue) => resolve(returnValue === "confirm"));
    setTimeout(() => elements.confirmDialogConfirm.focus(), 0);
  });
}

function showNotice({ title, message, value = "" }) {
  return new Promise((resolve) => {
    elements.noticeDialogTitle.textContent = title;
    elements.noticeDialogMessage.textContent = message;
    elements.noticeDialogValue.textContent = value;
    elements.noticeDialogValue.hidden = !value;
    openDialog(elements.noticeDialog, () => resolve());
  });
}

elements.textDialogForm.addEventListener("submit", (event) => {
  event.preventDefault();
  // 값이 비어 있으면 닫지 않고 입력을 기다립니다.
  if (!elements.textDialogInput.value.trim()) {
    elements.textDialogInput.focus();
    return;
  }
  elements.textDialog.close("confirm");
});

elements.confirmDialogForm.addEventListener("submit", (event) => {
  event.preventDefault();
  elements.confirmDialog.close("confirm");
});

// ------------------------------------------------------------------ 저장하지 않은 변경 보호

function setDirty(dirty) {
  state.dirty = dirty;
  elements.dirtyFlag.classList.toggle("hidden", !dirty);
  elements.saveHint.textContent = dirty
    ? "저장하지 않은 변경이 있습니다."
    : "실행예산과 비고를 입력한 뒤 저장하세요.";
}

async function confirmDiscardChanges() {
  if (!state.dirty) return true;
  const discard = await askConfirm({
    title: "저장하지 않은 변경이 있습니다",
    message: "지금 이동하면 입력한 실행예산과 비고가 사라집니다. 이동할까요?",
    confirmLabel: "저장하지 않고 이동",
    danger: true,
  });
  if (discard) setDirty(false);
  return discard;
}

window.addEventListener("beforeunload", (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

// ------------------------------------------------------------------ 화면 전환

async function setScreen(screen) {
  if (state.screen === SCREEN.STATEMENT && screen !== SCREEN.STATEMENT && !await confirmDiscardChanges()) return;
  state.screen = screen;
  document.querySelectorAll(".nav-item").forEach((button) => {
    const active = button.dataset.screen === screen;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  elements.statementScreen.classList.toggle("active", screen === SCREEN.STATEMENT);
  elements.settingsScreen.classList.toggle("active", screen === SCREEN.SETTINGS);
  elements.amaranceSettingsScreen.classList.toggle("active", screen === SCREEN.AMARANCE);
  elements.securityScreen.classList.toggle("active", screen === SCREEN.SECURITY);
  elements.usersScreen.classList.toggle("active", screen === SCREEN.USERS);
  elements.auditScreen.classList.toggle("active", screen === SCREEN.AUDIT);
  elements.pageTitle.textContent = SCREEN_TITLE[screen];

  if (screen === SCREEN.SETTINGS) await ignoreFailure(refreshCategorySets(state.selectedCategorySetId));
  if (screen === SCREEN.USERS) await ignoreFailure(loadUsers());
  if (screen === SCREEN.AUDIT) await ignoreFailure(loadAuditLogs(0));
  if (screen === SCREEN.SECURITY || screen === SCREEN.AMARANCE) await ignoreFailure(loadIntegrationSettings());
}

function applyPermissions() {
  document.body.classList.toggle("can-edit", state.permissions.canEdit);
  document.body.classList.toggle("can-administer", state.permissions.canAdminister);
  elements.userName.textContent = state.user?.name || "-";
  elements.userRole.textContent = ROLE_LABEL[state.user?.role] || "-";
  elements.userAvatar.textContent = (state.user?.name || "?").trim().slice(0, 1);
}

// ------------------------------------------------------------------ 프로젝트

function visibleProjects() {
  const keyword = elements.projectFilter.value.trim().toLowerCase();
  if (!keyword) return state.projects;
  return state.projects.filter((project) =>
    project.code.toLowerCase().includes(keyword) || project.name.toLowerCase().includes(keyword));
}

function renderProjects() {
  const projects = visibleProjects();
  elements.projectSelect.innerHTML = projects.length
    ? projects.map((project) => `<option value="${project.id}">${project.isArchived ? "[보관] " : ""}${escapeHtml(project.code)} · ${escapeHtml(project.name)}</option>`).join("")
    : '<option value="">검색 결과가 없습니다</option>';
  if (projects.length && !projects.some((project) => project.id === Number(state.selectedProjectId))) {
    state.selectedProjectId = projects[0].id;
  }
  elements.projectSelect.value = String(state.selectedProjectId || "");
  const project = state.projects.find((item) => item.id === Number(state.selectedProjectId));
  elements.projectMeta.innerHTML = project
    ? `<strong>${formatWon(project.contractAmount)}</strong>`
      + `<span>${project.status === "ACTIVE" ? "진행 프로젝트" : "완료 프로젝트"}</span>`
      + (project.isArchived ? '<span class="archived-note">아마란스10 조회 결과에 없음 (보관)</span>' : "")
    : "";
}

async function loadSnapshots(preferredSnapshotId = null) {
  if (!state.selectedProjectId) {
    state.snapshots = [];
    state.snapshot = null;
    renderSnapshot();
    return;
  }
  state.snapshots = await api(`/api/projects/${state.selectedProjectId}/snapshots`);
  const selectedId = preferredSnapshotId || state.snapshots[0]?.id;
  state.snapshot = selectedId ? await api(`/api/snapshots/${selectedId}`) : null;
  setDirty(false);
  renderSnapshot();
}

// ------------------------------------------------------------------ 집행서 렌더링

function renderSnapshot() {
  const hasSnapshot = Boolean(state.snapshot);
  elements.emptySnapshot.classList.toggle("hidden", hasSnapshot);
  elements.snapshotContent.classList.toggle("hidden", !hasSnapshot);
  elements.cloneSnapshotButton.disabled = !hasSnapshot;
  if (!hasSnapshot) return;

  const snapshot = state.snapshot;
  const isDraft = snapshot.status === SNAPSHOT_STATUS.DRAFT;
  const editable = isDraft && state.permissions.canEdit;

  elements.snapshotSelect.innerHTML = state.snapshots.map((item) => `
    <option value="${item.id}">v${item.versionNo} · ${escapeHtml(item.title)}${item.status === SNAPSHOT_STATUS.CONFIRMED ? " (확정)" : ""}</option>
  `).join("");
  elements.snapshotSelect.value = String(snapshot.id);
  elements.snapshotCategorySetLabel.textContent = snapshot.categorySetLabel ? `설정 ${snapshot.categorySetLabel}` : "";
  elements.snapshotCategorySetLabel.classList.toggle("hidden", !snapshot.categorySetLabel);
  elements.snapshotStatus.textContent = REPORT_STATUS_LABEL[snapshot.status];
  elements.snapshotStatus.className = `badge ${isDraft ? "draft" : "confirmed"}`;
  elements.snapshotDate.textContent = snapshot.confirmedBy
    ? `확정 ${escapeHtml(snapshot.confirmedBy)} · ${formatDateTime(snapshot.confirmedAt)}`
    : `저장 ${formatDateTime(snapshot.updatedAt)}`;
  elements.toggleSnapshotStatusButton.textContent = isDraft ? "버전 확정" : "확정됨";
  elements.toggleSnapshotStatusButton.disabled = !editable;
  elements.saveStatementButton.disabled = !editable;
  elements.renameSnapshotButton.disabled = !state.permissions.canEdit;
  elements.deleteSnapshotButton.disabled = !editable;
  elements.importReceiptsButton.disabled = !editable;
  elements.clearReceiptsButton.disabled = !editable || snapshot.receipts.length === 0;

  const contractChanged = snapshot.contractAmountChanged;
  elements.contractChangedNotice.classList.toggle("hidden", !contractChanged);
  if (contractChanged) {
    elements.contractChangedDetail.textContent =
      `이 버전 ${formatWon(snapshot.contractAmount)} · 현재 프로젝트 ${formatWon(snapshot.projectContractAmount)}`;
    elements.refreshContractButton.disabled = !editable;
  }

  renderStatementRows();
  renderReceipts();
  renderSummary();
}

/** 요약 카드와 합계 행처럼 입력값에서 파생되는 부분만 다시 그립니다. */
function renderSummary() {
  const snapshot = state.snapshot;
  const totals = currentTotals();
  elements.contractAmount.textContent = formatWon(snapshot.contractAmount);
  elements.executionBudget.textContent = formatWon(totals.executionBudget);
  elements.budgetBalance.textContent = `예산잔액 ${formatWon(totals.balanceAmount)}`;
  elements.purchaseAmount.textContent = formatWon(totals.purchaseAmount);
  const profitAmount = snapshot.contractAmount - totals.purchaseAmount;
  const profitRate = snapshot.contractAmount === 0 ? 0 : (profitAmount / snapshot.contractAmount) * 100;
  elements.profitAmount.textContent = formatWon(profitAmount);
  elements.profitRate.textContent = `이익률 ${formatPercent(profitRate)}`;

  elements.statementTotals.innerHTML = `
    <tr>
      <td colspan="3">전체 합계</td>
      <td class="number-cell">${formatWon(totals.executionBudget)}</td>
      <td class="number-cell">${formatWon(totals.purchaseAmount)}</td>
      <td class="number-cell">${amountCellMarkup(totals.balanceAmount)}</td>
      <td>${progressMarkup(totals.executionRate, "total-progress")}</td>
      <td></td>
    </tr>`;
  applyProgressWidths(elements.statementTotals);
}

/** 화면 입력값을 반영한 현재 기준 라인 목록. 저장 전에도 합계가 즉시 맞습니다. */
function currentLines() {
  if (!state.snapshot) return [];
  const budgetByLine = new Map();
  for (const row of elements.statementRows.querySelectorAll(".statement-line")) {
    const input = row.querySelector(".budget-input");
    if (input) budgetByLine.set(Number(row.dataset.lineId), parseBudgetInput(input.value));
  }
  return state.snapshot.lines.map((line) => {
    const executionBudget = budgetByLine.has(line.id) ? budgetByLine.get(line.id) : line.executionBudget;
    return { ...line, ...calculateBudget(executionBudget, line.purchaseAmount) };
  });
}

function currentTotals() {
  return calculateExecutionTotals(currentLines());
}

function renderStatementRows() {
  const snapshot = state.snapshot;
  const editable = snapshot.status === SNAPSHOT_STATUS.DRAFT && state.permissions.canEdit;
  if (snapshot.lines.length === 0) {
    elements.statementRows.innerHTML = '<tr><td class="empty-row" colspan="8">이 버전에 포함된 중분류가 없습니다.</td></tr>';
    return;
  }
  const groups = groupExecutionLines(snapshot.lines);
  elements.statementRows.innerHTML = groups.map((group) => {
    const lines = group.lines.map((line, index) => `
      <tr class="statement-line" data-line-id="${line.id}">
        ${index === 0 ? `<th scope="rowgroup" class="major-cell merged-major-cell" rowspan="${group.lines.length}">${escapeHtml(group.majorName)}</th>` : ""}
        <td class="middle-cell">${escapeHtml(line.middleName)}</td>
        <td><span class="item-count ${line.items.length ? "" : "missing"}">${itemCountText(line.items)}</span></td>
        <td class="number-cell">
          <label class="visually-hidden" for="budget-${line.id}">${escapeHtml(line.middleName)} 실행예산</label>
          <input id="budget-${line.id}" class="inline-input budget-input" type="text" inputmode="numeric" autocomplete="off"
                 value="${Number(line.executionBudget).toLocaleString("ko-KR")}" ${editable ? "" : "disabled"}>
        </td>
        <td class="number-cell purchase-cell">${formatWon(line.purchaseAmount)}</td>
        <td class="number-cell balance-cell">${amountCellMarkup(line.balanceAmount)}</td>
        <td class="rate-cell">${progressMarkup(line.executionRate)}</td>
        <td>
          <label class="visually-hidden" for="remark-${line.id}">${escapeHtml(line.middleName)} 비고</label>
          <input id="remark-${line.id}" class="inline-input remark-input" value="${escapeHtml(line.remark)}" maxlength="200" ${editable ? "" : "disabled"}>
        </td>
      </tr>`).join("");
    return `${lines}
      <tr class="group-subtotal" data-subtotal="${escapeHtml(group.majorName)}">
        <td colspan="3"><strong>${escapeHtml(group.majorName)} 소계</strong><span>중분류 ${group.lines.length.toLocaleString("ko-KR")}개</span></td>
        <td class="number-cell subtotal-budget">${formatWon(group.totals.executionBudget)}</td>
        <td class="number-cell subtotal-purchase">${formatWon(group.totals.purchaseAmount)}</td>
        <td class="number-cell subtotal-balance">${amountCellMarkup(group.totals.balanceAmount)}</td>
        <td class="subtotal-rate">${progressMarkup(group.totals.executionRate, "subtotal-progress")}</td>
        <td></td>
      </tr>`;
  }).join("");
  applyProgressWidths(elements.statementRows);
  attachStatementInputEvents();
}

/**
 * 입력 중에도 잔액 · 집행률 · 소계 · 합계가 바로 맞도록 파생 셀만 갱신합니다.
 * 입력 요소 자체는 건드리지 않으므로 포커스와 커서가 유지됩니다.
 */
function refreshDerivedCells() {
  if (!state.snapshot) return;
  const lines = currentLines();
  const lineById = new Map(lines.map((line) => [line.id, line]));
  for (const row of elements.statementRows.querySelectorAll(".statement-line")) {
    const line = lineById.get(Number(row.dataset.lineId));
    if (!line) continue;
    row.querySelector(".purchase-cell").textContent = formatWon(line.purchaseAmount);
    row.querySelector(".balance-cell").innerHTML = amountCellMarkup(line.balanceAmount);
    row.querySelector(".rate-cell").innerHTML = progressMarkup(line.executionRate);
  }
  for (const group of groupExecutionLines(lines)) {
    const row = elements.statementRows.querySelector(`[data-subtotal="${CSS.escape(group.majorName)}"]`);
    if (!row) continue;
    row.querySelector(".subtotal-budget").textContent = formatWon(group.totals.executionBudget);
    row.querySelector(".subtotal-purchase").textContent = formatWon(group.totals.purchaseAmount);
    row.querySelector(".subtotal-balance").innerHTML = amountCellMarkup(group.totals.balanceAmount);
    row.querySelector(".subtotal-rate").innerHTML = progressMarkup(group.totals.executionRate, "subtotal-progress");
  }
  applyProgressWidths(elements.statementRows);
  renderSummary();
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
        setDirty(true);
        refreshDerivedCells();
      });
      input.addEventListener("blur", () => formatBudgetInput(input));
    } else {
      input.addEventListener("input", () => setDirty(true));
    }
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      if (input.classList.contains("budget-input")) formatBudgetInput(input);
      const currentIndex = inputs.indexOf(input);
      const nextInput = inputs[event.shiftKey ? currentIndex - 1 : currentIndex + 1];
      if (nextInput) {
        nextInput.focus();
        nextInput.select();
      } else if (!event.shiftKey) {
        elements.saveStatementButton.focus();
      }
    });
  }
}

function renderReceipts() {
  const receipts = state.snapshot.receipts;
  const editable = state.snapshot.status === SNAPSHOT_STATUS.DRAFT && state.permissions.canEdit;
  elements.receiptCount.textContent = `${receipts.length.toLocaleString("ko-KR")}건`;
  elements.receiptSkipNotice.textContent = state.receiptSkipNotice;
  elements.receiptSkipNotice.classList.toggle("hidden", !state.receiptSkipNotice);
  elements.receiptRows.innerHTML = receipts.length ? receipts.map((receipt) => `
    <tr data-receipt-id="${receipt.id}">
      <td>${escapeHtml(receipt.receiptDate)}</td>
      <td>${escapeHtml(receipt.receiptNo)}</td>
      <td>${escapeHtml(receipt.itemCode)}</td>
      <td>${escapeHtml(receipt.itemName)}</td>
      <td class="number-cell">${formatWon(receipt.amount)}</td>
      <td class="number-cell">${formatWon(receipt.vatAmount)}</td>
      <td class="editor-only"><button class="row-action danger delete-receipt" ${editable ? "" : "disabled"}>삭제</button></td>
    </tr>
  `).join("") : '<tr><td class="empty-row" colspan="7">불러온 입고 내역이 없습니다.</td></tr>';

  elements.receiptRows.querySelectorAll(".delete-receipt").forEach((button) => {
    button.addEventListener("click", () => deleteReceipt(Number(button.closest("tr").dataset.receiptId)));
  });
}

// ------------------------------------------------------------------ 집행서 동작

async function saveStatement() {
  const lines = [...elements.statementRows.querySelectorAll(".statement-line")].map((row) => ({
    id: Number(row.dataset.lineId),
    executionBudget: parseBudgetInput(row.querySelector(".budget-input").value),
    remark: row.querySelector(".remark-input").value,
  }));
  const activeElementId = document.activeElement?.id;
  try {
    state.snapshot = await busy(() => api(`/api/snapshots/${state.snapshot.id}/lines`, {
      method: "PUT",
      body: JSON.stringify({ lines, expectedRevision: state.snapshot.revision }),
    }));
  } catch (error) {
    if (error.code === "STALE") await ignoreFailure(loadSnapshots(state.snapshot.id));
    return;
  }
  setDirty(false);
  // 표를 통째로 다시 그리지 않고 금액 칸만 갱신해, 입력하던 자리를 잃지 않게 합니다.
  refreshDerivedCells();
  elements.snapshotDate.textContent = `저장 ${formatDateTime(state.snapshot.updatedAt)}`;
  if (activeElementId) document.getElementById(activeElementId)?.focus();
  showToast(`${lines.length.toLocaleString("ko-KR")}개 중분류의 실행예산과 비고를 저장했습니다.`);
}

async function createSnapshot(cloneCurrent = false) {
  if (!state.selectedProjectId) return showToast("먼저 프로젝트를 선택해 주세요.", true);
  if (!await confirmDiscardChanges()) return;
  const body = cloneCurrent && state.snapshot
    ? { cloneSnapshotId: state.snapshot.id }
    : { categorySetId: Number(elements.snapshotCategorySet.value) || null };
  const created = await busy(() => api(`/api/projects/${state.selectedProjectId}/snapshots`, { method: "POST", body: JSON.stringify(body) }));
  await loadSnapshots(created.id);
  showToast(cloneCurrent ? "이전 내용을 복제해 새 버전을 만들었습니다." : "현재 설정으로 새 버전을 만들었습니다.");
}

async function renameSnapshot() {
  const title = await askText({
    title: "버전 이름 변경",
    label: "버전 이름",
    initial: state.snapshot.title,
  });
  if (!title) return;
  state.snapshot = await busy(() => api(`/api/snapshots/${state.snapshot.id}`, { method: "PATCH", body: JSON.stringify({ title }) }));
  await loadSnapshots(state.snapshot.id);
  showToast("버전 이름을 변경했습니다.");
}

async function deleteSnapshot() {
  const snapshot = state.snapshot;
  const confirmed = await askConfirm({
    title: "버전 삭제",
    message: `v${snapshot.versionNo} '${snapshot.title}' 버전과 입력한 실행예산, 불러온 입고 내역이 모두 지워집니다. 삭제할까요?`,
    confirmLabel: "삭제",
    danger: true,
  });
  if (!confirmed) return;
  await busy(() => api(`/api/snapshots/${snapshot.id}`, { method: "DELETE" }));
  setDirty(false);
  await loadSnapshots();
  showToast("버전을 삭제했습니다.");
}

async function confirmSnapshot() {
  if (state.dirty) return showToast("먼저 변경 내용을 저장한 뒤 확정해 주세요.", true);
  const confirmed = await askConfirm({
    title: "버전 확정",
    message: "확정하면 이 버전의 실행예산, 입고 내역, 계약금액이 더 이상 바뀌지 않습니다. 이후 수정은 새 버전에서 진행해야 합니다. 확정할까요?",
    confirmLabel: "확정",
  });
  if (!confirmed) return;
  state.snapshot = await busy(() => api(`/api/snapshots/${state.snapshot.id}/status`, {
    method: "PUT",
    body: JSON.stringify({ status: SNAPSHOT_STATUS.CONFIRMED }),
  }));
  await loadSnapshots(state.snapshot.id);
  showToast("버전을 확정했습니다. 이후 변경은 새 버전에서 진행해 주세요.");
}

async function refreshContractAmount() {
  const confirmed = await askConfirm({
    title: "계약금액 반영",
    message: `이 버전의 계약금액을 프로젝트의 현재 금액(${formatWon(state.snapshot.projectContractAmount)})으로 바꿉니다. 계속할까요?`,
    confirmLabel: "반영",
  });
  if (!confirmed) return;
  state.snapshot = await busy(() => api(`/api/snapshots/${state.snapshot.id}/contract-amount/refresh`, { method: "POST" }));
  renderSnapshot();
  showToast("계약금액을 이 버전에 반영했습니다.");
}

async function importReceipts() {
  if (state.dirty && !await confirmDiscardChanges()) return;
  const result = await busy(() => api(`/api/snapshots/${state.snapshot.id}/receipts/import`, {
    method: "POST",
    body: JSON.stringify({
      fromDate: elements.fromDate.value,
      toDate: elements.toDate.value,
      replace: elements.replaceReceipts.checked,
    }),
  }));
  state.snapshot = result.snapshot;
  state.receiptSkipNotice = result.skippedCount
    ? `설정에 없는 품번 ${result.skippedCount.toLocaleString("ko-KR")}건은 제외했습니다${result.skippedItemCodes.length ? ` (${result.skippedItemCodes.slice(0, 5).join(", ")}${result.skippedItemCodes.length > 5 ? " 외" : ""})` : ""}.`
    : "";
  setDirty(false);
  renderSnapshot();
  showToast(`${result.importedCount.toLocaleString("ko-KR")}건의 입고금액을 반영했습니다.`);
}

async function clearReceipts() {
  const confirmed = await askConfirm({
    title: "입고 내역 전체 삭제",
    message: `이 버전에 반영된 입고 ${state.snapshot.receipts.length.toLocaleString("ko-KR")}건을 모두 지웁니다. 매입금액이 0원이 됩니다. 삭제할까요?`,
    confirmLabel: "삭제",
    danger: true,
  });
  if (!confirmed) return;
  const result = await busy(() => api(`/api/snapshots/${state.snapshot.id}/receipts`, { method: "DELETE" }));
  state.snapshot = result.snapshot;
  state.receiptSkipNotice = "";
  renderSnapshot();
  showToast(`입고 내역 ${result.deletedCount.toLocaleString("ko-KR")}건을 삭제했습니다.`);
}

async function deleteReceipt(receiptId) {
  const result = await busy(() => api(`/api/snapshots/${state.snapshot.id}/receipts/${receiptId}`, { method: "DELETE" }));
  state.snapshot = result.snapshot;
  renderSnapshot();
  showToast("입고 내역 1건을 삭제했습니다.");
}

// ------------------------------------------------------------------ 인쇄용 보고서

function renderPrintReport() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const lines = currentLines();
  const groups = groupExecutionLines(lines);
  const overallTotals = calculateExecutionTotals(lines);
  const profitAmount = snapshot.contractAmount - overallTotals.purchaseAmount;
  const profitRate = snapshot.contractAmount === 0 ? 0 : (profitAmount / snapshot.contractAmount) * 100;

  const detailRows = groups.map((group) => {
    const rows = group.lines.map((line, index) => `
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
    return `${rows}
      <tr class="print-subtotal">
        <td colspan="3">${escapeHtml(group.majorName)} 소계 · 중분류 ${group.lines.length.toLocaleString("ko-KR")}개</td>
        <td class="print-number">${formatWon(group.totals.executionBudget)}</td>
        <td class="print-number">${formatWon(group.totals.purchaseAmount)}</td>
        <td class="print-number ${group.totals.balanceAmount < 0 ? "negative" : ""}">${formatWon(group.totals.balanceAmount)}</td>
        <td class="print-number">${formatPercent(group.totals.executionRate)}</td>
        <td></td>
      </tr>`;
  }).join("");

  const confirmedNote = snapshot.confirmedBy
    ? `확정 ${escapeHtml(snapshot.confirmedBy)} · ${formatDateTime(snapshot.confirmedAt)}`
    : `작성 ${escapeHtml(snapshot.createdBy || "-")}`;

  elements.printReport.innerHTML = `
    <div class="print-report-header">
      <div class="print-title-block"><span>PROJECT EXECUTION REPORT</span><h1>기 성 집 행 서</h1></div>
      <table class="approval-table"><thead><tr><th>작성</th><th>검토</th><th>승인</th></tr></thead><tbody><tr><td></td><td></td><td></td></tr></tbody></table>
    </div>
    <table class="print-meta-table">
      <tr>
        <th>프로젝트</th><td>${escapeHtml(snapshot.projectCode)} · ${escapeHtml(snapshot.projectName)}</td>
        <th>버전</th><td>v${snapshot.versionNo} · ${REPORT_STATUS_LABEL[snapshot.status]}</td>
        <th>저장일</th><td>${formatDateTime(snapshot.updatedAt)}</td>
      </tr>
      <tr>
        <th>분류 설정</th><td colspan="5">${escapeHtml(snapshot.categorySetLabel || "-")}</td>
      </tr>
    </table>
    <div class="print-summary">
      <div><span>계약금액</span><strong>${formatWon(snapshot.contractAmount)}</strong></div>
      <div><span>실행예산</span><strong>${formatWon(overallTotals.executionBudget)}</strong></div>
      <div><span>누적 매입금액</span><strong>${formatWon(overallTotals.purchaseAmount)}</strong></div>
      <div><span>예상 이익</span><strong>${formatWon(profitAmount)}</strong></div>
      <div><span>예상 이익률</span><strong>${formatPercent(profitRate)}</strong></div>
    </div>
    <table class="print-detail-table">
      <colgroup><col class="print-col-major"><col class="print-col-middle"><col class="print-col-items"><col class="print-col-money"><col class="print-col-money"><col class="print-col-money"><col class="print-col-rate"><col></colgroup>
      <thead><tr><th>대분류</th><th>중분류</th><th>연결 품번</th><th>실행예산</th><th>매입금액 소계</th><th>예산잔액</th><th>집행률</th><th>비고</th></tr></thead>
      <tbody>${detailRows || '<tr><td colspan="8" class="print-empty">이 버전에 포함된 중분류가 없습니다.</td></tr>'}</tbody>
      <tfoot><tr>
        <td colspan="3">전체 합계</td>
        <td class="print-number">${formatWon(overallTotals.executionBudget)}</td>
        <td class="print-number">${formatWon(overallTotals.purchaseAmount)}</td>
        <td class="print-number ${overallTotals.balanceAmount < 0 ? "negative" : ""}">${formatWon(overallTotals.balanceAmount)}</td>
        <td class="print-number">${formatPercent(overallTotals.executionRate)}</td>
        <td></td>
      </tr></tfoot>
    </table>
    <div class="print-report-footer">
      <span>연결 품번은 상세 코드 대신 중분류별 건수로 표기했습니다. · ${confirmedNote}</span>
      <span>출력 ${formatDateTime(new Date())} · ${escapeHtml(state.user?.name || "")}</span>
    </div>`;
}

// ------------------------------------------------------------------ 분류 설정

// ------------------------------------------------------------------ 설정 버전(세트)

function currentCategorySet() {
  return state.categorySets.find((set) => set.id === Number(state.selectedCategorySetId)) || null;
}

function categorySetLabel(set) {
  return `v${set.versionNo} · ${set.title}`;
}

function renderCategorySets() {
  const sets = state.categorySets;
  if (!currentCategorySet() && sets.length) {
    state.selectedCategorySetId = (sets.find((set) => set.isCurrent) || sets[0]).id;
  }
  const selected = currentCategorySet();

  elements.categorySetSelect.innerHTML = sets.map((set) => `
    <option value="${set.id}">${escapeHtml(categorySetLabel(set))}${set.isCurrent ? " (사용 중)" : ""}</option>
  `).join("");
  elements.categorySetSelect.value = String(state.selectedCategorySetId || "");

  elements.categorySetBadge.textContent = selected?.isCurrent ? "사용 중" : "보관";
  elements.categorySetBadge.className = `badge ${selected?.isCurrent ? "confirmed" : "draft"}`;
  elements.categorySetMeta.textContent = selected
    ? `대분류 ${selected.majorCount} · 중분류 ${selected.middleCount} · 품번 ${selected.itemCount}`
      + ` · 이 설정으로 만든 집행서 ${selected.snapshotCount}건`
      + ` · 수정 ${formatDateTime(selected.updatedAt)}`
    : "";

  const notCurrent = Boolean(selected && !selected.isCurrent);
  elements.categorySetNotice.classList.toggle("hidden", !notCurrent);
  elements.useCategorySetButton.disabled = !notCurrent;
  elements.deleteCategorySetButton.disabled = !selected || selected.isCurrent || selected.snapshotCount > 0 || sets.length <= 1;

  // 집행서 화면에서 새 버전에 쓸 설정 선택
  elements.snapshotCategorySet.innerHTML = sets.map((set) => `
    <option value="${set.id}">${escapeHtml(categorySetLabel(set))}${set.isCurrent ? " (사용 중)" : ""}</option>
  `).join("");
  const preferred = sets.find((set) => set.isCurrent) || sets[0];
  if (preferred) elements.snapshotCategorySet.value = String(preferred.id);
  elements.snapshotCategorySetField.classList.toggle("hidden", sets.length <= 1);
}

async function refreshCategorySets(preferredId = null) {
  state.categorySets = await api(API.CATEGORY_SETS);
  if (preferredId) state.selectedCategorySetId = preferredId;
  renderCategorySets();
}

async function loadSelectedCategorySet() {
  state.categories = await api(`${API.CATEGORIES}?categorySetId=${state.selectedCategorySetId}`);
  state.selectedMajorId = null;
  state.selectedMiddleId = null;
  elements.itemSearchResults.classList.add("hidden");
  renderSettings();
}

async function createCategorySet(clone) {
  const source = currentCategorySet();
  const title = await askText({
    title: clone ? "설정 버전 복제" : "새 설정 버전",
    label: "설정 버전 이름",
    initial: clone && source ? `${source.title} 복사본` : "",
    confirmLabel: "만들기",
  });
  if (!title) return;
  const result = await busy(() => api(API.CATEGORY_SETS, {
    method: "POST",
    body: JSON.stringify({ title, cloneFromId: clone ? state.selectedCategorySetId : null }),
  }));
  state.categorySets = result.sets;
  state.selectedCategorySetId = result.set.id;
  renderCategorySets();
  await loadSelectedCategorySet();
  showToast(`설정 ${categorySetLabel(result.set)} 을(를) 만들었습니다. 아직 '사용 중'은 아닙니다.`);
}

async function renameCategorySet() {
  const set = currentCategorySet();
  if (!set) return;
  const title = await askText({ title: "설정 버전 이름 변경", label: "설정 버전 이름", initial: set.title });
  if (!title || title === set.title) return;
  const result = await busy(() => api(`${API.CATEGORY_SETS}/${set.id}`, { method: "PATCH", body: JSON.stringify({ title }) }));
  state.categorySets = result.sets;
  renderCategorySets();
  showToast("설정 버전 이름을 변경했습니다.");
}

async function useCategorySet() {
  const set = currentCategorySet();
  if (!set || set.isCurrent) return;
  const confirmed = await askConfirm({
    title: "사용 중으로 지정",
    message: `${categorySetLabel(set)} 을(를) 사용 중 설정으로 지정합니다. 앞으로 집행서를 새로 만들면 이 설정이 복사됩니다.`
      + " 이미 만들어진 집행서는 각자 만들어질 때의 설정을 그대로 유지합니다.",
    confirmLabel: "지정",
  });
  if (!confirmed) return;
  const result = await busy(() => api(`${API.CATEGORY_SETS}/${set.id}/current`, { method: "POST", body: "{}" }));
  state.categorySets = result.sets;
  renderCategorySets();
  showToast(`${categorySetLabel(result.set)} 을(를) 사용 중으로 지정했습니다.`);
}

async function deleteCategorySet() {
  const set = currentCategorySet();
  if (!set) return;
  const confirmed = await askConfirm({
    title: "설정 버전 삭제",
    message: `${categorySetLabel(set)} 과(와) 그 안의 대분류 ${set.majorCount}개 · 중분류 ${set.middleCount}개 · 품번 ${set.itemCount}개를 삭제합니다.`
      + " 이 설정으로 만든 집행서가 없을 때만 지울 수 있습니다. 삭제할까요?",
    confirmLabel: "삭제",
    danger: true,
  });
  if (!confirmed) return;
  const result = await busy(() => api(`${API.CATEGORY_SETS}/${set.id}`, { method: "DELETE" }));
  state.categorySets = result.sets;
  state.selectedCategorySetId = null;
  renderCategorySets();
  await loadSelectedCategorySet();
  showToast("설정 버전을 삭제했습니다.");
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
  elements.majorList.innerHTML = state.categories.length ? state.categories.map((major, index) => `
    <div class="master-row ${major.id === Number(state.selectedMajorId) ? "selected" : ""}" data-major-id="${major.id}">
      <button class="select-major">${escapeHtml(major.name)}</button>
      <span class="count" title="중분류 수">${major.middleCategories.length}</span>
      <button class="row-action move-major" data-direction="up" aria-label="위로" ${index === 0 ? "disabled" : ""}>▲</button>
      <button class="row-action move-major" data-direction="down" aria-label="아래로" ${index === state.categories.length - 1 ? "disabled" : ""}>▼</button>
      <button class="row-action edit-major">수정</button>
      <button class="row-action danger delete-major">삭제</button>
    </div>
  `).join("") : '<div class="settings-placeholder">대분류를 추가해 주세요.</div>';

  elements.majorList.querySelectorAll(".select-major").forEach((button) => button.addEventListener("click", () => {
    state.selectedMajorId = Number(button.closest(".master-row").dataset.majorId);
    state.selectedMiddleId = selectedMajor()?.middleCategories[0]?.id || null;
    elements.itemSearchResults.classList.add("hidden");
    renderSettings();
  }));
  elements.majorList.querySelectorAll(".move-major").forEach((button) => button.addEventListener("click", () =>
    moveCategory("major", Number(button.closest(".master-row").dataset.majorId), button.dataset.direction)));
  elements.majorList.querySelectorAll(".edit-major").forEach((button) => button.addEventListener("click", () => editMajor(button.closest(".master-row"))));
  elements.majorList.querySelectorAll(".delete-major").forEach((button) => button.addEventListener("click", () => deleteMajor(button.closest(".master-row"))));
}

function renderMiddleList() {
  const major = selectedMajor();
  const middles = major?.middleCategories || [];
  elements.middleList.innerHTML = middles.length ? middles.map((middle, index) => `
    <div class="master-row ${middle.id === Number(state.selectedMiddleId) ? "selected" : ""}" data-middle-id="${middle.id}">
      <button class="select-middle">${escapeHtml(middle.name)}</button>
      <span class="count" title="연결 품번 수">${middle.items.length}</span>
      <button class="row-action move-middle" data-direction="up" aria-label="위로" ${index === 0 ? "disabled" : ""}>▲</button>
      <button class="row-action move-middle" data-direction="down" aria-label="아래로" ${index === middles.length - 1 ? "disabled" : ""}>▼</button>
      <button class="row-action edit-middle">수정</button>
      <button class="row-action danger delete-middle">삭제</button>
    </div>
  `).join("") : `<div class="settings-placeholder">${major ? "중분류를 추가해 주세요." : "먼저 대분류를 선택하세요."}</div>`;

  elements.middleList.querySelectorAll(".select-middle").forEach((button) => button.addEventListener("click", () => {
    state.selectedMiddleId = Number(button.closest(".master-row").dataset.middleId);
    elements.itemSearchResults.classList.add("hidden");
    renderSettings();
  }));
  elements.middleList.querySelectorAll(".move-middle").forEach((button) => button.addEventListener("click", () =>
    moveCategory("middle", Number(button.closest(".master-row").dataset.middleId), button.dataset.direction)));
  elements.middleList.querySelectorAll(".edit-middle").forEach((button) => button.addEventListener("click", () => editMiddle(button.closest(".master-row"))));
  elements.middleList.querySelectorAll(".delete-middle").forEach((button) => button.addEventListener("click", () => deleteMiddle(button.closest(".master-row"))));
}

function renderMappedItems() {
  const middle = selectedMiddle();
  if (!middle) {
    elements.mappedItemList.innerHTML = '<div class="settings-placeholder">품번을 연결할 중분류를 선택하세요.</div>';
    return;
  }
  elements.mappedItemList.innerHTML =
    `<p class="mapped-heading">${escapeHtml(selectedMajor().name)} 〉 ${escapeHtml(middle.name)} · ${middle.items.length}개 품번</p>`
    + (middle.items.length ? middle.items.map((item) => `
      <div class="mapped-row" data-item-id="${item.id}">
        <code>${escapeHtml(item.itemCode)}</code><span>${escapeHtml(item.itemName)}</span>
        <button class="row-action danger delete-item">연결 해제</button>
      </div>`).join("")
      : '<div class="settings-placeholder">연결된 품번이 없습니다.<br>위에서 아마란스10 품번을 검색해 추가하세요.</div>');
  elements.mappedItemList.querySelectorAll(".delete-item").forEach((button) =>
    button.addEventListener("click", () => deleteItem(button.closest(".mapped-row"))));
}

async function refreshCategories() {
  state.categories = await api(`${API.CATEGORIES}?categorySetId=${state.selectedCategorySetId}`);
  await ignoreFailure(refreshCategorySets(state.selectedCategorySetId));
  renderSettings();
}

async function moveCategory(kind, id, direction) {
  const endpoint = kind === "major" ? API.MAJOR_CATEGORIES : API.MIDDLE_CATEGORIES;
  const result = await busy(() => api(`${endpoint}/${id}/move`, { method: "POST", body: JSON.stringify({ direction }) }));
  state.categories = result.categories;
  renderSettings();
}

async function addMajor() {
  const name = await askText({ title: "대분류 추가", label: "대분류명" });
  if (!name) return;
  await busy(() => api(API.MAJOR_CATEGORIES, {
    method: "POST",
    body: JSON.stringify({ name, categorySetId: state.selectedCategorySetId }),
  }));
  await refreshCategories();
  showToast("대분류를 추가했습니다.");
}

async function editMajor(row) {
  const major = state.categories.find((item) => item.id === Number(row.dataset.majorId));
  const name = await askText({ title: "대분류 수정", label: "대분류명", initial: major.name });
  if (!name || name === major.name) return;
  await busy(() => api(`${API.MAJOR_CATEGORIES}/${major.id}`, { method: "PUT", body: JSON.stringify({ name }) }));
  await refreshCategories();
  showToast("대분류를 수정했습니다.");
}

async function deleteMajor(row) {
  const major = state.categories.find((item) => item.id === Number(row.dataset.majorId));
  const confirmed = await askConfirm({
    title: "대분류 삭제",
    message: `'${major.name}' 대분류와 그 아래 중분류 ${major.middleCategories.length}개, 연결된 품번이 함께 삭제됩니다. 이미 만들어진 집행서 버전에는 영향을 주지 않습니다. 삭제할까요?`,
    confirmLabel: "삭제",
    danger: true,
  });
  if (!confirmed) return;
  await busy(() => api(`${API.MAJOR_CATEGORIES}/${major.id}`, { method: "DELETE" }));
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
  await busy(() => api(API.MIDDLE_CATEGORIES, { method: "POST", body: JSON.stringify({ majorCategoryId: major.id, name }) }));
  await refreshCategories();
  showToast("중분류를 추가했습니다.");
}

async function editMiddle(row) {
  const middle = selectedMajor().middleCategories.find((item) => item.id === Number(row.dataset.middleId));
  const name = await askText({ title: "중분류 수정", label: "중분류명", initial: middle.name });
  if (!name || name === middle.name) return;
  await busy(() => api(`${API.MIDDLE_CATEGORIES}/${middle.id}`, { method: "PUT", body: JSON.stringify({ name }) }));
  await refreshCategories();
  showToast("중분류를 수정했습니다.");
}

async function deleteMiddle(row) {
  const middle = selectedMajor().middleCategories.find((item) => item.id === Number(row.dataset.middleId));
  const confirmed = await askConfirm({
    title: "중분류 삭제",
    message: `'${middle.name}' 중분류와 연결된 품번 ${middle.items.length}개가 삭제됩니다. 이미 만들어진 집행서 버전에는 영향을 주지 않습니다. 삭제할까요?`,
    confirmLabel: "삭제",
    danger: true,
  });
  if (!confirmed) return;
  await busy(() => api(`${API.MIDDLE_CATEGORIES}/${middle.id}`, { method: "DELETE" }));
  state.selectedMiddleId = null;
  await refreshCategories();
  showToast("중분류를 삭제했습니다.");
}

async function searchItems() {
  const query = elements.itemSearchInput.value.trim();
  const result = await busy(() => api(API.ITEM_SEARCH, {
    method: "POST",
    body: JSON.stringify({ query, categorySetId: state.selectedCategorySetId }),
  }));
  elements.itemSearchResults.classList.remove("hidden");
  const notice = result.truncated
    ? '<div class="settings-placeholder">결과가 많아 일부만 표시했습니다. 검색어를 좁혀 주세요.</div>'
    : "";
  elements.itemSearchResults.innerHTML = result.items.length
    ? notice + result.items.map((item) => `
      <div class="search-result">
        <code>${escapeHtml(item.itemCode)}</code>
        <span>${escapeHtml(item.itemName)}${item.mappedTo ? `<em class="already-mapped">${escapeHtml(item.mappedTo)}에 연결됨</em>` : ""}</span>
        <button data-code="${escapeHtml(item.itemCode)}" data-name="${escapeHtml(item.itemName)}" ${item.mappedTo ? "disabled" : ""}>연결</button>
      </div>`).join("")
    : '<div class="settings-placeholder">검색 결과가 없습니다.</div>';
  elements.itemSearchResults.querySelectorAll("button:not([disabled])").forEach((button) =>
    button.addEventListener("click", () => addItem(button.dataset.code, button.dataset.name)));
}

async function addItem(itemCode, itemName) {
  const middle = selectedMiddle();
  if (!middle) return showToast("품번을 연결할 중분류를 선택해 주세요.", true);
  await busy(() => api(API.ITEM_MAPPINGS, { method: "POST", body: JSON.stringify({ middleCategoryId: middle.id, itemCode, itemName }) }));
  await refreshCategories();
  await ignoreFailure(searchItems());
  showToast(`${itemCode} 품번을 연결했습니다.`);
}

async function deleteItem(row) {
  await busy(() => api(`${API.ITEM_MAPPINGS}/${row.dataset.itemId}`, { method: "DELETE" }));
  await refreshCategories();
  showToast("품번 연결을 해제했습니다.");
}

// ------------------------------------------------------------------ 연동 · 보안 설정

async function loadIntegrationSettings() {
  const result = await api(API.AMARANCE_SETTINGS);
  state.amaranceSettings = result.amarance;
  state.ssoSettings = result.sso;
  state.securitySettings = result.security;
  renderAmaranceSettings();
  renderSecuritySettings();
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
    <span class="${settings.mode === "LIVE" ? "ready" : "pending"}">${escapeHtml(settings.mode)}</span>
    <span class="${authenticationReady ? "ready" : "pending"}">서버 인증 ${authenticationReady ? "준비" : "미완료"}</span>
    <span class="${settings.baseUrlConfigured ? "ready" : "pending"}">API 주소 ${settings.baseUrlConfigured ? "설정됨" : "미설정"}</span>`;
  elements.connectionMode.textContent = settings.mode;
}

function renderSecuritySettings() {
  const sso = state.ssoSettings;
  const security = state.securitySettings;
  if (!sso || !security) return;
  elements.ssoEnabled.checked = sso.enabled;
  elements.ssoSignatureMode.value = sso.signatureMode;
  elements.ssoUserParam.value = sso.userParam;
  elements.ssoNameParam.value = sso.nameParam;
  elements.ssoTimestampParam.value = sso.timestampParam;
  elements.ssoSignatureParam.value = sso.signatureParam;
  elements.ssoAllowedIps.value = sso.allowedIps.join(", ");
  elements.ssoAutoCreateUser.checked = sso.autoCreateUser;
  elements.ssoDefaultRole.value = sso.defaultRole;
  elements.ssoToleranceSeconds.value = sso.toleranceSeconds;
  elements.frameAncestors.value = security.frameAncestors;
  elements.cookieSameSite.value = security.cookieSameSite;
  elements.cookieSecure.checked = security.cookieSecure;
  elements.trustProxy.checked = security.trustProxy;
  elements.sessionIdleMinutes.value = security.sessionIdleMinutes;
  elements.sessionAbsoluteHours.value = security.sessionAbsoluteHours;
  elements.receiptMaxRangeDays.value = security.receiptMaxRangeDays;
  renderSsoUrlPreview();
}

function renderSsoUrlPreview() {
  const parameters = [
    `${elements.ssoUserParam.value.trim() || "userId"}={사용자ID}`,
    elements.ssoNameParam.value.trim() ? `${elements.ssoNameParam.value.trim()}={이름}` : "",
    elements.ssoTimestampParam.value.trim() ? `${elements.ssoTimestampParam.value.trim()}={timestamp}` : "",
    elements.ssoSignatureMode.value === "NONE" ? "" : `${elements.ssoSignatureParam.value.trim() || "sign"}={서명}`,
  ].filter(Boolean);
  elements.ssoUrlPreview.textContent = `${window.location.origin}/sso?${parameters.join("&")}`;
}

// ------------------------------------------------------------------ 사용자 관리

async function loadUsers() {
  const result = await api(API.USERS);
  state.users = result.users;
  renderUsers();
}

/** 검색어와 권한 필터를 적용한 사용자 목록. */
function visibleUsers() {
  const keyword = elements.userSearch.value.trim().toLowerCase();
  const role = elements.userRoleFilter.value;
  return state.users.filter((user) => {
    if (role && user.role !== role) return false;
    if (!keyword) return true;
    return user.name.toLowerCase().includes(keyword) || user.loginId.toLowerCase().includes(keyword);
  });
}

function renderUsers() {
  const users = visibleUsers();
  const total = state.users.length;
  elements.userCount.textContent = users.length === total
    ? `${total.toLocaleString("ko-KR")}명`
    : `${users.length.toLocaleString("ko-KR")} / ${total.toLocaleString("ko-KR")}명`;

  if (users.length === 0) {
    elements.userRows.innerHTML = total === 0
      ? '<tr><td class="empty-row" colspan="6">등록된 사용자가 없습니다.<br>오른쪽 위 <strong>사용자 추가</strong>로 계정을 만들어 주세요.</td></tr>'
      : '<tr><td class="empty-row" colspan="6">검색 조건에 맞는 사용자가 없습니다.</td></tr>';
    return;
  }

  elements.userRows.innerHTML = users.map((user) => {
    const isSelf = user.id === state.user.id;
    return `
    <tr data-user-id="${user.id}">
      <td>
        <div class="user-cell">
          <span class="user-cell-avatar role-${escapeHtml(user.role)}" aria-hidden="true">${escapeHtml(user.name.trim().slice(0, 1))}</span>
          <span class="user-cell-text">
            <strong>${escapeHtml(user.name)}${isSelf ? '<span class="self-tag">나</span>' : ""}</strong>
            <code>${escapeHtml(user.loginId)}</code>
          </span>
        </div>
      </td>
      <td>
        <label class="visually-hidden" for="role-${user.id}">${escapeHtml(user.name)} 권한</label>
        <select id="role-${user.id}" class="role-select" ${isSelf ? "disabled" : ""}
                title="${isSelf ? "자신의 권한은 변경할 수 없습니다." : "권한 변경"}">
          ${Object.entries(ROLE_LABEL).map(([value, label]) =>
            `<option value="${value}" ${user.role === value ? "selected" : ""}>${label}</option>`).join("")}
        </select>
      </td>
      <td><span class="pill ${user.isActive ? "on" : "off"}"><i aria-hidden="true"></i>${user.isActive ? "사용" : "중지"}</span></td>
      <td><span class="origin-tag ${user.origin === "SSO" ? "sso" : ""}">${user.origin === "SSO" ? "아마란스10 진입" : "직접 등록"}</span></td>
      <td class="muted-cell">${user.lastLoginAt ? formatDateTime(user.lastLoginAt) : "기록 없음"}</td>
      <td class="actions-column">
        <div class="row-actions">
          <button class="table-action toggle-user" ${isSelf ? "disabled" : ""}>${user.isActive ? "사용 중지" : "사용"}</button>
          <button class="table-action reset-password">비밀번호 초기화</button>
          <button class="table-action danger delete-user" ${isSelf ? "disabled" : ""}>삭제</button>
        </div>
      </td>
    </tr>`;
  }).join("");

  elements.userRows.querySelectorAll(".role-select").forEach((select) => select.addEventListener("change", () =>
    updateUser(Number(select.closest("tr").dataset.userId), { role: select.value })));
  elements.userRows.querySelectorAll(".toggle-user").forEach((button) => button.addEventListener("click", () => {
    const userId = Number(button.closest("tr").dataset.userId);
    const user = state.users.find((item) => item.id === userId);
    updateUser(userId, { isActive: !user.isActive });
  }));
  elements.userRows.querySelectorAll(".reset-password").forEach((button) => button.addEventListener("click", () =>
    resetUserPassword(Number(button.closest("tr").dataset.userId))));
  elements.userRows.querySelectorAll(".delete-user").forEach((button) => button.addEventListener("click", () =>
    deleteUser(Number(button.closest("tr").dataset.userId))));
}

async function updateUser(userId, changes) {
  const user = state.users.find((item) => item.id === userId);
  try {
    await busy(() => api(`${API.USERS}/${userId}`, {
      method: "PUT",
      body: JSON.stringify({ name: user.name, role: user.role, isActive: user.isActive, ...changes }),
    }));
    showToast("사용자 정보를 변경했습니다.");
  } finally {
    await ignoreFailure(loadUsers());
  }
}

async function resetUserPassword(userId) {
  const user = state.users.find((item) => item.id === userId);
  const confirmed = await askConfirm({
    title: "비밀번호 초기화",
    message: `'${user.name}(${user.loginId})' 계정의 비밀번호를 임시 비밀번호로 바꾸고, 로그인된 모든 기기에서 로그아웃시킵니다. 계속할까요?`,
    confirmLabel: "초기화",
    danger: true,
  });
  if (!confirmed) return;
  const result = await busy(() => api(`${API.USERS}/${userId}/password/reset`, { method: "POST" }));
  await showNotice({
    title: "임시 비밀번호",
    message: "아래 비밀번호를 본인에게 직접 전달해 주세요. 이 창을 닫으면 다시 확인할 수 없습니다.",
    value: result.temporaryPassword,
  });
  await ignoreFailure(loadUsers());
}

async function deleteUser(userId) {
  const user = state.users.find((item) => item.id === userId);
  const confirmed = await askConfirm({
    title: "사용자 삭제",
    message: `'${user.name}(${user.loginId})' 계정을 삭제합니다. 활동 기록은 남습니다. 삭제할까요?`,
    confirmLabel: "삭제",
    danger: true,
  });
  if (!confirmed) return;
  await busy(() => api(`${API.USERS}/${userId}`, { method: "DELETE" }));
  await loadUsers();
  showToast("사용자를 삭제했습니다.");
}

function showUserDialogError(message) {
  elements.userDialogError.textContent = message;
  elements.userDialogError.hidden = !message;
}

elements.userDialogForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showUserDialogError("");
  const body = {
    loginId: elements.userDialogLoginId.value.trim(),
    name: elements.userDialogName.value.trim(),
    role: elements.userDialogRole.value,
  };
  if (!body.loginId || !body.name) {
    showUserDialogError("로그인 ID와 이름을 입력해 주세요.");
    return;
  }
  try {
    const result = await api(API.USERS, { method: "POST", body: JSON.stringify(body) });
    elements.userDialog.close("done");
    await showNotice({
      title: "사용자를 추가했습니다",
      message: `'${result.user.name}' 계정의 임시 비밀번호입니다. 본인에게 직접 전달해 주세요. 첫 로그인 시 변경하게 됩니다.`,
      value: result.temporaryPassword,
    });
    await ignoreFailure(loadUsers());
  } catch (error) {
    showUserDialogError(error.message);
  }
});

// ------------------------------------------------------------------ 활동 기록

async function loadAuditLogs(offset = state.auditOffset) {
  const parameters = new URLSearchParams({ limit: String(AUDIT_PAGE_SIZE), offset: String(Math.max(0, offset)) });
  const loginId = elements.auditLoginFilter.value.trim();
  if (loginId) parameters.set("loginId", loginId);
  const result = await api(`${API.AUDIT_LOGS}?${parameters}`);
  state.auditOffset = Math.max(0, offset);
  state.auditTotal = result.total;
  elements.auditRows.innerHTML = result.rows.length ? result.rows.map((log) => `
    <tr>
      <td>${formatDateTime(log.createdAt)}</td>
      <td>${escapeHtml(log.userName || "-")}<small>${escapeHtml(log.loginId)}</small></td>
      <td>${escapeHtml(AUDIT_ACTION_LABEL[log.action] || log.action)}</td>
      <td>${escapeHtml(log.targetType)}${log.targetId ? ` #${escapeHtml(log.targetId)}` : ""}</td>
      <td>${escapeHtml(log.detail)}</td>
      <td><code>${escapeHtml(log.ip)}</code></td>
    </tr>`).join("") : '<tr><td class="empty-row" colspan="6">기록이 없습니다.</td></tr>';
  const first = result.total === 0 ? 0 : state.auditOffset + 1;
  const last = Math.min(state.auditOffset + AUDIT_PAGE_SIZE, result.total);
  elements.auditRangeLabel.textContent = `${first.toLocaleString("ko-KR")}–${last.toLocaleString("ko-KR")} / ${result.total.toLocaleString("ko-KR")}건`;
  elements.auditPrevButton.disabled = state.auditOffset === 0;
  elements.auditNextButton.disabled = last >= result.total;
}

// ------------------------------------------------------------------ 이벤트 연결

document.querySelectorAll(".nav-item").forEach((button) =>
  button.addEventListener("click", () => ignoreFailure(setScreen(button.dataset.screen))));

elements.projectFilter.addEventListener("input", () => renderProjects());
elements.projectSelect.addEventListener("change", async () => {
  const nextId = Number(elements.projectSelect.value);
  if (!await confirmDiscardChanges()) {
    elements.projectSelect.value = String(state.selectedProjectId || "");
    return;
  }
  state.selectedProjectId = nextId;
  state.receiptSkipNotice = "";
  renderProjects();
  await ignoreFailure(busy(() => loadSnapshots()));
});
elements.snapshotSelect.addEventListener("change", async () => {
  const nextId = elements.snapshotSelect.value;
  if (!await confirmDiscardChanges()) {
    elements.snapshotSelect.value = String(state.snapshot?.id || "");
    return;
  }
  state.receiptSkipNotice = "";
  state.snapshot = await busy(() => api(`/api/snapshots/${nextId}`));
  setDirty(false);
  renderSnapshot();
});

elements.newSnapshotButton.addEventListener("click", () => ignoreFailure(createSnapshot(false)));
elements.emptyNewSnapshotButton.addEventListener("click", () => ignoreFailure(createSnapshot(false)));
elements.cloneSnapshotButton.addEventListener("click", () => ignoreFailure(createSnapshot(true)));
elements.renameSnapshotButton.addEventListener("click", () => ignoreFailure(renameSnapshot()));
elements.deleteSnapshotButton.addEventListener("click", () => ignoreFailure(deleteSnapshot()));
elements.toggleSnapshotStatusButton.addEventListener("click", () => ignoreFailure(confirmSnapshot()));
elements.refreshContractButton.addEventListener("click", () => ignoreFailure(refreshContractAmount()));
elements.importReceiptsButton.addEventListener("click", () => ignoreFailure(importReceipts()));
elements.clearReceiptsButton.addEventListener("click", () => ignoreFailure(clearReceipts()));
elements.saveStatementButton.addEventListener("click", () => ignoreFailure(saveStatement()));

elements.printStatementButton.addEventListener("click", () => {
  renderPrintReport();
  window.print();
});
elements.exportExcelButton.addEventListener("click", () => {
  if (!state.snapshot) return;
  if (state.dirty) showToast("저장하지 않은 변경은 파일에 포함되지 않습니다.", true);
  window.location.assign(`/api/snapshots/${state.snapshot.id}/export.xlsx`);
});
elements.syncProjectsButton.addEventListener("click", async () => {
  if (!await confirmDiscardChanges()) return;
  await ignoreFailure(busy(async () => {
    const result = await api(API.PROJECT_SYNC, { method: "POST", body: "{}" });
    state.projects = result.projects;
    renderProjects();
    await loadSnapshots();
    reportSyncResult(result.summary);
  }));
});

/** 동기화 결과를 건수로 알려, 0건을 성공으로 오해하지 않게 합니다. */
function reportSyncResult(summary) {
  const parts = [];
  if (summary.created) parts.push(`추가 ${summary.created.toLocaleString("ko-KR")}건`);
  if (summary.updated) parts.push(`갱신 ${summary.updated.toLocaleString("ko-KR")}건`);
  if (summary.archived) parts.push(`보관 ${summary.archived.toLocaleString("ko-KR")}건`);
  if (summary.removed) parts.push(`삭제 ${summary.removed.toLocaleString("ko-KR")}건`);

  if (summary.received === 0) {
    const detail = parts.length ? ` (${parts.join(" · ")})` : "";
    showNotice({
      title: "아마란스10에서 프로젝트를 0건 받았습니다",
      message: "연결은 성공했지만 조회 결과가 비어 있습니다."
        + " 아마란스10에 등록된 프로젝트가 없거나, 회사코드 또는 연동 계정의 조회 권한을 확인해야 합니다."
        + ` 화면에 남아 있던 프로젝트는 정리했습니다${detail}.`
        + " 집행서가 작성된 프로젝트는 기록 보존을 위해 삭제하지 않고 '보관'으로 표시했습니다.",
    });
    return;
  }
  showToast(`프로젝트 ${summary.received.toLocaleString("ko-KR")}건을 받았습니다${parts.length ? ` · ${parts.join(" · ")}` : ""}.`);
}

elements.categorySetSelect.addEventListener("change", async () => {
  state.selectedCategorySetId = Number(elements.categorySetSelect.value);
  renderCategorySets();
  await ignoreFailure(busy(() => loadSelectedCategorySet()));
});
elements.newCategorySetButton.addEventListener("click", () => ignoreFailure(createCategorySet(false)));
elements.cloneCategorySetButton.addEventListener("click", () => ignoreFailure(createCategorySet(true)));
elements.renameCategorySetButton.addEventListener("click", () => ignoreFailure(renameCategorySet()));
elements.useCategorySetButton.addEventListener("click", () => ignoreFailure(useCategorySet()));
elements.noticeUseCategorySetButton.addEventListener("click", () => ignoreFailure(useCategorySet()));
elements.deleteCategorySetButton.addEventListener("click", () => ignoreFailure(deleteCategorySet()));

// ------------------------------------------------------------------ 전체 초기화

let resetConfirmPhrase = "";

elements.openResetButton.addEventListener("click", async () => {
  await ignoreFailure(busy(async () => {
    const { counts, confirmPhrase } = await api(API.RESET);
    resetConfirmPhrase = confirmPhrase;
    elements.resetPhrase.textContent = confirmPhrase;
    elements.resetConfirmInput.value = "";
    elements.resetDialogError.hidden = true;
    elements.resetDialogConfirm.disabled = true;
    elements.resetCounts.innerHTML = [
      ["집행서 버전", counts.snapshots, counts.confirmedSnapshots ? `확정 ${counts.confirmedSnapshots.toLocaleString("ko-KR")}건 포함` : ""],
      ["불러온 입고 내역", counts.receipts, ""],
      ["프로젝트", counts.projects, "다음 동기화로 다시 받아옵니다"],
    ].map(([label, count, note]) => `
      <li><span>${label}</span><strong>${Number(count).toLocaleString("ko-KR")}건</strong>${note ? `<em>${escapeHtml(note)}</em>` : ""}</li>
    `).join("");
    elements.resetDialog.showModal();
    setTimeout(() => elements.resetConfirmInput.focus(), 0);
  }));
});

// 확인 문구를 정확히 입력하기 전에는 버튼이 눌리지 않습니다.
elements.resetConfirmInput.addEventListener("input", () => {
  elements.resetDialogConfirm.disabled = elements.resetConfirmInput.value.trim() !== resetConfirmPhrase;
});

elements.resetDialogForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (elements.resetConfirmInput.value.trim() !== resetConfirmPhrase) return;
  try {
    const result = await api(API.RESET, { method: "POST", body: JSON.stringify({ confirm: resetConfirmPhrase }) });
    elements.resetDialog.close("done");
    state.projects = result.projects;
    state.snapshots = [];
    state.snapshot = null;
    state.selectedProjectId = state.projects[0]?.id || null;
    state.receiptSkipNotice = "";
    setDirty(false);
    renderProjects();
    renderSnapshot();
    await showNotice({
      title: "초기화를 완료했습니다",
      message: `집행서 ${result.removed.snapshots.toLocaleString("ko-KR")}건, 입고 내역 ${result.removed.receipts.toLocaleString("ko-KR")}건,`
        + ` 프로젝트 ${result.removed.projects.toLocaleString("ko-KR")}건을 삭제했습니다.`
        + " 분류·품번 설정과 사용자, 연동 설정은 그대로 남아 있습니다.",
    });
    await ignoreFailure(setScreen(SCREEN.STATEMENT));
  } catch (error) {
    elements.resetDialogError.textContent = error.message;
    elements.resetDialogError.hidden = false;
  }
});

elements.addMajorButton.addEventListener("click", () => ignoreFailure(addMajor()));
elements.addMiddleButton.addEventListener("click", () => ignoreFailure(addMiddle()));
elements.itemSearchButton.addEventListener("click", () => ignoreFailure(searchItems()));
elements.itemSearchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    ignoreFailure(searchItems());
  }
});

elements.amaranceSettingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await ignoreFailure(busy(async () => {
    const result = await api(API.AMARANCE_SETTINGS, {
      method: "PUT",
      body: JSON.stringify({
        mode: elements.amaranceMode.value,
        baseUrl: elements.amaranceBaseUrl.value.trim(),
        companyCode: elements.amaranceCompanyCode.value.trim(),
        callerName: elements.amaranceCallerName.value.trim(),
        accessToken: elements.amaranceAccessToken.value,
        hashKey: elements.amaranceHashKey.value,
        groupSeq: elements.amaranceGroupSeq.value.trim(),
        clearAccessToken: elements.clearAccessToken.checked,
        clearHashKey: elements.clearHashKey.checked,
      }),
    });
    state.amaranceSettings = result.amarance;
    renderAmaranceSettings();
    showToast("아마란스10 연동 설정을 저장했습니다.");
  }));
});

elements.testAmaranceButton.addEventListener("click", async () => {
  await ignoreFailure(busy(async () => {
    const result = await api(API.AMARANCE_SETTINGS_TEST, { method: "POST", body: "{}" });
    showToast(result.message);
  }));
});

elements.securitySettingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await ignoreFailure(busy(async () => {
    const result = await api(API.SECURITY_SETTINGS, {
      method: "PUT",
      body: JSON.stringify({
        sso: {
          enabled: elements.ssoEnabled.checked,
          signatureMode: elements.ssoSignatureMode.value,
          userParam: elements.ssoUserParam.value.trim(),
          nameParam: elements.ssoNameParam.value.trim(),
          timestampParam: elements.ssoTimestampParam.value.trim(),
          signatureParam: elements.ssoSignatureParam.value.trim(),
          allowedIps: elements.ssoAllowedIps.value,
          autoCreateUser: elements.ssoAutoCreateUser.checked,
          defaultRole: elements.ssoDefaultRole.value,
          toleranceSeconds: Number(elements.ssoToleranceSeconds.value),
        },
        security: {
          frameAncestors: elements.frameAncestors.value,
          cookieSameSite: elements.cookieSameSite.value,
          cookieSecure: elements.cookieSecure.checked,
          trustProxy: elements.trustProxy.checked,
          sessionIdleMinutes: Number(elements.sessionIdleMinutes.value),
          sessionAbsoluteHours: Number(elements.sessionAbsoluteHours.value),
          receiptMaxRangeDays: Number(elements.receiptMaxRangeDays.value),
        },
      }),
    });
    state.ssoSettings = result.sso;
    state.securitySettings = result.security;
    renderSecuritySettings();
    showToast("보안 설정을 저장했습니다.");
  }));
});

["ssoUserParam", "ssoNameParam", "ssoTimestampParam", "ssoSignatureParam"].forEach((id) =>
  elements[id].addEventListener("input", renderSsoUrlPreview));
elements.ssoSignatureMode.addEventListener("change", renderSsoUrlPreview);
elements.cookieSameSite.addEventListener("change", () => {
  if (elements.cookieSameSite.value === "None") elements.cookieSecure.checked = true;
});

elements.addUserButton.addEventListener("click", () => {
  elements.userDialogLoginId.value = "";
  elements.userDialogName.value = "";
  elements.userDialogRole.value = "VIEWER";
  showUserDialogError("");
  elements.userDialog.showModal();
  setTimeout(() => elements.userDialogLoginId.focus(), 0);
});

elements.userSearch.addEventListener("input", renderUsers);
elements.userRoleFilter.addEventListener("change", renderUsers);

elements.auditRefreshButton.addEventListener("click", () => ignoreFailure(loadAuditLogs(0)));
elements.auditLoginFilter.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    ignoreFailure(loadAuditLogs(0));
  }
});
elements.auditPrevButton.addEventListener("click", () => ignoreFailure(loadAuditLogs(state.auditOffset - AUDIT_PAGE_SIZE)));
elements.auditNextButton.addEventListener("click", () => ignoreFailure(loadAuditLogs(state.auditOffset + AUDIT_PAGE_SIZE)));

elements.userMenuButton.addEventListener("click", () => {
  const open = elements.userMenu.classList.toggle("hidden");
  elements.userMenuButton.setAttribute("aria-expanded", String(!open));
});
document.addEventListener("click", (event) => {
  if (elements.userMenu.classList.contains("hidden")) return;
  if (event.target.closest(".user-chip")) return;
  elements.userMenu.classList.add("hidden");
  elements.userMenuButton.setAttribute("aria-expanded", "false");
});

elements.logoutButton.addEventListener("click", async () => {
  if (!await confirmDiscardChanges()) return;
  await ignoreFailure(api(API.LOGOUT, { method: "POST", body: "{}" }));
  window.location.replace("/login");
});

elements.changePasswordButton.addEventListener("click", () => {
  elements.dialogCurrentPassword.value = "";
  elements.dialogNewPassword.value = "";
  elements.dialogConfirmPassword.value = "";
  elements.passwordDialogError.hidden = true;
  elements.userMenu.classList.add("hidden");
  elements.passwordDialog.showModal();
  setTimeout(() => elements.dialogCurrentPassword.focus(), 0);
});

elements.passwordDialogForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const newPassword = elements.dialogNewPassword.value;
  const showError = (message) => {
    elements.passwordDialogError.textContent = message;
    elements.passwordDialogError.hidden = !message;
  };
  showError("");
  if (newPassword !== elements.dialogConfirmPassword.value) {
    showError("새 비밀번호가 서로 다릅니다.");
    return;
  }
  try {
    const result = await api(API.PASSWORD, {
      method: "POST",
      body: JSON.stringify({ currentPassword: elements.dialogCurrentPassword.value, newPassword }),
    });
    state.csrfToken = result.csrfToken;
    elements.passwordDialog.close("done");
    showToast("비밀번호를 변경했습니다. 다른 기기의 로그인은 해제되었습니다.");
  } catch (error) {
    showError(error.message);
  }
});

window.addEventListener("beforeprint", renderPrintReport);

// ------------------------------------------------------------------ 시작

function showStartupFailure(message) {
  document.body.innerHTML = `
    <div class="startup-error" role="alert">
      <h1>화면을 불러오지 못했습니다</h1>
      <p>${escapeHtml(message)}</p>
      <button class="button primary" id="startupRetryButton">다시 시도</button>
    </div>`;
  document.getElementById("startupRetryButton").addEventListener("click", () => window.location.reload());
}

async function initialize() {
  const today = new Date();
  elements.today.textContent = new Intl.DateTimeFormat("ko-KR", { dateStyle: "full" }).format(today);
  elements.toDate.value = today.toISOString().slice(0, 10);
  const threeMonthsAgo = new Date(today);
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  elements.fromDate.value = threeMonthsAgo.toISOString().slice(0, 10);

  const bootstrap = await api(API.BOOTSTRAP);
  state.user = bootstrap.user;
  state.permissions = bootstrap.permissions;
  state.csrfToken = bootstrap.csrfToken;
  state.projects = bootstrap.projects;
  state.categories = bootstrap.categories;
  state.categorySets = bootstrap.categorySets || [];
  state.amaranceSettings = bootstrap.amarance;
  state.selectedProjectId = state.projects[0]?.id || null;

  applyPermissions();
  elements.connectionMode.textContent = bootstrap.amarance.mode;
  renderProjects();
  renderCategorySets();
  renderSettings();
  setDirty(false);
  await loadSnapshots();
}

initialize().catch((error) => {
  if (error.message === "로그인이 필요합니다.") return;
  showStartupFailure(error.message || "서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.");
});
