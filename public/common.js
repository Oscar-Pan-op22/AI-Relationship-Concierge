export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function fetchJson(url, options) {
  const response = await fetch(url, options);
  let payload = {};

  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const error = new Error(payload.error || "请求失败。");
    error.statusCode = response.status;
    throw error;
  }

  return payload;
}

export async function requireAuth() {
  try {
    const { user, twin } = await fetchJson("/api/auth/me");
    setCurrentUser(user);
    return { user, twin };
  } catch (error) {
    if (error.statusCode === 401) {
      window.location.href = "/auth.html";
      return null;
    }

    throw error;
  }
}

export function formatDateTime(value) {
  if (!value) {
    return "未记录";
  }

  return new Date(value).toLocaleString();
}

export function renderEmptyState(title, body, eyebrow = "同频") {
  return `
    <div class="empty-state">
      <p class="eyebrow">${escapeHtml(eyebrow)}</p>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(body)}</p>
    </div>
  `;
}

export function setCurrentUser(user) {
  const target = document.querySelector("[data-current-user]");

  if (target) {
    target.textContent = user ? `${user.displayName} · ${user.email}` : "未登录";
  }
}

export async function logout() {
  await fetchJson("/api/auth/logout", { method: "POST" });
  window.location.href = "/auth.html";
}
