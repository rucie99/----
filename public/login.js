const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
let csrfToken = "";

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      ...(options.headers || {}),
    },
  });
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.message || "요청 처리에 실패했습니다.");
    error.code = data?.code;
    throw error;
  }
  return data;
}

function showError(element, message) {
  element.textContent = message;
  element.hidden = !message;
}

function switchToPasswordForm() {
  elements.loginForm.hidden = true;
  elements.passwordForm.hidden = false;
  elements.currentPassword.value = elements.password.value;
  elements.newPassword.focus();
}

function withBusy(button, action) {
  return async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = "처리 중…";
    try {
      await action();
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  };
}

elements.loginForm.addEventListener("submit", withBusy(elements.loginSubmit, async () => {
  showError(elements.loginError, "");
  const loginId = elements.loginId.value.trim();
  const password = elements.password.value;
  if (!loginId || !password) {
    showError(elements.loginError, "로그인 ID와 비밀번호를 입력해 주세요.");
    return;
  }
  try {
    const result = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ loginId, password }) });
    csrfToken = result.csrfToken;
    if (result.user?.mustChangePassword) {
      switchToPasswordForm();
      return;
    }
    window.location.replace("/");
  } catch (error) {
    showError(elements.loginError, error.message);
    elements.password.value = "";
    elements.password.focus();
  }
}));

elements.passwordForm.addEventListener("submit", withBusy(elements.passwordSubmit, async () => {
  showError(elements.passwordError, "");
  const newPassword = elements.newPassword.value;
  if (newPassword !== elements.confirmPassword.value) {
    showError(elements.passwordError, "새 비밀번호가 서로 다릅니다.");
    return;
  }
  try {
    await api("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword: elements.currentPassword.value, newPassword }),
    });
    window.location.replace("/");
  } catch (error) {
    showError(elements.passwordError, error.message);
  }
}));

// 이미 로그인된 상태로 들어오면(뒤로가기 등) 바로 본화면으로 보냅니다.
api("/api/session")
  .then((session) => {
    if (!session.authenticated) {
      elements.loginId.focus();
      return;
    }
    csrfToken = session.csrfToken;
    if (session.user?.mustChangePassword) switchToPasswordForm();
    else window.location.replace("/");
  })
  .catch(() => elements.loginId.focus());
