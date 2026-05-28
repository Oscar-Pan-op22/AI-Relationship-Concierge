import {
  escapeHtml,
  fetchJson,
  formatDateTime,
  getPrechatStatusLabel,
  getPrechatStatusTone,
  logout,
  requireAuth
} from "./common.js";

const sessionsList = document.querySelector("#sessions-list");
const statusText = document.querySelector("#sessions-status");
const logoutButton = document.querySelector("#logout-button");

let currentUserId = "";
let pinnedSessionIds = new Set();
let lastSessions = [];
let contextMenuState = { sessionId: null };

function setStatus(state, message) {
  statusText.dataset.state = state;
  statusText.textContent = message;
}

function getPinnedStorageKey(userId) {
  return `tongpin:pinned-sessions:${userId}`;
}

function loadPinnedSessionIds(userId) {
  try {
    const raw = window.localStorage.getItem(getPinnedStorageKey(userId));
    const parsed = JSON.parse(raw || "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function savePinnedSessionIds() {
  if (!currentUserId) {
    return;
  }

  window.localStorage.setItem(getPinnedStorageKey(currentUserId), JSON.stringify([...pinnedSessionIds]));
}

function isBrokenDisplayName(value) {
  const text = String(value || "").trim();
  return !text || /^\?{2,}$/u.test(text) || text.includes("\uFFFD");
}

function getCounterpart(session, userId) {
  return session.initiatorUserId === userId ? session.counterparty : session.initiator;
}

function getCounterpartName(session, userId) {
  const counterpart = getCounterpart(session, userId);
  return isBrokenDisplayName(counterpart?.displayName) ? "未命名对象" : counterpart.displayName;
}

function isPinned(sessionId) {
  return pinnedSessionIds.has(sessionId);
}

function sortSessions(sessions) {
  return [...sessions].sort((left, right) => {
    const leftPinned = isPinned(left.id) ? 1 : 0;
    const rightPinned = isPinned(right.id) ? 1 : 0;

    if (leftPinned !== rightPinned) {
      return rightPinned - leftPinned;
    }

    return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
  });
}

function renderSessionCard(session) {
  const latestSummary = session.latestStageReport?.summary || "还没有阶段总结。";
  const pinnedBadge = isPinned(session.id) ? '<span class="pill low session-pin-badge">已置顶</span>' : "";

  return `
    <article
      class="stack-item session-list-item ${isPinned(session.id) ? "session-list-item--pinned" : ""}"
      data-session-id="${escapeHtml(session.id)}"
      role="link"
      tabindex="0"
      aria-label="打开与 ${escapeHtml(getCounterpartName(session, currentUserId))} 的会话"
    >
      <header>
        <div class="session-list-title">
          <strong>${escapeHtml(getCounterpartName(session, currentUserId))}</strong>
          ${pinnedBadge}
        </div>
        <span class="pill ${escapeHtml(getPrechatStatusTone(session.status))}">${escapeHtml(getPrechatStatusLabel(session.status))}</span>
      </header>
      <p><strong>最近更新时间：</strong>${escapeHtml(formatDateTime(session.updatedAt))}</p>
      <p><strong>阶段摘要：</strong>${escapeHtml(latestSummary)}</p>
    </article>
  `;
}

function renderSessions(sessions) {
  lastSessions = sessions;

  if (!sessions.length) {
    sessionsList.innerHTML = `
      <article class="stack-item">
        <p>当前还没有任何会话。你可以先从双边匹配里选择对象，或等待对方向你发起预沟通。</p>
      </article>
    `;
    return;
  }

  sessionsList.innerHTML = sortSessions(sessions).map((session) => renderSessionCard(session)).join("");
}

function openSessionById(sessionId) {
  if (!sessionId) {
    return;
  }

  window.location.href = `/prechat-session.html?sessionId=${encodeURIComponent(sessionId)}`;
}

function ensureContextMenu() {
  let menu = document.querySelector("#session-context-menu");

  if (menu) {
    return menu;
  }

  menu = document.createElement("div");
  menu.id = "session-context-menu";
  menu.className = "session-context-menu";
  menu.hidden = true;
  menu.innerHTML = `
    <button type="button" class="session-context-menu__item" data-action="toggle-pin"></button>
  `;
  document.body.appendChild(menu);
  return menu;
}

function hideContextMenu() {
  const menu = document.querySelector("#session-context-menu");
  if (!menu) {
    return;
  }

  menu.hidden = true;
  contextMenuState = { sessionId: null };
}

function showContextMenu(sessionId, x, y) {
  const menu = ensureContextMenu();
  const toggleButton = menu.querySelector('[data-action="toggle-pin"]');

  if (!toggleButton) {
    return;
  }

  toggleButton.textContent = isPinned(sessionId) ? "取消置顶" : "置顶会话";
  contextMenuState = { sessionId };
  menu.hidden = false;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const rect = menu.getBoundingClientRect();
  const maxLeft = Math.max(12, window.innerWidth - rect.width - 12);
  const maxTop = Math.max(12, window.innerHeight - rect.height - 12);
  menu.style.left = `${Math.min(x, maxLeft)}px`;
  menu.style.top = `${Math.min(y, maxTop)}px`;
}

function togglePin(sessionId) {
  if (!sessionId) {
    return;
  }

  if (pinnedSessionIds.has(sessionId)) {
    pinnedSessionIds.delete(sessionId);
    setStatus("saved", "已取消置顶会话。");
  } else {
    pinnedSessionIds.add(sessionId);
    setStatus("saved", "已置顶该会话。");
  }

  savePinnedSessionIds();
  renderSessions(lastSessions);
}

async function loadSessions() {
  setStatus("saving", "正在加载所有会话...");
  const auth = await requireAuth();

  if (!auth) {
    return;
  }

  currentUserId = auth.user.id;
  pinnedSessionIds = loadPinnedSessionIds(currentUserId);

  const { sessions } = await fetchJson("/api/prechat/sessions");
  renderSessions(sessions);
  setStatus("saved", `已加载 ${sessions.length} 条会话。`);
}

logoutButton.addEventListener("click", () => logout());

sessionsList.addEventListener("click", (event) => {
  const card = event.target.closest(".session-list-item");
  if (!card?.dataset.sessionId) {
    return;
  }

  hideContextMenu();
  openSessionById(card.dataset.sessionId);
});

sessionsList.addEventListener("keydown", (event) => {
  const card = event.target.closest(".session-list-item");
  if (!card?.dataset.sessionId) {
    return;
  }

  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  event.preventDefault();
  hideContextMenu();
  openSessionById(card.dataset.sessionId);
});

sessionsList.addEventListener("contextmenu", (event) => {
  const card = event.target.closest(".session-list-item");
  if (!card?.dataset.sessionId) {
    return;
  }

  event.preventDefault();
  showContextMenu(card.dataset.sessionId, event.clientX, event.clientY);
});

document.addEventListener("click", (event) => {
  const action = event.target.closest("#session-context-menu [data-action]");
  if (action?.dataset.action === "toggle-pin") {
    togglePin(contextMenuState.sessionId);
  }

  if (!event.target.closest("#session-context-menu")) {
    hideContextMenu();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hideContextMenu();
  }
});

await loadSessions();
