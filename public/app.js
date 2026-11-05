import { calculateBudget, calculateExecutionTotals, groupExecutionLines } from "/shared/calculations.mjs";

const API = Object.freeze({
  BOOTSTRAP: "/api/bootstrap",
  CATEGORIES: "/api/categories",
  MAJOR_CATEGORIES: "/api/major-categories",
  MIDDLE_CATEGORIES: "/api/middle-categories",
  MINOR_CATEGORIES: "/api/minor-categories",
  ITEM_MAPPINGS: "/api/item-mappings",
  ITEM_SEARCH: "/api/amarance/items/search",
  AMARANCE_SETTINGS: "/api/amarance/settings",
  AMARANCE_SETTINGS_TEST: "/api/amarance/settings/test",
  SECURITY_SETTINGS: "/api/security/settings",
  PROJECT_SYNC: "/api/projects/sync",
  PROJECTS: "/api/projects",
  PROJECT_SYNC_SCHEDULE: "/api/project-sync/schedule",
  SNAPSHOTS: "/api/snapshots",
  USERS: "/api/users",
  CATEGORY_SETS: "/api/category-sets",
  RESET: "/api/admin/reset",
  AUDIT_LOGS: "/api/audit-logs",
  LOGOUT: "/api/auth/logout",
  PASSWORD: "/api/auth/password",
});

const SNAPSHOT_STATUS = Object.freeze({ DRAFT: "DRAFT", CONFIRMED: "CONFIRMED" });
const SCREEN = Object.freeze({
  LIST: "list",
  PROJECTS: "projects",
  STATEMENT: "statement",
  SETTINGS: "settings",
  AMARANCE: "amarance",
  SECURITY: "security",
  USERS: "users",
  AUDIT: "audit",
});
/** 화면마다 탭 · 머리에 쓰는 아이콘, 이름, 한 줄 설명. */
const SCREEN_META = Object.freeze({
  list: { icon: "▦", title: "기성집행서 목록", desc: "등록된 기성집행서를 프로젝트 · 버전별로 봅니다. 줄을 누르면 탭으로 열립니다." },
  projects: { icon: "◫", title: "프로젝트", desc: "아마란스10 프로젝트를 가져오고, 자동 동기화 일정을 정합니다." },
  statement: { icon: "▤", title: "기성집행서", desc: "실행예산을 입력하고 입고 내역과 견주어 예상 이익률을 확인합니다. 저장 전 입력은 이 컴퓨터에 보관됩니다." },
  settings: { icon: "⚙", title: "분류 · 품번 설정", desc: "대분류 · 중분류 · 소분류를 만들고 품번을 연결합니다." },
  amarance: { icon: "↗", title: "아마란스10 설정", desc: "아마란스10 연결 주소와 인증 정보를 설정합니다." },
  security: { icon: "⛨", title: "접속 · 보안", desc: "접속을 허용할 주소와 로그인 보안 규칙을 정합니다." },
  users: { icon: "☺", title: "사용자", desc: "사용자를 추가하고 권한을 정합니다." },
  audit: { icon: "≡", title: "활동 기록", desc: "누가 언제 무엇을 했는지 확인합니다." },
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
  selectedMinorId: null,
  amaranceSettings: null,
  ssoSettings: null,
  securitySettings: null,
  users: [],
  auditOffset: 0,
  auditTotal: 0,
  screen: SCREEN.LIST,
  dirty: false,
  tabs: [],
  activeTabKey: null,
  drafts: {},
  statementList: [],
  projectList: [],
  projectSync: null,
  integrationLoaded: false,
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
  // 표를 내려 저장 버튼이 안 보여도 저장할 수 있게, 변경이 있으면 화면 아래에 저장 막대를 띄웁니다.
  elements.saveBar.classList.toggle("hidden", !dirty || state.screen !== SCREEN.STATEMENT);
  elements.saveHint.textContent = dirty
    ? "저장하지 않은 변경이 있습니다."
    : "실행예산과 비고를 입력한 뒤 저장하세요.";
}

function canEditSnapshot() {
  return Boolean(state.snapshot) && state.snapshot.status === SNAPSHOT_STATUS.DRAFT && state.permissions.canEdit;
}

// Ctrl+S(맥은 Cmd+S)로 집행서를 저장합니다. 브라우저의 '페이지 저장'은 막습니다.
document.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
  if (state.screen !== SCREEN.STATEMENT) return;
  event.preventDefault();
  if (canEditSnapshot() && state.dirty) ignoreFailure(saveStatement());
});

// ------------------------------------------------------------------ 화면 전환

async function setScreen(screen) {
  state.screen = screen;
  elements.saveBar.classList.toggle("hidden", !state.dirty || screen !== SCREEN.STATEMENT);
  // 집행서 화면은 '기성집행서' 메뉴 아래에 있는 것으로 표시합니다.
  const navScreen = screen === SCREEN.STATEMENT ? SCREEN.LIST : screen;
  document.querySelectorAll(".nav-item").forEach((button) => {
    const active = button.dataset.screen === navScreen;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  const sections = {
    [SCREEN.LIST]: elements.listScreen,
    [SCREEN.PROJECTS]: elements.projectsScreen,
    [SCREEN.STATEMENT]: elements.statementScreen,
    [SCREEN.SETTINGS]: elements.settingsScreen,
    [SCREEN.AMARANCE]: elements.amaranceSettingsScreen,
    [SCREEN.SECURITY]: elements.securityScreen,
    [SCREEN.USERS]: elements.usersScreen,
    [SCREEN.AUDIT]: elements.auditScreen,
  };
  for (const [name, section] of Object.entries(sections)) section.classList.toggle("active", name === screen);
  const meta = SCREEN_META[screen];
  elements.pageIcon.textContent = meta.icon;
  elements.pageTitle.textContent = meta.title;
  elements.pageDesc.textContent = meta.desc;
  document.title = `${meta.title} · 경기산업 기성집행서`;

  if (screen === SCREEN.LIST) await ignoreFailure(loadStatementList());
  if (screen === SCREEN.PROJECTS) await ignoreFailure(loadProjectList());
  if (screen === SCREEN.SETTINGS) await ignoreFailure(refreshCategorySets(state.selectedCategorySetId));
  if (screen === SCREEN.USERS) await ignoreFailure(loadUsers());
  if (screen === SCREEN.AUDIT) await ignoreFailure(loadAuditLogs(0));
  // 연동 · 보안 설정은 처음 열 때만 불러와, 탭을 오가도 고치던 값이 지워지지 않게 합니다.
  if ((screen === SCREEN.SECURITY || screen === SCREEN.AMARANCE) && !state.integrationLoaded) {
    state.integrationLoaded = true;
    await ignoreFailure(loadIntegrationSettings());
  }
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
  elements.statementProject.innerHTML = project
    ? `<span class="section-kicker">PROJECT</span><strong>${escapeHtml(project.code)}</strong><span>${escapeHtml(project.name)}</span>`
    : "";
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
  const preferred = state.snapshots.some((item) => item.id === Number(preferredSnapshotId)) ? Number(preferredSnapshotId) : null;
  const selectedId = preferred || state.snapshots[0]?.id;
  state.snapshot = selectedId ? await api(`/api/snapshots/${selectedId}`) : null;
  setDirty(false);
  renderSnapshot();
  syncStatementTab();
  if (state.dirty) showToast("저장하지 않았던 입력을 이어서 보여 줍니다. 저장하거나 '되돌리기'를 눌러 주세요.");
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
      <td colspan="4">전체 합계</td>
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
    elements.statementRows.innerHTML = '<tr><td class="empty-row" colspan="9">이 버전에 포함된 중분류가 없습니다.</td></tr>';
    return;
  }
  const groups = groupExecutionLines(snapshot.lines);
  elements.statementRows.innerHTML = groups.map((group, groupIndex) => {
    // 대분류 칸은 라인과 중분류 소계 행을 모두 덮고, 대분류 합계 행은 그 아래에 따로 둡니다.
    const majorRowSpan = group.middles.reduce((sum, middle) => sum + middle.lines.length + (middle.showSubtotal ? 1 : 0), 0);
    let majorCell = `<th scope="rowgroup" class="major-cell merged-major-cell" rowspan="${majorRowSpan}">${escapeHtml(group.majorName)}</th>`;
    const takeMajorCell = () => {
      const markup = majorCell;
      majorCell = "";
      return markup;
    };
    const middleRows = group.middles.map((middle, middleIndex) => {
      const middleRowSpan = middle.lines.length + (middle.showSubtotal ? 1 : 0);
      const lines = middle.lines.map((line, lineIndex) => {
        // 소분류가 없는 중분류는 중분류 · 소분류 두 칸을 합쳐 한 줄로 보입니다.
        const categoryCells = middle.hasMinors
          ? `${lineIndex === 0 ? `<th scope="rowgroup" class="middle-cell merged-middle-cell" rowspan="${middleRowSpan}">${escapeHtml(middle.middleName)}</th>` : ""}
             <td class="minor-cell">${escapeHtml(line.minorName)}</td>`
          : `<td class="middle-cell" colspan="2">${escapeHtml(line.middleName)}</td>`;
        const label = escapeHtml(line.minorName || line.middleName);
        return `
      <tr class="statement-line" data-line-id="${line.id}">
        ${takeMajorCell()}
        ${categoryCells}
        <td><button type="button" class="item-count ${line.items.length ? "" : "missing"}" data-line-detail="${line.id}" title="연결 품번과 입고 내역 보기">${itemCountText(line.items)}</button></td>
        <td class="number-cell">${editable ? `
          <label class="visually-hidden" for="budget-${line.id}">${label} 실행예산</label>
          <input id="budget-${line.id}" class="inline-input budget-input" type="text" inputmode="numeric" autocomplete="off"
                 value="${Number(line.executionBudget).toLocaleString("ko-KR")}">`
          // 확정본이나 조회자는 입력칸 대신 숫자만 보여 표를 깔끔하게 합니다.
          : `<span class="amount-text">${formatWon(line.executionBudget)}</span>`}
        </td>
        <td class="number-cell purchase-cell">${formatWon(line.purchaseAmount)}</td>
        <td class="number-cell balance-cell">${amountCellMarkup(line.balanceAmount)}</td>
        <td class="rate-cell">${progressMarkup(line.executionRate)}</td>
        <td>${editable ? `
          <label class="visually-hidden" for="remark-${line.id}">${label} 비고</label>
          <input id="remark-${line.id}" class="inline-input remark-input" value="${escapeHtml(line.remark)}" maxlength="200">`
          : `<span class="remark-text">${escapeHtml(line.remark)}</span>`}
        </td>
      </tr>`;
      }).join("");
      if (!middle.showSubtotal) return lines;
      return `${lines}
      <tr class="middle-subtotal" data-middle-subtotal="${groupIndex}-${middleIndex}">
        <td class="minor-cell">소계</td>
        <td></td>
        ${subtotalCellsMarkup(middle.totals, "middle-progress")}
        <td></td>
      </tr>`;
    }).join("");
    return `${middleRows}
      <tr class="group-subtotal" data-subtotal="${groupIndex}">
        <td colspan="4"><strong>${escapeHtml(group.majorName)} 합계</strong><span>중분류 ${group.middles.length.toLocaleString("ko-KR")}개</span></td>
        ${subtotalCellsMarkup(group.totals, "subtotal-progress")}
        <td></td>
      </tr>`;
  }).join("");
  applyProgressWidths(elements.statementRows);
  attachStatementInputEvents();
  elements.statementRows.querySelectorAll("[data-line-detail]").forEach((button) =>
    button.addEventListener("click", () => openLineDetail(button.dataset.lineDetail)));
  applyDraft();
}

/** 중분류 소계 · 대분류 합계 행의 금액 칸 네 개. */
function subtotalCellsMarkup(totals, progressClass) {
  return `
        <td class="number-cell subtotal-budget">${formatWon(totals.executionBudget)}</td>
        <td class="number-cell subtotal-purchase">${formatWon(totals.purchaseAmount)}</td>
        <td class="number-cell subtotal-balance">${amountCellMarkup(totals.balanceAmount)}</td>
        <td class="subtotal-rate">${progressMarkup(totals.executionRate, progressClass)}</td>`;
}

function updateSubtotalCells(row, totals, progressClass) {
  if (!row) return;
  row.querySelector(".subtotal-budget").textContent = formatWon(totals.executionBudget);
  row.querySelector(".subtotal-purchase").textContent = formatWon(totals.purchaseAmount);
  row.querySelector(".subtotal-balance").innerHTML = amountCellMarkup(totals.balanceAmount);
  row.querySelector(".subtotal-rate").innerHTML = progressMarkup(totals.executionRate, progressClass);
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
  groupExecutionLines(lines).forEach((group, groupIndex) => {
    group.middles.forEach((middle, middleIndex) => {
      if (!middle.showSubtotal) return;
      updateSubtotalCells(elements.statementRows.querySelector(`[data-middle-subtotal="${groupIndex}-${middleIndex}"]`), middle.totals, "middle-progress");
    });
    updateSubtotalCells(elements.statementRows.querySelector(`[data-subtotal="${groupIndex}"]`), group.totals, "subtotal-progress");
  });
  applyProgressWidths(elements.statementRows);
  renderSummary();
}

function attachStatementInputEvents() {
  const inputs = [...elements.statementRows.querySelectorAll(".statement-line .inline-input:not(:disabled)")];
  for (const input of inputs) {
    if (input.classList.contains("budget-input")) {
      input.addEventListener("focus", () => {
        const amount = parseBudgetInput(input.value);
        // 0 이 칸에 남아 있으면 입력한 숫자 앞뒤로 붙어 10배 금액이 되므로 비워 둡니다.
        input.value = amount ? String(amount) : "";
        // 클릭으로 들어오면 마우스를 뗄 때 선택이 풀리므로 한 박자 뒤에 전체 선택합니다.
        setTimeout(() => { if (document.activeElement === input) input.select(); }, 0);
      });
      input.addEventListener("input", () => {
        input.value = input.value.replace(/[^0-9]/g, "");
        setDirty(true);
        refreshDerivedCells();
        captureDraft();
      });
      input.addEventListener("blur", () => formatBudgetInput(input));
    } else {
      input.addEventListener("input", () => {
        setDirty(true);
        captureDraft();
      });
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

// ------------------------------------------------------------------ 입고 기준 · 새로 고침

/** 마지막으로 불러온 지 이만큼 지나면 '오래된 자료' 로 안내합니다. */
const RECEIPT_STALE_MS = 24 * 60 * 60 * 1000;

function formatCompactDate(value) {
  const text = String(value || "");
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : text;
}

function renderReceiptSource() {
  const snapshot = state.snapshot;
  const source = snapshot.receiptSource || {};
  const isDraft = snapshot.status === SNAPSHOT_STATUS.DRAFT;
  const fetchedAt = source.fetchedAt ? new Date(source.fetchedAt) : null;
  const stale = isDraft && fetchedAt && Date.now() - fetchedAt.getTime() > RECEIPT_STALE_MS;

  if (!fetchedAt) {
    elements.receiptSource.textContent = "아직 불러온 입고가 없습니다. 기간을 정하고 매입금액 불러오기를 누르세요.";
  } else {
    const range = source.from ? ` · 조회 기간 ${formatCompactDate(source.from)} ~ ${formatCompactDate(source.to)}` : "";
    const excluded = source.excludedCount ? ` · 직접 뺀 입고 ${source.excludedCount.toLocaleString("ko-KR")}건 제외` : "";
    elements.receiptSource.textContent = `입고 기준 ${formatDateTime(source.fetchedAt)}${range}${excluded}`
      + (stale ? " — 하루 넘게 지난 자료입니다. '최신으로 새로 고침'을 눌러 주세요." : "");
  }
  elements.receiptSource.classList.toggle("stale", Boolean(stale));
  elements.purchaseBasis.textContent = fetchedAt
    ? `${isDraft ? "" : "확정 당시 "}입고 기준 ${formatDateTime(source.fetchedAt)}`
    : "아직 불러온 입고 없음";
  elements.refreshReceiptsButton.disabled = !canEditSnapshot() || !source.from;

  // 이 버전을 처음 열 때, 불러오기 시작일을 지금까지 불러온 기간의 시작일로 맞춰 둡니다(종료일은 오늘).
  if (state.receiptDatesFor !== snapshot.id) {
    state.receiptDatesFor = snapshot.id;
    if (source.from) {
      elements.fromDate.value = formatCompactDate(source.from);
      elements.toDate.value = new Date().toISOString().slice(0, 10);
    }
  }
}

/** 이 버전에 불러온 기간 전체를 다시 조회해 아마란스10과 맞춥니다. */
async function refreshReceipts() {
  const result = await busy(() => api(`/api/snapshots/${state.snapshot.id}/receipts/refresh`, { method: "POST", body: "{}" }));
  state.snapshot = result.snapshot;
  setDirty(false);
  renderSnapshot();
  const changes = [];
  if (result.addedCount) changes.push(`새 입고 ${result.addedCount.toLocaleString("ko-KR")}건`);
  if (result.changedCount) changes.push(`금액이 바뀐 입고 ${result.changedCount.toLocaleString("ko-KR")}건`);
  if (result.removedCount) changes.push(`아마란스10에서 사라진 입고 ${result.removedCount.toLocaleString("ko-KR")}건 정리`);
  const unmapped = result.snapshot.unmapped?.count ? ` 미분류 입고가 ${result.snapshot.unmapped.count.toLocaleString("ko-KR")}건 있습니다.` : "";
  showToast(changes.length
    ? `최신으로 맞췄습니다: ${changes.join(" · ")}.${unmapped}`
    : `바뀐 입고가 없습니다. 최신 상태입니다.${unmapped}`);
}

// ------------------------------------------------------------------ 입고 상세 · 미분류

const RECEIPT_FILTER = Object.freeze({ ALL: "all", UNMAPPED: "unmapped" });

/** "자재비 › 구매품 › 구입품비" 처럼 줄의 분류 경로. */
function lineLabel(line) {
  return [line.majorName, line.middleName, line.minorName].filter(Boolean).join(" › ");
}

function findLine(lineId) {
  return state.snapshot?.lines.find((line) => line.id === Number(lineId)) || null;
}

function sumAmount(rows, key = "amount") {
  return rows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0);
}

function renderUnmappedNotice() {
  const unmapped = state.snapshot.unmapped || { count: 0 };
  elements.unmappedNotice.classList.toggle("hidden", !unmapped.count);
  if (!unmapped.count) return;
  elements.unmappedDetail.textContent =
    `품번 ${unmapped.itemCount.toLocaleString("ko-KR")}개 · 입고 ${unmapped.count.toLocaleString("ko-KR")}건 · ${formatWon(unmapped.amount)}이 `
    + "아직 어느 줄에도 들어가지 않아 매입금액에서 빠져 있습니다. 확인하고 알맞은 줄에 연결해 주세요.";
}

function renderReceiptFilterOptions() {
  const snapshot = state.snapshot;
  const previous = elements.receiptFilter.value || RECEIPT_FILTER.ALL;
  const countByLine = new Map();
  for (const receipt of snapshot.receipts) {
    if (receipt.lineId) countByLine.set(receipt.lineId, (countByLine.get(receipt.lineId) || 0) + 1);
  }
  const groups = groupExecutionLines(snapshot.lines);
  elements.receiptFilter.innerHTML = `
    <option value="${RECEIPT_FILTER.ALL}">전체 분류</option>
    <option value="${RECEIPT_FILTER.UNMAPPED}">미분류만 (${(snapshot.unmapped?.count || 0).toLocaleString("ko-KR")}건)</option>
    ${groups.map((group) => `
      <optgroup label="${escapeHtml(group.majorName)}">
        ${group.lines.map((line) => `<option value="line-${line.id}">${escapeHtml([line.middleName, line.minorName].filter(Boolean).join(" › "))} (${(countByLine.get(line.id) || 0).toLocaleString("ko-KR")}건)</option>`).join("")}
      </optgroup>`).join("")}`;
  const values = [...elements.receiptFilter.options].map((option) => option.value);
  elements.receiptFilter.value = values.includes(previous) ? previous : RECEIPT_FILTER.ALL;
}

function filteredReceipts() {
  const filter = elements.receiptFilter.value || RECEIPT_FILTER.ALL;
  const keyword = elements.receiptSearch.value.trim().toLowerCase();
  return state.snapshot.receipts.filter((receipt) => {
    if (filter === RECEIPT_FILTER.UNMAPPED && receipt.lineId) return false;
    if (filter.startsWith("line-") && String(receipt.lineId) !== filter.slice(5)) return false;
    if (!keyword) return true;
    return [receipt.itemCode, receipt.itemName, receipt.receiptNo].some((value) => String(value || "").toLowerCase().includes(keyword));
  });
}

function renderReceipts() {
  const snapshot = state.snapshot;
  const editable = canEditSnapshot();
  const unmappedCount = snapshot.unmapped?.count || 0;
  elements.receiptCount.textContent = `${snapshot.receipts.length.toLocaleString("ko-KR")}건`
    + (unmappedCount ? ` · 미분류 ${unmappedCount.toLocaleString("ko-KR")}건` : "");
  elements.receiptCount.classList.toggle("has-unmapped", unmappedCount > 0);
  renderUnmappedNotice();
  renderReceiptSource();
  renderReceiptFilterOptions();

  const rows = filteredReceipts();
  elements.receiptSummary.textContent = rows.length === snapshot.receipts.length
    ? ""
    : `${rows.length.toLocaleString("ko-KR")}건 표시 중`;
  elements.receiptRows.innerHTML = rows.length ? rows.map((receipt) => {
    const line = receipt.lineId ? findLine(receipt.lineId) : null;
    const category = line
      ? `<span class="receipt-line">${escapeHtml(lineLabel(line))}</span>`
      : `<span class="unmapped-tag">미분류</span>${editable
        ? `<button class="row-action link-receipt" data-item-code="${escapeHtml(receipt.itemCode)}" data-item-name="${escapeHtml(receipt.itemName)}">줄에 연결</button>`
        : ""}`;
    return `
    <tr data-receipt-id="${receipt.id}" class="${line ? "" : "unmapped-row"}">
      <td>${escapeHtml(receipt.receiptDate)}</td>
      <td>${escapeHtml(receipt.receiptNo)}</td>
      <td><code>${escapeHtml(receipt.itemCode)}</code></td>
      <td>${escapeHtml(receipt.itemName)}</td>
      <td class="category-cell">${category}</td>
      <td class="number-cell">${formatWon(receipt.amount)}</td>
      <td class="number-cell">${formatWon(receipt.vatAmount)}</td>
      <td class="editor-only"><button class="row-action danger delete-receipt" ${editable ? "" : "disabled"}>삭제</button></td>
    </tr>`;
  }).join("") : `<tr><td class="empty-row" colspan="8">${snapshot.receipts.length ? "조건에 맞는 입고가 없습니다." : "불러온 입고 내역이 없습니다."}</td></tr>`;
  elements.receiptTotals.innerHTML = rows.length ? `
    <tr>
      <td colspan="5">합계 · ${rows.length.toLocaleString("ko-KR")}건</td>
      <td class="number-cell">${formatWon(sumAmount(rows))}</td>
      <td class="number-cell">${formatWon(sumAmount(rows, "vatAmount"))}</td>
      <td class="editor-only"></td>
    </tr>` : "";

  elements.receiptRows.querySelectorAll(".delete-receipt").forEach((button) => {
    button.addEventListener("click", () => deleteReceipt(Number(button.closest("tr").dataset.receiptId)));
  });
  elements.receiptRows.querySelectorAll(".link-receipt").forEach((button) => {
    button.addEventListener("click", () => ignoreFailure(linkUnmappedItem(button.dataset.itemCode, button.dataset.itemName)));
  });
}

/** 입고 상세 내역을 펼치고 원하는 조건으로 거른 뒤 그 자리로 이동합니다. */
function showReceipts(filter) {
  elements.receiptSearch.value = "";
  elements.receiptFilter.value = filter;
  elements.receiptDetails.open = true;
  renderReceipts();
  elements.receiptDetails.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** 줄의 '연결 품번'을 누르면 그 줄의 품번별 입고 건수 · 금액을 보여 줍니다. */
function openLineDetail(lineId) {
  const line = currentLines().find((item) => item.id === Number(lineId));
  if (!line) return;
  const receipts = state.snapshot.receipts.filter((receipt) => receipt.lineId === line.id);
  elements.lineDetailTitle.textContent = lineLabel(line);
  elements.lineDetailSummary.textContent =
    `연결 품번 ${line.items.length.toLocaleString("ko-KR")}개 · 입고 ${receipts.length.toLocaleString("ko-KR")}건 · `
    + `매입금액 ${formatWon(line.purchaseAmount)} / 실행예산 ${formatWon(line.executionBudget)}`;
  const rows = line.items.map((item) => {
    const own = receipts.filter((receipt) => receipt.itemCode === item.itemCode);
    return { ...item, count: own.length, amount: sumAmount(own) };
  }).sort((a, b) => b.amount - a.amount || a.itemCode.localeCompare(b.itemCode));
  elements.lineDetailItems.innerHTML = rows.length ? rows.map((row) => `
    <tr class="${row.count ? "" : "muted-row"}">
      <td><code>${escapeHtml(row.itemCode)}</code></td>
      <td>${escapeHtml(row.itemName)}</td>
      <td class="number-cell">${row.count.toLocaleString("ko-KR")}건</td>
      <td class="number-cell">${formatWon(row.amount)}</td>
    </tr>`).join("")
    : '<tr><td class="empty-row" colspan="4">이 줄에 연결된 품번이 없습니다. 관리자에게 분류 · 품번 설정에서 연결을 요청하세요.</td></tr>';
  elements.lineDetailReceiptsButton.onclick = () => {
    elements.lineDetailDialog.close("done");
    showReceipts(`line-${line.id}`);
  };
  openDialog(elements.lineDetailDialog, () => {});
}

/** 미분류 품번을 이 버전의 한 줄에 연결합니다(관리자는 분류 설정에도 함께 연결할 수 있음). */
async function linkUnmappedItem(itemCode, itemName) {
  const receipts = state.snapshot.receipts.filter((receipt) => receipt.itemCode === itemCode);
  elements.linkItemSummary.textContent =
    `${itemCode} · ${itemName} — 입고 ${receipts.length.toLocaleString("ko-KR")}건 · ${formatWon(sumAmount(receipts))}`;
  elements.linkItemLine.innerHTML = groupExecutionLines(state.snapshot.lines).map((group) => `
    <optgroup label="${escapeHtml(group.majorName)}">
      ${group.lines.map((line) => `<option value="${line.id}">${escapeHtml([line.middleName, line.minorName].filter(Boolean).join(" › "))}</option>`).join("")}
    </optgroup>`).join("");
  elements.linkItemAlsoSettings.checked = state.permissions.canAdminister;
  const confirmed = await new Promise((resolve) => {
    openDialog(elements.linkItemDialog, (returnValue) => resolve(returnValue === "confirm"));
    setTimeout(() => elements.linkItemLine.focus(), 0);
  });
  if (!confirmed) return;

  const line = findLine(elements.linkItemLine.value);
  const result = await busy(() => api(`/api/snapshots/${state.snapshot.id}/items`, {
    method: "POST",
    body: JSON.stringify({
      lineId: line.id,
      itemCode,
      itemName,
      alsoSettings: state.permissions.canAdminister && elements.linkItemAlsoSettings.checked,
    }),
  }));
  state.snapshot = result.snapshot;
  renderSnapshot();
  const settingsNote = {
    linked: " 분류 · 품번 설정에도 연결했습니다.",
    already: " (분류 · 품번 설정에서는 이미 다른 곳에 연결돼 있어 그대로 두었습니다.)",
    missing: " (분류 · 품번 설정에서 같은 분류를 찾지 못해 이 버전에만 연결했습니다.)",
    skipped: "",
  }[result.settings] || "";
  showToast(`${itemCode}을(를) '${lineLabel(line)}' 줄에 연결했습니다.${settingsNote}`);
}

// ------------------------------------------------------------------ 집행서 동작

async function saveStatement() {
  if (!canEditSnapshot()) return;
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
  clearDraft(state.snapshot.id);
  setDirty(false);
  // 표를 통째로 다시 그리지 않고 금액 칸만 갱신해, 입력하던 자리를 잃지 않게 합니다.
  refreshDerivedCells();
  elements.snapshotDate.textContent = `저장 ${formatDateTime(state.snapshot.updatedAt)}`;
  if (activeElementId) document.getElementById(activeElementId)?.focus();
  showToast(`${lines.length.toLocaleString("ko-KR")}개 항목의 실행예산과 비고를 저장했습니다.`);
}

async function createSnapshot(cloneCurrent = false) {
  if (!state.selectedProjectId) return showToast("먼저 프로젝트를 선택해 주세요.", true);
  if (cloneCurrent && state.dirty) {
    const proceed = await askConfirm({
      title: "저장하지 않은 입력은 복제되지 않습니다",
      message: "복제는 마지막으로 저장한 값으로 만듭니다. 지금 입력하던 값은 이 버전에 그대로 남아 있습니다. 계속할까요?",
      confirmLabel: "복제",
    });
    if (!proceed) return;
  }
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
  const result = await busy(() => api(`/api/snapshots/${state.snapshot.id}/receipts/import`, {
    method: "POST",
    body: JSON.stringify({
      fromDate: elements.fromDate.value,
      toDate: elements.toDate.value,
      replace: elements.replaceReceipts.checked,
    }),
  }));
  state.snapshot = result.snapshot;
  setDirty(false);
  renderSnapshot();
  showToast(result.unmappedCount
    ? `입고 ${result.importedCount.toLocaleString("ko-KR")}건을 반영했습니다. 이 중 ${result.unmappedCount.toLocaleString("ko-KR")}건은 분류에 연결되지 않은 품번이라 '미분류'로 두었습니다.`
    : `입고 ${result.importedCount.toLocaleString("ko-KR")}건을 반영했습니다.`);
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

  const printTotalsCells = (totals) => `
        <td class="print-number">${formatWon(totals.executionBudget)}</td>
        <td class="print-number">${formatWon(totals.purchaseAmount)}</td>
        <td class="print-number ${totals.balanceAmount < 0 ? "negative" : ""}">${formatWon(totals.balanceAmount)}</td>
        <td class="print-number">${formatPercent(totals.executionRate)}</td>`;
  const detailRows = groups.map((group) => {
    const majorRowSpan = group.middles.reduce((sum, middle) => sum + middle.lines.length + (middle.showSubtotal ? 1 : 0), 0);
    let majorCell = `<td class="print-major" rowspan="${majorRowSpan}">${escapeHtml(group.majorName)}</td>`;
    const rows = group.middles.map((middle) => {
      const middleRowSpan = middle.lines.length + (middle.showSubtotal ? 1 : 0);
      const lines = middle.lines.map((line, lineIndex) => {
        const categoryCells = middle.hasMinors
          ? `${lineIndex === 0 ? `<td class="print-middle" rowspan="${middleRowSpan}">${escapeHtml(middle.middleName)}</td>` : ""}<td>${escapeHtml(line.minorName)}</td>`
          : `<td colspan="2">${escapeHtml(line.middleName)}</td>`;
        const markup = `
      <tr>
        ${majorCell}
        ${categoryCells}
        <td class="print-center">${itemCountText(line.items)}</td>
        ${printTotalsCells(line)}
        <td>${escapeHtml(line.remark || "")}</td>
      </tr>`;
        majorCell = "";
        return markup;
      }).join("");
      if (!middle.showSubtotal) return lines;
      return `${lines}
      <tr class="print-middle-subtotal">
        <td class="print-center">소 계</td>
        <td></td>
        ${printTotalsCells(middle.totals)}
        <td></td>
      </tr>`;
    }).join("");
    return `${rows}
      <tr class="print-subtotal">
        <td colspan="4">${escapeHtml(group.majorName)} 합계 · 중분류 ${group.middles.length.toLocaleString("ko-KR")}개</td>
        ${printTotalsCells(group.totals)}
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
      <colgroup><col class="print-col-major"><col class="print-col-middle"><col class="print-col-minor"><col class="print-col-items"><col class="print-col-money"><col class="print-col-money"><col class="print-col-money"><col class="print-col-rate"><col></colgroup>
      <thead><tr><th>대분류</th><th>중분류</th><th>소분류</th><th>연결 품번</th><th>실행예산</th><th>매입금액 소계</th><th>예산잔액</th><th>집행률</th><th>비고</th></tr></thead>
      <tbody>${detailRows || '<tr><td colspan="9" class="print-empty">이 버전에 포함된 중분류가 없습니다.</td></tr>'}</tbody>
      <tfoot><tr>
        <td colspan="4">전체 합계</td>
        <td class="print-number">${formatWon(overallTotals.executionBudget)}</td>
        <td class="print-number">${formatWon(overallTotals.purchaseAmount)}</td>
        <td class="print-number ${overallTotals.balanceAmount < 0 ? "negative" : ""}">${formatWon(overallTotals.balanceAmount)}</td>
        <td class="print-number">${formatPercent(overallTotals.executionRate)}</td>
        <td></td>
      </tr></tfoot>
    </table>
    <div class="print-report-footer">
      <span>연결 품번은 상세 코드 대신 분류별 건수로 표기했습니다. · ${confirmedNote}${snapshot.receiptSource?.fetchedAt ? ` · 입고 기준 ${formatDateTime(snapshot.receiptSource.fetchedAt)}` : ""}</span>
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
    ? `대분류 ${selected.majorCount} · 중분류 ${selected.middleCount} · 소분류 ${selected.minorCount} · 품번 ${selected.itemCount}`
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
  state.selectedMinorId = null;
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
    message: `${categorySetLabel(set)} 과(와) 그 안의 대분류 ${set.majorCount}개 · 중분류 ${set.middleCount}개 · 소분류 ${set.minorCount}개 · 품번 ${set.itemCount}개를 삭제합니다.`
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

function selectedMinor() {
  return selectedMiddle()?.minorCategories.find((minor) => minor.id === Number(state.selectedMinorId));
}

/** 중분류에 바로 붙은 품번과 소분류에 붙은 품번을 모두 셉니다. */
function middleItemCount(middle) {
  return middle.items.length + middle.minorCategories.reduce((sum, minor) => sum + minor.items.length, 0);
}

function renderSettings() {
  if (!selectedMajor() && state.categories.length) state.selectedMajorId = state.categories[0].id;
  if (!selectedMiddle() && selectedMajor()?.middleCategories.length) state.selectedMiddleId = selectedMajor().middleCategories[0].id;
  if (!selectedMinor()) state.selectedMinorId = selectedMiddle()?.minorCategories[0]?.id || null;
  renderMajorList();
  renderMiddleList();
  renderMinorList();
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
    state.selectedMinorId = null;
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
      ${middle.minorCategories.length ? `<span class="count" title="소분류 수">소 ${middle.minorCategories.length}</span>` : ""}
      <span class="count" title="연결 품번 수">${middleItemCount(middle)}</span>
      <button class="row-action move-middle" data-direction="up" aria-label="위로" ${index === 0 ? "disabled" : ""}>▲</button>
      <button class="row-action move-middle" data-direction="down" aria-label="아래로" ${index === middles.length - 1 ? "disabled" : ""}>▼</button>
      <button class="row-action edit-middle">수정</button>
      <button class="row-action danger delete-middle">삭제</button>
    </div>
  `).join("") : `<div class="settings-placeholder">${major ? "중분류를 추가해 주세요." : "먼저 대분류를 선택하세요."}</div>`;

  elements.middleList.querySelectorAll(".select-middle").forEach((button) => button.addEventListener("click", () => {
    state.selectedMiddleId = Number(button.closest(".master-row").dataset.middleId);
    state.selectedMinorId = null;
      renderSettings();
  }));
  elements.middleList.querySelectorAll(".move-middle").forEach((button) => button.addEventListener("click", () =>
    moveCategory("middle", Number(button.closest(".master-row").dataset.middleId), button.dataset.direction)));
  elements.middleList.querySelectorAll(".edit-middle").forEach((button) => button.addEventListener("click", () => editMiddle(button.closest(".master-row"))));
  elements.middleList.querySelectorAll(".delete-middle").forEach((button) => button.addEventListener("click", () => deleteMiddle(button.closest(".master-row"))));
}

function renderMinorList() {
  const middle = selectedMiddle();
  const minors = middle?.minorCategories || [];
  elements.minorList.innerHTML = minors.length ? minors.map((minor, index) => `
    <div class="master-row ${minor.id === Number(state.selectedMinorId) ? "selected" : ""}" data-minor-id="${minor.id}">
      <button class="select-minor">${escapeHtml(minor.name)}</button>
      <span class="count" title="연결 품번 수">${minor.items.length}</span>
      <button class="row-action move-minor" data-direction="up" aria-label="위로" ${index === 0 ? "disabled" : ""}>▲</button>
      <button class="row-action move-minor" data-direction="down" aria-label="아래로" ${index === minors.length - 1 ? "disabled" : ""}>▼</button>
      <button class="row-action edit-minor">수정</button>
      <button class="row-action danger delete-minor">삭제</button>
    </div>
  `).join("") + (minors.length >= 2 ? `<p class="minor-guide">집행서에 '${escapeHtml(middle.name)} 소계'가 표시됩니다.</p>` : "")
    : `<div class="settings-placeholder">${middle
      ? "소분류가 없습니다.<br>소분류 없이 중분류에 바로 품번을 연결해도 됩니다.<br>중분류 소계가 필요하면 ＋로 소분류를 추가하세요."
      : "먼저 중분류를 선택하세요."}</div>`;

  elements.minorList.querySelectorAll(".select-minor").forEach((button) => button.addEventListener("click", () => {
    state.selectedMinorId = Number(button.closest(".master-row").dataset.minorId);
      renderSettings();
  }));
  elements.minorList.querySelectorAll(".move-minor").forEach((button) => button.addEventListener("click", () =>
    moveCategory("minor", Number(button.closest(".master-row").dataset.minorId), button.dataset.direction)));
  elements.minorList.querySelectorAll(".edit-minor").forEach((button) => button.addEventListener("click", () => editMinor(button.closest(".master-row"))));
  elements.minorList.querySelectorAll(".delete-minor").forEach((button) => button.addEventListener("click", () => deleteMinor(button.closest(".master-row"))));
}

/** 품번을 연결할 대상: 소분류가 있으면 선택한 소분류, 없으면 중분류. */
function itemMappingTarget() {
  const middle = selectedMiddle();
  if (!middle) return null;
  if (!middle.minorCategories.length) {
    return { path: [selectedMajor().name, middle.name], items: middle.items, body: { middleCategoryId: middle.id } };
  }
  const minor = selectedMinor();
  if (!minor) return null;
  return { path: [selectedMajor().name, middle.name, minor.name], items: minor.items, body: { minorCategoryId: minor.id } };
}

function renderMappedItems() {
  const target = itemMappingTarget();
  if (!target) {
    elements.mappedItemList.innerHTML = '<div class="settings-placeholder">품번을 연결할 중분류(소분류가 있으면 소분류)를 선택하세요.</div>';
    return;
  }
  elements.mappedItemList.innerHTML =
    `<p class="mapped-heading">${target.path.map(escapeHtml).join(" 〉 ")} · ${target.items.length}개 품번</p>`
    + (target.items.length ? target.items.map((item) => `
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
  const endpoint = { major: API.MAJOR_CATEGORIES, middle: API.MIDDLE_CATEGORIES, minor: API.MINOR_CATEGORIES }[kind];
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
    message: `'${middle.name}' 중분류`
      + (middle.minorCategories.length ? `와 그 아래 소분류 ${middle.minorCategories.length}개,` : "와")
      + ` 연결된 품번 ${middleItemCount(middle)}개가 삭제됩니다. 이미 만들어진 집행서 버전에는 영향을 주지 않습니다. 삭제할까요?`,
    confirmLabel: "삭제",
    danger: true,
  });
  if (!confirmed) return;
  await busy(() => api(`${API.MIDDLE_CATEGORIES}/${middle.id}`, { method: "DELETE" }));
  state.selectedMiddleId = null;
  state.selectedMinorId = null;
  await refreshCategories();
  showToast("중분류를 삭제했습니다.");
}

async function addMinor() {
  const middle = selectedMiddle();
  if (!middle) return showToast("먼저 중분류를 선택해 주세요.", true);
  const name = await askText({ title: "소분류 추가", label: `${middle.name}의 소분류명` });
  if (!name) return;
  // 소분류가 생기면 품번은 소분류에만 연결되므로, 중분류에 바로 붙어 있던 품번은 첫 소분류로 옮겨집니다.
  if (middle.minorCategories.length === 0 && middle.items.length > 0) {
    const confirmed = await askConfirm({
      title: "첫 소분류 추가",
      message: `'${middle.name}' 중분류에 연결된 품번 ${middle.items.length}개가 새 소분류 '${name}'(으)로 옮겨집니다.`
        + " 소분류가 생긴 중분류는 소분류마다 실행예산을 입력하고, 소분류가 2개 이상이면 집행서에 중분류 소계가 표시됩니다. 계속할까요?",
      confirmLabel: "추가",
    });
    if (!confirmed) return;
  }
  const created = await busy(() => api(API.MINOR_CATEGORIES, { method: "POST", body: JSON.stringify({ middleCategoryId: middle.id, name }) }));
  state.selectedMinorId = created.id;
  await refreshCategories();
  showToast(created.movedItemCount
    ? `소분류를 추가하고 품번 ${created.movedItemCount}개를 옮겼습니다.`
    : "소분류를 추가했습니다.");
}

async function editMinor(row) {
  const minor = selectedMiddle().minorCategories.find((item) => item.id === Number(row.dataset.minorId));
  const name = await askText({ title: "소분류 수정", label: "소분류명", initial: minor.name });
  if (!name || name === minor.name) return;
  await busy(() => api(`${API.MINOR_CATEGORIES}/${minor.id}`, { method: "PUT", body: JSON.stringify({ name }) }));
  await refreshCategories();
  showToast("소분류를 수정했습니다.");
}

async function deleteMinor(row) {
  const middle = selectedMiddle();
  const minor = middle.minorCategories.find((item) => item.id === Number(row.dataset.minorId));
  const lastNotice = middle.minorCategories.length === 1
    ? " 마지막 소분류를 지우면 이 중분류는 다시 품번을 바로 연결하는 한 줄 중분류가 됩니다."
    : "";
  const confirmed = await askConfirm({
    title: "소분류 삭제",
    message: `'${minor.name}' 소분류와 연결된 품번 ${minor.items.length}개가 삭제됩니다.${lastNotice} 이미 만들어진 집행서 버전에는 영향을 주지 않습니다. 삭제할까요?`,
    confirmLabel: "삭제",
    danger: true,
  });
  if (!confirmed) return;
  await busy(() => api(`${API.MINOR_CATEGORIES}/${minor.id}`, { method: "DELETE" }));
  state.selectedMinorId = null;
  await refreshCategories();
  showToast("소분류를 삭제했습니다.");
}

// ------------------------------------------------------------------ 품번 검색 창

const ITEM_PICKER_SCOPE = Object.freeze({ ALL: "all", RECEIVED: "received" });
const ITEM_PICKER_LIMIT = 2_000;
const picker = { scope: ITEM_PICKER_SCOPE.ALL, items: [], total: 0, truncated: false, selected: new Set(), seq: 0, timer: null };

function pickerMode() {
  return document.querySelector('input[name="itemPickerMode"]:checked')?.value || "contains";
}

function findMiddleIdOfMinor(minorId) {
  for (const major of state.categories) {
    for (const middle of major.middleCategories) {
      if (middle.minorCategories.some((minor) => minor.id === Number(minorId))) return middle.id;
    }
  }
  return null;
}

/** 품목이 지금 연결하려는 곳에 이미 붙어 있는지(here), 다른 곳에 붙어 있는지(elsewhere), 비어 있는지(free). */
function pickerItemState(item, target) {
  if (!item.mappedTo) return "free";
  const targetMiddleId = target.body.middleCategoryId ?? findMiddleIdOfMinor(target.body.minorCategoryId);
  const same = Number(item.mappedMiddleId) === Number(targetMiddleId)
    && Number(item.mappedMinorId || 0) === Number(target.body.minorCategoryId || 0);
  return same ? "here" : "elsewhere";
}

function pickerSelectable(item, target) {
  const status = pickerItemState(item, target);
  return status === "free" || (status === "elsewhere" && elements.itemPickerMove.checked);
}

async function openItemPicker() {
  const target = itemMappingTarget();
  if (!target) return showToast("품번을 연결할 중분류(소분류가 있으면 소분류)를 먼저 골라 주세요.", true);
  elements.itemPickerTarget.textContent = target.path.join(" › ");
  picker.selected.clear();
  setPickerScope(ITEM_PICKER_SCOPE.ALL, { search: false });
  openDialog(elements.itemPickerDialog, () => clearTimeout(picker.timer));
  setTimeout(() => {
    elements.itemPickerQuery.focus();
    elements.itemPickerQuery.select();
  }, 0);
  await Promise.all([runPickerSearch(), refreshReceivedCount()]);
}

function setPickerScope(scope, { search = true } = {}) {
  picker.scope = scope;
  elements.itemPickerDialog.querySelectorAll(".picker-tab").forEach((tab) => {
    const active = tab.dataset.scope === scope;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  elements.itemPickerRefresh.classList.toggle("hidden", scope !== ITEM_PICKER_SCOPE.ALL);
  picker.selected.clear();
  if (search) ignoreFailure(runPickerSearch());
}

async function refreshReceivedCount() {
  try {
    const result = await api(API.ITEM_SEARCH, {
      method: "POST",
      body: JSON.stringify({ query: "", scope: ITEM_PICKER_SCOPE.RECEIVED, limit: 1, categorySetId: state.selectedCategorySetId }),
    });
    elements.itemPickerReceivedCount.textContent = result.total ? result.total.toLocaleString("ko-KR") : "";
  } catch {
    elements.itemPickerReceivedCount.textContent = "";
  }
}

/** 검색합니다. 입력 중에 앞선 요청이 늦게 도착해도 마지막 검색 결과만 보여 줍니다. */
async function runPickerSearch({ refresh = false } = {}) {
  const sequence = ++picker.seq;
  elements.itemPickerStatus.textContent = refresh ? "아마란스10에서 품목 목록을 다시 받는 중…" : "검색 중…";
  try {
    const result = await api(API.ITEM_SEARCH, {
      method: "POST",
      body: JSON.stringify({
        query: elements.itemPickerQuery.value.trim(),
        mode: pickerMode(),
        scope: picker.scope,
        refresh,
        limit: ITEM_PICKER_LIMIT,
        categorySetId: state.selectedCategorySetId,
      }),
    });
    if (sequence !== picker.seq) return;
    picker.items = result.items;
    picker.total = result.total;
    picker.truncated = result.truncated;
    renderPicker();
  } catch (error) {
    if (sequence !== picker.seq) return;
    picker.items = [];
    picker.total = 0;
    renderPicker();
    elements.itemPickerStatus.textContent = error.message || "검색하지 못했습니다.";
  }
}

function schedulePickerSearch() {
  clearTimeout(picker.timer);
  picker.timer = setTimeout(() => ignoreFailure(runPickerSearch()), 250);
}

function renderPicker() {
  const target = itemMappingTarget();
  if (!target) return;
  const received = picker.scope === ITEM_PICKER_SCOPE.RECEIVED;
  const emptyMessage = received
    ? "입고됐지만 연결 안 된 품번이 없습니다. 집행서에서 매입금액을 불러오면 여기에 모입니다."
    : "검색 결과가 없습니다. 품번 · 품명 · 규격의 일부만 넣어 보거나, 방금 등록한 품목이면 '품목 목록 새로 받기'를 눌러 주세요.";
  elements.itemPickerRows.innerHTML = picker.items.length ? picker.items.map((item) => {
    const status = pickerItemState(item, target);
    const selectable = pickerSelectable(item, target);
    const checked = selectable && picker.selected.has(item.itemCode);
    const statusText = {
      here: '<span class="pick-status here">이 분류에 연결됨</span>',
      elsewhere: `<span class="pick-status elsewhere">${elements.itemPickerMove.checked ? "옮겨 옴 · " : ""}${escapeHtml(item.mappedTo)}</span>`,
      free: '<span class="pick-status free">미연결</span>',
    }[status];
    const receiptText = received
      ? `<small class="pick-receipt">입고 ${Number(item.receiptCount).toLocaleString("ko-KR")}건 · ${formatWon(item.receiptAmount)} · 최근 ${escapeHtml(item.lastReceiptDate || "-")}</small>`
      : "";
    return `
      <tr class="pick-row${selectable ? "" : " disabled"}${checked ? " selected" : ""}" data-code="${escapeHtml(item.itemCode)}">
        <td class="check-cell"><input type="checkbox" ${checked ? "checked" : ""} ${selectable ? "" : "disabled"} aria-label="${escapeHtml(item.itemCode)} 선택"></td>
        <td><code>${escapeHtml(item.itemCode)}</code></td>
        <td>${escapeHtml(item.itemName)}${receiptText}</td>
        <td class="muted-cell">${escapeHtml(item.specification || "")}</td>
        <td>${statusText}</td>
      </tr>`;
  }).join("") : `<tr><td class="empty-row" colspan="5">${emptyMessage}</td></tr>`;

  elements.itemPickerRows.querySelectorAll(".pick-row:not(.disabled)").forEach((row) => {
    row.addEventListener("click", (event) => {
      const code = row.dataset.code;
      if (picker.selected.has(code)) picker.selected.delete(code);
      else picker.selected.add(code);
      if (event.target.type !== "checkbox") row.querySelector("input").checked = picker.selected.has(code);
      row.classList.toggle("selected", picker.selected.has(code));
      updatePickerFooter();
    });
  });
  updatePickerFooter();
}

function updatePickerFooter() {
  const target = itemMappingTarget();
  const selectable = target ? picker.items.filter((item) => pickerSelectable(item, target)) : [];
  // 검색어를 바꿔 화면에서 사라진 선택은 지웁니다.
  const visible = new Set(selectable.map((item) => item.itemCode));
  for (const code of [...picker.selected]) if (!visible.has(code)) picker.selected.delete(code);
  const count = picker.selected.size;
  elements.itemPickerAll.checked = selectable.length > 0 && count === selectable.length;
  elements.itemPickerAll.indeterminate = count > 0 && count < selectable.length;
  elements.itemPickerAll.disabled = selectable.length === 0;
  const shown = picker.truncated
    ? `${picker.total.toLocaleString("ko-KR")}건 중 앞 ${picker.items.length.toLocaleString("ko-KR")}건 표시`
    : `검색 결과 ${picker.total.toLocaleString("ko-KR")}건`;
  elements.itemPickerStatus.textContent = `${shown} · 고를 수 있는 품번 ${selectable.length.toLocaleString("ko-KR")}건 · 선택 ${count.toLocaleString("ko-KR")}건`;
  elements.itemPickerLink.disabled = count === 0;
  elements.itemPickerLink.textContent = count ? `선택한 ${count.toLocaleString("ko-KR")}개 연결` : "선택한 품번 연결";
}

async function linkPickedItems() {
  const target = itemMappingTarget();
  if (!target || picker.selected.size === 0) return;
  const items = picker.items
    .filter((item) => picker.selected.has(item.itemCode))
    .map((item) => ({ itemCode: item.itemCode, itemName: item.itemName }));
  const result = await busy(() => api(`${API.ITEM_MAPPINGS}/bulk`, {
    method: "POST",
    body: JSON.stringify({ ...target.body, items, move: elements.itemPickerMove.checked }),
  }));
  picker.selected.clear();
  await refreshCategories();
  await Promise.all([runPickerSearch(), refreshReceivedCount()]);
  const parts = [];
  if (result.linked) parts.push(`새로 연결 ${result.linked}개`);
  if (result.moved) parts.push(`옮겨 옴 ${result.moved}개`);
  if (result.skipped) parts.push(`다른 곳에 연결돼 있어 건너뜀 ${result.skipped}개`);
  showToast(parts.length ? `${target.path.join(" › ")}: ${parts.join(" · ")}` : "바뀐 연결이 없습니다.");
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

// ------------------------------------------------------------------ 저장하지 않은 입력(임시 보관)

/**
 * 집행서마다 저장하지 않은 실행예산 · 비고를 이 브라우저에 보관합니다.
 * 다른 탭이나 버전으로 옮기거나 새로 고침해도 다시 열면 이어서 입력할 수 있습니다.
 * 서버 값과 다른 줄만 남겨, 그사이 다른 사람이 저장한 줄은 덮어쓰지 않습니다.
 */
function storageKey(kind) {
  return `gi-${kind}:${state.user?.id || "anon"}`;
}

function readStorage(kind, fallback) {
  try {
    const raw = localStorage.getItem(storageKey(kind));
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(kind, value) {
  try {
    localStorage.setItem(storageKey(kind), JSON.stringify(value));
  } catch {
    // 저장소를 쓸 수 없는 환경(사생활 보호 창 등)이면 이 창에서만 유지합니다.
  }
}

let draftTimer = null;

function persistDrafts() {
  clearTimeout(draftTimer);
  writeStorage("drafts", state.drafts);
}

function captureDraft() {
  if (!canEditSnapshot()) return;
  const base = new Map(state.snapshot.lines.map((line) => [String(line.id), line]));
  const lines = {};
  for (const row of elements.statementRows.querySelectorAll(".statement-line")) {
    const line = base.get(row.dataset.lineId);
    const budget = parseBudgetInput(row.querySelector(".budget-input")?.value);
    const remark = row.querySelector(".remark-input")?.value ?? "";
    if (line && (budget !== Number(line.executionBudget) || remark !== String(line.remark ?? ""))) {
      lines[row.dataset.lineId] = { budget, remark };
    }
  }
  if (Object.keys(lines).length) {
    state.drafts[state.snapshot.id] = { revision: state.snapshot.revision, savedAt: new Date().toISOString(), lines };
  } else {
    delete state.drafts[state.snapshot.id];
  }
  clearTimeout(draftTimer);
  draftTimer = setTimeout(persistDrafts, 300);
  renderTabs();
}

function clearDraft(snapshotId) {
  if (!snapshotId || !state.drafts[snapshotId]) return;
  delete state.drafts[snapshotId];
  persistDrafts();
  renderTabs();
}

/** 보관해 둔 입력을 표에 다시 채웁니다. 채운 줄이 있으면 true. */
function applyDraft() {
  const draft = state.drafts[state.snapshot?.id];
  if (!draft || !canEditSnapshot()) return false;
  let applied = 0;
  for (const row of elements.statementRows.querySelectorAll(".statement-line")) {
    const saved = draft.lines[row.dataset.lineId];
    if (!saved) continue;
    row.querySelector(".budget-input").value = Number(saved.budget).toLocaleString("ko-KR");
    row.querySelector(".remark-input").value = saved.remark;
    applied += 1;
  }
  if (!applied) return false;
  setDirty(true);
  refreshDerivedCells();
  return true;
}

// ------------------------------------------------------------------ 탭

const LIST_TAB_KEY = "screen:list";
/** 너무 많이 열리면 왼쪽(먼저 연) 탭부터 닫습니다. 저장하지 않은 입력은 탭을 닫아도 남습니다. */
const MAX_TABS = 15;
const ADMIN_SCREENS = new Set(["settings", "amarance", "security", "users", "audit"]);
/** '새 창으로 열기'로 연 창은 주소의 #tab=... 화면 하나만 열고, 탭 목록을 저장하지 않습니다. */
const POPOUT = (() => {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const key = params.get("tab");
  return key ? { key, snapshotId: Number(params.get("snapshot")) || null } : null;
})();
/** 탭마다 보던 스크롤 위치. */
const tabScroll = new Map();
let tabDrag = null;
let tabMenuItems = [];

function persistTabs() {
  if (POPOUT) return;
  writeStorage("tabs", {
    tabs: state.tabs.map(({ key, kind, screen, projectId, snapshotId, title }) => ({ key, kind, screen, projectId, snapshotId, title })),
    active: state.activeTabKey,
  });
}

function tabMeta(tab) {
  if (tab.kind === "statement") return { icon: SCREEN_META.statement.icon, title: tab.title, full: tab.fullTitle || tab.title };
  const meta = SCREEN_META[tab.screen];
  return { icon: meta.icon, title: meta.title, full: meta.title };
}

function renderTabs() {
  elements.tabBar.innerHTML = state.tabs.map((tab) => {
    const active = tab.key === state.activeTabKey;
    const dirty = tab.kind === "statement" && state.drafts[tab.snapshotId];
    const meta = tabMeta(tab);
    const hint = `${meta.full}\n(오른쪽 버튼: 탭 메뉴 · 가운데 버튼: 닫기 · 끌어서 순서 변경)`;
    return `
      <div class="tab${active ? " active" : ""}" role="tab" tabindex="0" aria-selected="${active}" draggable="true" data-key="${escapeHtml(tab.key)}" title="${escapeHtml(hint)}">
        <span class="tab-icon" aria-hidden="true">${meta.icon}</span>
        <span class="tab-label">${escapeHtml(meta.title)}</span>
        ${dirty ? '<span class="tab-dirty" aria-label="저장하지 않은 입력 있음">●</span>' : ""}
        ${tab.key === LIST_TAB_KEY ? "" : `<button type="button" class="tab-x" tabindex="-1" aria-label="${escapeHtml(meta.title)} 닫기">×</button>`}
      </div>`;
  }).join("");
  revealActiveTab();
}

/** 탭이 넘쳐 가려졌으면 지금 탭이 보이게 가로로 옮깁니다. */
function revealActiveTab() {
  const bar = elements.tabBar;
  const tab = bar.querySelector(".tab.active");
  if (!tab) return;
  if (tab.offsetLeft < bar.scrollLeft) bar.scrollLeft = tab.offsetLeft;
  else if (tab.offsetLeft + tab.offsetWidth > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = tab.offsetLeft + tab.offsetWidth - bar.clientWidth;
}

function ensureTab(tab) {
  if (!state.tabs.some((item) => item.key === tab.key)) {
    state.tabs.push(tab);
    while (state.tabs.length > MAX_TABS) {
      const oldest = state.tabs.findIndex((item) => item.key !== LIST_TAB_KEY && item.key !== tab.key && item.key !== state.activeTabKey);
      if (oldest < 0) break;
      tabScroll.delete(state.tabs[oldest].key);
      state.tabs.splice(oldest, 1);
    }
  }
  return state.tabs.find((item) => item.key === tab.key);
}

async function activateTab(key) {
  const tab = state.tabs.find((item) => item.key === key);
  if (!tab) return;
  if (state.activeTabKey && state.activeTabKey !== key) tabScroll.set(state.activeTabKey, window.scrollY);
  state.activeTabKey = key;
  persistTabs();
  renderTabs();
  if (tab.kind === "screen") await setScreen(tab.screen);
  else await showStatementTab(tab);
  window.scrollTo(0, tabScroll.get(key) ?? 0);
}

function openScreenTab(screen) {
  ensureTab({ key: `screen:${screen}`, kind: "screen", screen });
  return activateTab(`screen:${screen}`);
}

/** 프로젝트 하나에 탭 하나를 씁니다. 이미 열려 있으면 그 탭으로 가서 원하는 버전을 보여 줍니다. */
function openStatementTab(projectId, snapshotId = null) {
  const project = state.projects.find((item) => item.id === Number(projectId));
  const tab = ensureTab({ key: `project:${projectId}`, kind: "statement", projectId: Number(projectId), snapshotId: null, title: project?.code || "기성집행서" });
  if (snapshotId) tab.snapshotId = Number(snapshotId);
  return activateTab(tab.key);
}

async function showStatementTab(tab) {
  await setScreen(SCREEN.STATEMENT);
  state.selectedProjectId = tab.projectId;
  renderProjects();
  await busy(() => loadSnapshots(tab.snapshotId));
}

/** 지금 보는 집행서 버전을 탭 이름 · 저장 정보에 반영합니다. */
function syncStatementTab() {
  const tab = state.tabs.find((item) => item.key === state.activeTabKey);
  if (!tab || tab.kind !== "statement") return;
  const project = state.projects.find((item) => item.id === tab.projectId);
  tab.snapshotId = state.snapshot?.id || null;
  tab.title = `${project?.code || "기성집행서"}${state.snapshot ? ` v${state.snapshot.versionNo}` : ""}`;
  tab.fullTitle = [project?.code, project?.name, state.snapshot ? `v${state.snapshot.versionNo} ${state.snapshot.title}` : ""].filter(Boolean).join(" · ");
  persistTabs();
  renderTabs();
}

/**
 * 탭 여러 개를 닫습니다. 지금 보던 탭이 닫히면 오른쪽(없으면 왼쪽)에 남은 탭으로 갑니다.
 * '기성집행서 목록' 탭은 닫지 않고, 저장하지 않은 입력도 지우지 않습니다(같은 집행서를 다시 열면 이어서 입력).
 */
async function closeTabs(keys) {
  const remove = new Set(keys.filter((key) => key !== LIST_TAB_KEY));
  if (!remove.size) return;
  const index = state.tabs.findIndex((item) => item.key === state.activeTabKey);
  const next = remove.has(state.activeTabKey)
    ? state.tabs.slice(index + 1).find((item) => !remove.has(item.key)) || state.tabs.slice(0, index).reverse().find((item) => !remove.has(item.key))
    : null;
  state.tabs = state.tabs.filter((item) => !remove.has(item.key));
  for (const key of remove) tabScroll.delete(key);
  if (next) {
    state.activeTabKey = null;
    await activateTab(next.key);
  } else {
    persistTabs();
    renderTabs();
  }
}

/** 새로고침: 서버에서 다시 읽고 검색 조건 · 스크롤을 처음으로 돌립니다(저장하지 않은 집행서 입력은 남깁니다). */
async function reloadTab(key) {
  const tab = state.tabs.find((item) => item.key === key);
  if (!tab) return;
  if (tab.screen === SCREEN.LIST) {
    elements.statementListSearch.value = "";
    elements.statementListStatus.value = "";
    elements.statementListLatest.checked = true;
  }
  if (tab.screen === SCREEN.PROJECTS) {
    elements.projectListSearch.value = "";
    elements.projectListStatus.value = "";
  }
  if (tab.screen === SCREEN.SECURITY || tab.screen === SCREEN.AMARANCE) state.integrationLoaded = false;
  tabScroll.delete(key);
  if (state.activeTabKey === key) state.activeTabKey = null;
  await activateTab(key);
}

/** 그 화면만 새 창으로 엽니다. 새 창은 이 창의 탭 목록을 물려받지 않습니다. */
function popOutTab(tab) {
  const params = new URLSearchParams({ tab: tab.key });
  if (tab.kind === "statement" && tab.snapshotId) params.set("snapshot", String(tab.snapshotId));
  window.open(`${window.location.pathname}#${params}`, "_blank", "noopener");
}

/** 지난번에 열어 둔 탭을 되살립니다(권한이 없거나 사라진 프로젝트의 탭은 뺍니다). */
function restoreTabs() {
  const allowedScreen = (screen) => screen !== SCREEN.STATEMENT && SCREEN_META[screen] && (!ADMIN_SCREENS.has(screen) || state.permissions.canAdminister);
  const knownProject = (projectId) => state.projects.some((project) => project.id === projectId);
  state.tabs = [{ key: LIST_TAB_KEY, kind: "screen", screen: SCREEN.LIST }];
  if (POPOUT) {
    const [kind, value] = POPOUT.key.split(":");
    if (kind === "project" && knownProject(Number(value))) return openStatementTab(Number(value), POPOUT.snapshotId);
    if (kind === "screen" && allowedScreen(value) && value !== SCREEN.LIST) return openScreenTab(value);
    return activateTab(LIST_TAB_KEY);
  }
  const saved = readStorage("tabs", null);
  for (const tab of saved?.tabs || []) {
    if (tab.key === LIST_TAB_KEY || state.tabs.length >= MAX_TABS) continue;
    if ((tab.kind === "screen" && allowedScreen(tab.screen)) || (tab.kind === "statement" && knownProject(tab.projectId))) state.tabs.push({ ...tab });
  }
  const active = state.tabs.some((tab) => tab.key === saved?.active) ? saved.active : LIST_TAB_KEY;
  return activateTab(active);
}

// 탭 우클릭 메뉴

function openTabMenu(key, x, y) {
  const index = state.tabs.findIndex((item) => item.key === key);
  const tab = state.tabs[index];
  if (!tab) return;
  const closable = (item) => item.key !== LIST_TAB_KEY;
  const keysOf = (items) => items.filter(closable).map((item) => item.key);
  const left = keysOf(state.tabs.slice(0, index));
  const right = keysOf(state.tabs.slice(index + 1));
  const others = keysOf(state.tabs.filter((item) => item.key !== key));
  const all = keysOf(state.tabs);
  tabMenuItems = [
    { label: "새로고침", hint: tab.kind === "statement" ? "입력은 유지" : "처음 상태로", run: () => reloadTab(key) },
    { label: "새 창으로 열기", run: () => popOutTab(tab) },
    "-",
    { label: "닫기", hint: "Delete", run: () => closeTabs([key]), disabled: !closable(tab) },
    { label: "다른 탭 모두 닫기", run: () => closeTabs(others), disabled: !others.length },
    { label: "왼쪽 탭 모두 닫기", run: () => closeTabs(left), disabled: !left.length },
    { label: "오른쪽 탭 모두 닫기", run: () => closeTabs(right), disabled: !right.length },
    "-",
    { label: "모든 탭 닫기", run: () => closeTabs(all), disabled: !all.length },
  ];
  const menu = elements.tabMenu;
  menu.innerHTML = tabMenuItems.map((item, itemIndex) => item === "-"
    ? '<div class="tab-menu-sep" role="separator"></div>'
    : `<button type="button" role="menuitem" data-index="${itemIndex}"${item.disabled ? " disabled" : ""}>${escapeHtml(item.label)}${item.hint ? `<small>${escapeHtml(item.hint)}</small>` : ""}</button>`).join("");
  menu.classList.remove("hidden");
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
  menu.querySelector("button:not(:disabled)")?.focus();
}

function closeTabMenu() {
  elements.tabMenu.classList.add("hidden");
}

elements.tabMenu.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-index]");
  if (!button || button.disabled) return;
  const item = tabMenuItems[Number(button.dataset.index)];
  closeTabMenu();
  ignoreFailure(Promise.resolve(item.run()));
});
elements.tabMenu.addEventListener("keydown", (event) => {
  const buttons = [...elements.tabMenu.querySelectorAll("button:not(:disabled)")];
  const at = buttons.indexOf(document.activeElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    buttons[(at + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  } else if (event.key === "Escape" || event.key === "Tab") {
    event.preventDefault();
    closeTabMenu();
    elements.tabBar.querySelector(".tab.active")?.focus();
  }
});
document.addEventListener("mousedown", (event) => {
  if (!elements.tabMenu.classList.contains("hidden") && !elements.tabMenu.contains(event.target)) closeTabMenu();
});
// 창 크기가 실제로 바뀔 때만 닫습니다(화면 캡처 등으로 같은 크기의 resize 가 오기도 합니다).
let tabMenuViewport = `${window.innerWidth}x${window.innerHeight}`;
window.addEventListener("resize", () => {
  const size = `${window.innerWidth}x${window.innerHeight}`;
  if (size !== tabMenuViewport) closeTabMenu();
  tabMenuViewport = size;
});
window.addEventListener("blur", closeTabMenu);

// 탭 누르기 · 닫기 · 키보드 · 끌어서 순서 바꾸기

const tabKeyOf = (event) => event.target.closest(".tab")?.dataset.key;

elements.tabBar.addEventListener("click", (event) => {
  const key = tabKeyOf(event);
  if (!key) return;
  if (event.target.closest(".tab-x")) ignoreFailure(closeTabs([key]));
  else if (key !== state.activeTabKey) ignoreFailure(activateTab(key));
});
// 가운데 버튼으로 닫기(가운데 버튼의 자동 스크롤은 막습니다).
elements.tabBar.addEventListener("mousedown", (event) => {
  if (event.button === 1 && tabKeyOf(event)) event.preventDefault();
});
elements.tabBar.addEventListener("auxclick", (event) => {
  const key = tabKeyOf(event);
  if (event.button === 1 && key) ignoreFailure(closeTabs([key]));
});
elements.tabBar.addEventListener("contextmenu", (event) => {
  const key = tabKeyOf(event);
  if (!key) return;
  event.preventDefault();
  openTabMenu(key, event.clientX, event.clientY);
});
elements.tabBar.addEventListener("keydown", (event) => {
  const key = tabKeyOf(event);
  if (!key) return;
  const element = event.target.closest(".tab");
  if (event.key === "Enter" && key !== state.activeTabKey) ignoreFailure(activateTab(key));
  else if (event.key === "Delete") ignoreFailure(closeTabs([key]));
  else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    event.preventDefault();
    (event.key === "ArrowRight" ? element.nextElementSibling : element.previousElementSibling)?.focus();
  } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    event.preventDefault();
    const rect = element.getBoundingClientRect();
    openTabMenu(key, rect.left, rect.bottom + 2);
  }
});
// 탭이 넘치면 마우스 휠로 가로로 넘깁니다.
elements.tabBar.addEventListener("wheel", (event) => {
  const bar = elements.tabBar;
  if (bar.scrollWidth <= bar.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  event.preventDefault();
  bar.scrollLeft += event.deltaY;
}, { passive: false });

function clearDropMarks() {
  elements.tabBar.querySelectorAll(".drop-before, .drop-after").forEach((element) => element.classList.remove("drop-before", "drop-after"));
}

elements.tabBar.addEventListener("dragstart", (event) => {
  const element = event.target.closest(".tab");
  if (!element) return;
  tabDrag = element.dataset.key;
  element.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", element.querySelector(".tab-label").textContent);
});
elements.tabBar.addEventListener("dragover", (event) => {
  const element = event.target.closest(".tab");
  if (!tabDrag || !element) return;
  event.preventDefault();
  clearDropMarks();
  if (element.dataset.key === tabDrag) return;
  const rect = element.getBoundingClientRect();
  element.classList.add(event.clientX > rect.left + rect.width / 2 ? "drop-after" : "drop-before");
});
elements.tabBar.addEventListener("drop", (event) => {
  const element = event.target.closest(".tab");
  if (!tabDrag || !element) return;
  event.preventDefault();
  const target = element.dataset.key;
  if (target !== tabDrag) {
    const rect = element.getBoundingClientRect();
    const after = event.clientX > rect.left + rect.width / 2;
    const moving = state.tabs.find((item) => item.key === tabDrag);
    const rest = state.tabs.filter((item) => item.key !== tabDrag);
    const at = rest.findIndex((item) => item.key === target) + (after ? 1 : 0);
    state.tabs = [...rest.slice(0, at), moving, ...rest.slice(at)];
    persistTabs();
  }
  tabDrag = null;
  renderTabs();
});
elements.tabBar.addEventListener("dragend", () => {
  tabDrag = null;
  clearDropMarks();
  elements.tabBar.querySelector(".dragging")?.classList.remove("dragging");
});

// ------------------------------------------------------------------ 기성집행서 목록

async function loadStatementList() {
  state.statementList = await api(API.SNAPSHOTS);
  renderStatementList();
}

function renderStatementList() {
  const keyword = elements.statementListSearch.value.trim().toLowerCase();
  const status = elements.statementListStatus.value;
  const latestOnly = elements.statementListLatest.checked;
  const rows = state.statementList.filter((item) => {
    if (latestOnly && !item.isLatest) return false;
    if (status && item.status !== status) return false;
    if (!keyword) return true;
    return [item.projectCode, item.projectName, item.title].some((value) => String(value || "").toLowerCase().includes(keyword));
  });
  elements.statementListCount.textContent = `${rows.length.toLocaleString("ko-KR")}건`;
  elements.statementListRows.innerHTML = rows.length ? rows.map((item) => {
    const isDraft = item.status === SNAPSHOT_STATUS.DRAFT;
    const hasLocalDraft = Boolean(state.drafts[item.id]);
    return `
      <tr class="list-row" tabindex="0" data-project-id="${item.projectId}" data-snapshot-id="${item.id}">
        <td><strong class="list-code">${escapeHtml(item.projectCode)}</strong><small>${escapeHtml(item.projectName)}${item.isArchived ? " · 보관" : ""}</small></td>
        <td>v${item.versionNo} · ${escapeHtml(item.title)}${item.isLatest ? "" : "<small>이전 버전</small>"}</td>
        <td><span class="badge ${isDraft ? "draft" : "confirmed"}">${REPORT_STATUS_LABEL[item.status]}</span>${hasLocalDraft ? '<small class="local-draft">● 저장 안 된 입력</small>' : ""}</td>
        <td class="number-cell">${formatWon(item.contractAmount)}</td>
        <td class="number-cell">${formatWon(item.executionBudget)}</td>
        <td class="number-cell">${formatWon(item.purchaseAmount)}${item.unmappedCount ? `<small class="list-unmapped">미분류 ${item.unmappedCount.toLocaleString("ko-KR")}건</small>` : ""}</td>
        <td class="number-cell ${item.profitAmount < 0 ? "negative" : ""}">${formatPercent(item.profitRate)}</td>
        <td>${progressMarkup(item.executionRate)}</td>
        <td class="muted-cell">${item.receiptsFetchedAt ? formatDateTime(item.receiptsFetchedAt) : "불러오기 전"}</td>
        <td class="muted-cell">${formatDateTime(item.updatedAt)}<small>${escapeHtml(item.confirmedBy || item.createdBy || "")}</small></td>
      </tr>`;
  }).join("") : `<tr><td class="empty-row" colspan="10">${state.statementList.length
    ? "조건에 맞는 기성집행서가 없습니다."
    : "아직 등록된 기성집행서가 없습니다. ＋ 새 기성집행서로 시작하세요."}</td></tr>`;
  applyProgressWidths(elements.statementListRows);
  elements.statementListRows.querySelectorAll(".list-row").forEach((row) => {
    const open = () => ignoreFailure(openStatementTab(row.dataset.projectId, row.dataset.snapshotId));
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => { if (event.key === "Enter") open(); });
  });
}

// ------------------------------------------------------------------ 새 기성집행서

function newStatementMethod() {
  return document.querySelector('input[name="newStatementMethod"]:checked')?.value || "settings";
}

/** 검색어를 띄어쓰기로 나눈 낱말들. 모든 낱말이 코드나 이름에 들어 있어야 찾은 것으로 봅니다. */
function searchTokens(text) {
  return text.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** 찾은 낱말을 <mark> 로 칠합니다(그 밖의 글자는 그대로 이스케이프). */
function highlight(text, tokens) {
  const value = String(text ?? "");
  const lower = value.toLowerCase();
  const marks = new Array(value.length).fill(false);
  for (const token of tokens) {
    for (let at = lower.indexOf(token); at >= 0; at = lower.indexOf(token, at + 1)) marks.fill(true, at, at + token.length);
  }
  let html = "";
  for (let index = 0; index < value.length;) {
    let end = index;
    while (end < value.length && marks[end] === marks[index]) end += 1;
    const part = escapeHtml(value.slice(index, end));
    html += marks[index] ? `<mark>${part}</mark>` : part;
    index = end;
  }
  return html;
}

/** 프로젝트마다 최신 집행서 버전(목록에서 계산). */
function latestStatementByProject() {
  const latest = new Map();
  for (const item of state.statementList) {
    const known = latest.get(item.projectId);
    if (!known || item.versionNo > known.versionNo) latest.set(item.projectId, item);
  }
  return latest;
}

function newStatementCandidates() {
  const tokens = searchTokens(elements.newStatementSearch.value);
  const filter = document.querySelector('input[name="newStatementFilter"]:checked')?.value || "";
  const latest = latestStatementByProject();
  const rank = (project) => {
    // 코드가 검색어로 시작하면 맨 위, 진행 중인 프로젝트를 완료보다 위에.
    const code = project.code.toLowerCase();
    return (tokens.length && tokens.every((token) => code.includes(token)) ? 0 : 2)
      - (tokens[0] && code.startsWith(tokens[0]) ? 1 : 0)
      + (project.status === "ACTIVE" ? 0 : 4);
  };
  const projects = state.projects.filter((project) => {
    if (project.isArchived) return false;
    if (filter === "EMPTY" && latest.has(project.id)) return false;
    if (filter && filter !== "EMPTY" && project.status !== filter) return false;
    const haystack = `${project.code} ${project.name}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
  projects.sort((a, b) => rank(a) - rank(b) || b.code.localeCompare(a.code));
  return { projects, tokens, latest };
}

function renderNewStatementProjects(preferredId = null) {
  const previous = preferredId || Number(elements.newStatementProject.value) || null;
  const { projects, tokens, latest } = newStatementCandidates();
  elements.newStatementCount.textContent = `${projects.length.toLocaleString("ko-KR")}건`;
  elements.newStatementList.innerHTML = projects.length ? projects.map((project) => {
    const statement = latest.get(project.id);
    const version = statement
      ? `<span class="chip ${statement.status === SNAPSHOT_STATUS.CONFIRMED ? "chip-green" : "chip-amber"}">v${statement.versionNo} ${REPORT_STATUS_LABEL[statement.status]}</span>`
      : '<span class="chip">집행서 없음</span>';
    return `
      <div class="project-option" role="option" id="project-option-${project.id}" data-project-id="${project.id}" aria-selected="false">
        <span class="project-option-main">
          <strong>${highlight(project.code, tokens)}</strong>
          <span>${highlight(project.name, tokens)}</span>
        </span>
        <span class="project-option-meta">
          <span class="project-option-amount">${formatWon(project.contractAmount)}</span>
          <span class="chip ${project.status === "ACTIVE" ? "chip-blue" : ""}">${project.status === "ACTIVE" ? "진행" : "완료"}</span>
          ${version}
        </span>
        <span class="project-option-check" aria-hidden="true">✓</span>
      </div>`;
  }).join("") : `
      <div class="project-options-empty">
        <strong>찾는 프로젝트가 없습니다.</strong>
        <span>검색어나 걸러 보기를 바꿔 보세요. 아마란스10에 새로 생긴 프로젝트라면 '프로젝트' 화면에서 동기화하세요.</span>
      </div>`;
  const keep = projects.find((project) => project.id === previous) || projects[0];
  return selectNewStatementProject(keep?.id || null);
}

/** 프로젝트 하나를 고르고(목록에 표시), 복제할 버전 목록을 불러옵니다. */
function selectNewStatementProject(projectId, { reveal = true } = {}) {
  elements.newStatementProject.value = projectId ? String(projectId) : "";
  let selected = null;
  for (const option of elements.newStatementList.querySelectorAll(".project-option")) {
    const on = Number(option.dataset.projectId) === Number(projectId);
    option.classList.toggle("selected", on);
    option.setAttribute("aria-selected", String(on));
    if (on) selected = option;
  }
  elements.newStatementSearch.setAttribute("aria-activedescendant", selected?.id || "");
  if (selected && reveal) selected.scrollIntoView({ block: "nearest" });
  return loadNewStatementVersions();
}

function moveNewStatementSelection(step) {
  const options = [...elements.newStatementList.querySelectorAll(".project-option")];
  if (!options.length) return;
  const at = options.findIndex((option) => option.classList.contains("selected"));
  const next = options[Math.min(options.length - 1, Math.max(0, at + step))];
  ignoreFailure(selectNewStatementProject(Number(next.dataset.projectId)));
}

let newStatementVersionSeq = 0;

async function loadNewStatementVersions() {
  const projectId = Number(elements.newStatementProject.value);
  const seq = ++newStatementVersionSeq;
  const versions = projectId ? await api(`/api/projects/${projectId}/snapshots`) : [];
  // 목록을 빠르게 오르내리면 늦게 온 이전 응답이 덮어쓰지 않게 합니다.
  if (seq !== newStatementVersionSeq) return;
  elements.newStatementClone.innerHTML = versions.map((version) => `
    <option value="${version.id}">v${version.versionNo} · ${escapeHtml(version.title)}${version.status === SNAPSHOT_STATUS.CONFIRMED ? " (확정)" : ""}</option>`).join("");
  elements.newStatementCloneOption.disabled = versions.length === 0;
  elements.newStatementCloneHint.textContent = !versions.length
    ? "이 프로젝트에는 아직 복제할 버전이 없습니다."
    : versions.length === 1
      ? `v${versions[0].versionNo} 의 실행예산 · 비고를 그대로 가져옵니다.`
      : `버전 ${versions.length}개 중 하나를 골라 실행예산 · 비고를 그대로 가져옵니다.`;
  if (!versions.length && newStatementMethod() === "clone") {
    document.querySelector('input[name="newStatementMethod"][value="settings"]').checked = true;
  }
  updateNewStatementFields();
}

function updateNewStatementFields() {
  const clone = newStatementMethod() === "clone";
  elements.newStatementCloneField.classList.toggle("hidden", !clone);
  elements.newStatementSetField.classList.toggle("hidden", clone);
}

async function openNewStatementDialog(projectId = null) {
  if (!state.statementList.length) await ignoreFailure(loadStatementList());
  elements.newStatementSearch.value = "";
  document.querySelector('input[name="newStatementFilter"][value=""]').checked = true;
  elements.newStatementError.hidden = true;
  elements.newStatementSet.innerHTML = state.categorySets.map((set) => `
    <option value="${set.id}">${escapeHtml(categorySetLabel(set))}${set.isCurrent ? " (사용 중)" : ""}</option>`).join("");
  const current = state.categorySets.find((set) => set.isCurrent);
  if (current) elements.newStatementSet.value = String(current.id);
  document.querySelector('input[name="newStatementMethod"][value="settings"]').checked = true;
  await renderNewStatementProjects(projectId);
  openDialog(elements.newStatementDialog, () => {});
  setTimeout(() => elements.newStatementSearch.focus(), 0);
}

async function submitNewStatement() {
  const projectId = Number(elements.newStatementProject.value);
  if (!projectId) {
    elements.newStatementError.textContent = "프로젝트를 골라 주세요.";
    elements.newStatementError.hidden = false;
    return;
  }
  const body = newStatementMethod() === "clone"
    ? { cloneSnapshotId: Number(elements.newStatementClone.value) }
    : { categorySetId: Number(elements.newStatementSet.value) || null };
  const created = await busy(() => api(`/api/projects/${projectId}/snapshots`, { method: "POST", body: JSON.stringify(body) }));
  elements.newStatementDialog.close("done");
  await ignoreFailure(loadStatementList());
  await openStatementTab(projectId, created.id);
  showToast(`v${created.versionNo} 기성집행서를 만들었습니다. 매입금액을 불러오고 실행예산을 입력하세요.`);
}

// ------------------------------------------------------------------ 프로젝트

async function loadProjectList() {
  const result = await api(API.PROJECTS);
  state.projectList = result.projects;
  state.projectSync = result.sync;
  renderProjectList();
  renderProjectSync();
}

function renderProjectList() {
  const keyword = elements.projectListSearch.value.trim().toLowerCase();
  const filter = elements.projectListStatus.value;
  const rows = state.projectList.filter((project) => {
    if (filter === "ARCHIVED" && !project.isArchived) return false;
    if (filter && filter !== "ARCHIVED" && (project.status !== filter || project.isArchived)) return false;
    return !keyword || project.code.toLowerCase().includes(keyword) || project.name.toLowerCase().includes(keyword);
  });
  elements.projectListCount.textContent = `${rows.length.toLocaleString("ko-KR")}건`;
  elements.projectListRows.innerHTML = rows.length ? rows.map((project) => {
    const statusText = project.isArchived ? "보관" : project.status === "ACTIVE" ? "진행" : "완료";
    const statement = project.snapshotCount
      ? `${project.snapshotCount.toLocaleString("ko-KR")}개 · 최신 v${project.latestVersionNo} ${REPORT_STATUS_LABEL[project.latestStatus]}`
      : '<span class="muted-cell">없음</span>';
    const action = project.snapshotCount
      ? `<button class="table-action open-project" data-project-id="${project.id}">집행서 열기</button>`
      : (state.permissions.canEdit && !project.isArchived
        ? `<button class="table-action new-project-statement" data-project-id="${project.id}">새로 만들기</button>`
        : "");
    return `
      <tr>
        <td><strong class="list-code">${escapeHtml(project.code)}</strong></td>
        <td>${escapeHtml(project.name)}</td>
        <td class="number-cell">${formatWon(project.contractAmount)}</td>
        <td><span class="pill ${project.isArchived ? "off" : project.status === "ACTIVE" ? "on" : ""}"><i aria-hidden="true"></i>${statusText}</span></td>
        <td>${statement}</td>
        <td class="muted-cell">${formatDateTime(project.syncedAt)}</td>
        <td class="actions-column">${action}</td>
      </tr>`;
  }).join("") : `<tr><td class="empty-row" colspan="7">${state.projectList.length
    ? "조건에 맞는 프로젝트가 없습니다."
    : "프로젝트가 없습니다. '지금 동기화'로 아마란스10에서 가져오세요."}</td></tr>`;
  elements.projectListRows.querySelectorAll(".open-project").forEach((button) =>
    button.addEventListener("click", () => ignoreFailure(openStatementTab(button.dataset.projectId))));
  elements.projectListRows.querySelectorAll(".new-project-statement").forEach((button) =>
    button.addEventListener("click", () => ignoreFailure(openNewStatementDialog(Number(button.dataset.projectId)))));
}

function renderProjectSync() {
  const sync = state.projectSync;
  if (!sync) return;
  const last = sync.last;
  const lastText = last
    ? `마지막 ${last.trigger === "auto" ? "자동" : "수동"} 동기화 ${formatDateTime(last.at)} · `
      + (last.ok
        ? `받은 프로젝트 ${last.summary?.received ?? 0}건 (추가 ${last.summary?.created ?? 0} · 갱신 ${last.summary?.updated ?? 0} · 보관 ${last.summary?.archived ?? 0})`
        : `실패: ${last.error}`)
    : "아직 동기화한 기록이 없습니다.";
  const schedule = sync.schedule;
  const nextText = schedule.enabled
    ? `자동 동기화: ${schedule.mode === "interval" ? `${schedule.intervalHours}시간마다` : `매일 ${schedule.time}`}${sync.nextAt ? ` · 다음 예정 ${formatDateTime(sync.nextAt)}` : ""}`
    : "자동 동기화 꺼짐";
  elements.projectSyncStatus.textContent = `${lastText}\n${nextText}`;
  elements.projectSyncStatus.classList.toggle("failed", Boolean(last && !last.ok));
  elements.syncEnabled.checked = schedule.enabled;
  elements.syncMode.value = schedule.mode;
  elements.syncTime.value = schedule.time;
  elements.syncInterval.value = String(schedule.intervalHours);
  updateSyncFields();
}

function updateSyncFields() {
  const interval = elements.syncMode.value === "interval";
  elements.syncTimeField.classList.toggle("hidden", interval);
  elements.syncIntervalField.classList.toggle("hidden", !interval);
}

async function syncProjectsNow() {
  const result = await busy(() => api(API.PROJECT_SYNC, { method: "POST", body: "{}" }));
  state.projects = result.projects;
  state.projectSync = result.sync;
  renderProjects();
  await ignoreFailure(loadProjectList());
  if (state.statementList.length) await ignoreFailure(loadStatementList());
  reportSyncResult(result.summary);
}

async function saveProjectSyncSchedule() {
  state.projectSync = await busy(() => api(API.PROJECT_SYNC_SCHEDULE, {
    method: "PUT",
    body: JSON.stringify({
      enabled: elements.syncEnabled.checked,
      mode: elements.syncMode.value,
      time: elements.syncTime.value,
      intervalHours: Number(elements.syncInterval.value),
    }),
  }));
  renderProjectSync();
  showToast(state.projectSync.schedule.enabled ? "자동 동기화를 저장했습니다." : "자동 동기화를 껐습니다.");
}

// ------------------------------------------------------------------ 이벤트 연결

document.querySelectorAll(".nav-item").forEach((button) =>
  button.addEventListener("click", () => ignoreFailure(openScreenTab(button.dataset.screen))));
elements.statementListSearch.addEventListener("input", () => renderStatementList());
elements.statementListStatus.addEventListener("change", () => renderStatementList());
elements.statementListLatest.addEventListener("change", () => renderStatementList());
elements.newStatementButton.addEventListener("click", () => ignoreFailure(openNewStatementDialog()));
elements.newStatementSearch.addEventListener("input", () => ignoreFailure(renderNewStatementProjects()));
document.querySelectorAll('input[name="newStatementFilter"]').forEach((radio) =>
  radio.addEventListener("change", () => ignoreFailure(renderNewStatementProjects())));
elements.newStatementList.addEventListener("click", (event) => {
  const option = event.target.closest(".project-option");
  if (option) ignoreFailure(selectNewStatementProject(Number(option.dataset.projectId), { reveal: false }));
});
// 두 번 누르면 바로 만듭니다.
elements.newStatementList.addEventListener("dblclick", (event) => {
  if (event.target.closest(".project-option")) elements.newStatementForm.requestSubmit();
});
// 검색칸에서 ↑ ↓ 로 고르고, Enter 는 '만들고 열기' 로 넘어갑니다(실수로 바로 만들어지지 않게).
elements.newStatementSearch.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveNewStatementSelection(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    if (elements.newStatementProject.value) elements.newStatementForm.querySelector('button[value="confirm"]').focus();
  }
});
document.querySelectorAll('input[name="newStatementMethod"]').forEach((radio) => radio.addEventListener("change", updateNewStatementFields));
elements.newStatementForm.addEventListener("submit", (event) => {
  event.preventDefault();
  ignoreFailure(submitNewStatement());
});
elements.projectListSearch.addEventListener("input", () => renderProjectList());
elements.projectListStatus.addEventListener("change", () => renderProjectList());
elements.syncMode.addEventListener("change", updateSyncFields);
elements.projectSyncForm.addEventListener("submit", (event) => {
  event.preventDefault();
  ignoreFailure(saveProjectSyncSchedule());
});

elements.projectFilter.addEventListener("input", () => renderProjects());
elements.receiptSearch.addEventListener("input", () => renderReceipts());
elements.saveBarButton.addEventListener("click", () => ignoreFailure(saveStatement()));
elements.discardChangesButton.addEventListener("click", async () => {
  const discard = await askConfirm({
    title: "입력한 내용 되돌리기",
    message: "저장하지 않은 실행예산과 비고를 버리고 마지막으로 저장한 값으로 되돌립니다.",
    confirmLabel: "되돌리기",
    danger: true,
  });
  if (!discard) return;
  clearDraft(state.snapshot.id);
  setDirty(false);
  renderStatementRows();
  renderSummary();
});
elements.receiptFilter.addEventListener("change", () => renderReceipts());
elements.showUnmappedButton.addEventListener("click", () => showReceipts(RECEIPT_FILTER.UNMAPPED));
elements.projectSelect.addEventListener("change", async () => {
  const nextId = Number(elements.projectSelect.value);
  state.selectedProjectId = nextId;
  renderProjects();
  await ignoreFailure(busy(() => loadSnapshots()));
});
elements.snapshotSelect.addEventListener("change", async () => {
  const nextId = elements.snapshotSelect.value;
  await ignoreFailure(busy(() => loadSnapshots(nextId)));
});

elements.newSnapshotButton.addEventListener("click", () => ignoreFailure(createSnapshot(false)));
elements.emptyNewSnapshotButton.addEventListener("click", () => ignoreFailure(createSnapshot(false)));
elements.cloneSnapshotButton.addEventListener("click", () => ignoreFailure(createSnapshot(true)));
elements.renameSnapshotButton.addEventListener("click", () => ignoreFailure(renameSnapshot()));
elements.deleteSnapshotButton.addEventListener("click", () => ignoreFailure(deleteSnapshot()));
elements.toggleSnapshotStatusButton.addEventListener("click", () => ignoreFailure(confirmSnapshot()));
elements.refreshContractButton.addEventListener("click", () => ignoreFailure(refreshContractAmount()));
elements.importReceiptsButton.addEventListener("click", () => ignoreFailure(importReceipts()));
elements.refreshReceiptsButton.addEventListener("click", () => ignoreFailure(refreshReceipts()));
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
elements.syncProjectsButton.addEventListener("click", () => ignoreFailure(syncProjectsNow()));

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
elements.addMinorButton.addEventListener("click", () => ignoreFailure(addMinor()));
elements.openItemPickerButton.addEventListener("click", () => ignoreFailure(openItemPicker()));
elements.itemPickerQuery.addEventListener("input", schedulePickerSearch);
elements.itemPickerQuery.addEventListener("keydown", (event) => {
  // 검색 창 안의 Enter 가 대화상자를 닫지 않고 바로 검색하도록 합니다.
  if (event.key !== "Enter" || event.isComposing) return;
  event.preventDefault();
  clearTimeout(picker.timer);
  ignoreFailure(runPickerSearch());
});
document.querySelectorAll('input[name="itemPickerMode"]').forEach((radio) => radio.addEventListener("change", () => {
  elements.itemPickerQuery.placeholder = pickerMode() === "prefix"
    ? "품번 앞자리 (예: ET-, A-A0)"
    : "품번 · 품명 · 규격 일부 (띄어 쓰면 모두 포함)";
  elements.itemPickerQuery.focus();
  ignoreFailure(runPickerSearch());
}));
elements.itemPickerDialog.querySelectorAll(".picker-tab").forEach((tab) =>
  tab.addEventListener("click", () => setPickerScope(tab.dataset.scope)));
elements.itemPickerMove.addEventListener("change", () => renderPicker());
elements.itemPickerRefresh.addEventListener("click", () => ignoreFailure(runPickerSearch({ refresh: true })));
elements.itemPickerAll.addEventListener("change", () => {
  const target = itemMappingTarget();
  picker.selected.clear();
  if (elements.itemPickerAll.checked && target) {
    picker.items.filter((item) => pickerSelectable(item, target)).forEach((item) => picker.selected.add(item.itemCode));
  }
  renderPicker();
});
elements.itemPickerLink.addEventListener("click", () => ignoreFailure(linkPickedItems()));
elements.itemPickerForm.addEventListener("submit", (event) => event.preventDefault());

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
  const build = bootstrap.buildInfo;
  elements.buildStamp.textContent = build
    ? `${build.version}${build.builtAt ? ` · ${String(build.builtAt).slice(0, 10)}` : ""}`
    : "";
  state.drafts = readStorage("drafts", {});
  renderProjects();
  renderCategorySets();
  renderSettings();
  setDirty(false);
  await restoreTabs();
}

initialize().catch((error) => {
  if (error.message === "로그인이 필요합니다.") return;
  showStartupFailure(error.message || "서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.");
});
