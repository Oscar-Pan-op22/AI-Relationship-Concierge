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

function setStatus(state, message) {
  statusText.dataset.state = state;
  statusText.textContent = message;
}

function getCounterpart(session, currentUserId) {
  return session.initiatorUserId === currentUserId ? session.counterparty : session.initiator;
}

function getRoleLabel(session, currentUserId) {
  return session.initiatorUserId === currentUserId ? "你发起" : "对方向你发起";
}

function renderSessions(sessions, currentUserId) {
  if (!sessions.length) {
    sessionsList.innerHTML = `
      <article class="stack-item">
        <p>当前还没有任何会话。你可以先从双边匹配里选择对象，或等待对方邀请你进入预沟通。</p>
      </article>
    `;
    return;
  }

  sessionsList.innerHTML = sessions
    .map((session) => {
      const counterpart = getCounterpart(session, currentUserId);
      const latestSummary = session.latestStageReport?.summary || "还没有阶段总结。";

      return `
        <article class="stack-item">
          <header>
            <strong>${escapeHtml(counterpart?.displayName || "未命名对象")}</strong>
            <span class="pill ${escapeHtml(getPrechatStatusTone(session.status))}">${escapeHtml(getPrechatStatusLabel(session.status))}</span>
          </header>
          <p><strong>会话角色：</strong>${escapeHtml(getRoleLabel(session, currentUserId))}</p>
          <p><strong>当前轮次：</strong>${escapeHtml(String(session.currentRound || 0))}</p>
          <p><strong>最近更新时间：</strong>${escapeHtml(formatDateTime(session.updatedAt))}</p>
          <p><strong>阶段摘要：</strong>${escapeHtml(latestSummary)}</p>
          <div class="page-actions">
            <a class="primary-button link-button" href="/prechat-session.html?sessionId=${encodeURIComponent(session.id)}">进入会话详情</a>
          </div>
        </article>
      `;
    })
    .join("");
}

async function loadSessions() {
  setStatus("saving", "正在加载所有会话...");
  const auth = await requireAuth();

  if (!auth) {
    return;
  }

  const { sessions } = await fetchJson("/api/prechat/sessions");
  renderSessions(sessions, auth.user.id);
  setStatus("saved", `已加载 ${sessions.length} 条会话。`);
}

logoutButton.addEventListener("click", () => logout());

await loadSessions();
