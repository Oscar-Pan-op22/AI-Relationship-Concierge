import {
  escapeHtml,
  fetchJson,
  getSensitiveTopicLabel,
  localizeDisplayText,
  logout,
  refreshInboxBadge,
  requireAuth
} from "./common.js";

const inboxList = document.querySelector("#inbox-list");
const statusText = document.querySelector("#inbox-status");
const logoutButton = document.querySelector("#logout-button");

function setStatus(state, message) {
  statusText.dataset.state = state;
  statusText.textContent = message;
}

function openSessionById(sessionId) {
  if (!sessionId) {
    return;
  }

  window.location.href = `/prechat-session.html?sessionId=${encodeURIComponent(sessionId)}`;
}

function renderInvitation(item) {
  const initiatorName = item.payload.initiator?.displayName || "未知用户";

  return `
    <article class="stack-item">
      <header>
        <strong>预沟通邀请</strong>
        <span class="pill low">${escapeHtml(initiatorName)}</span>
      </header>
      <p>${escapeHtml(initiatorName)} 邀请你进入 Twin-Twin 预沟通。</p>
      <div class="page-actions">
        <button class="primary-button" type="button" data-action="accept-invitation" data-id="${escapeHtml(item.payload.sessionId)}">接受邀请</button>
        <button class="secondary-button" type="button" data-action="reject-invitation" data-id="${escapeHtml(item.payload.sessionId)}">拒绝</button>
      </div>
    </article>
  `;
}

function renderSensitiveRequest(item) {
  const requesterName = item.payload.requester?.displayName || "未知用户";
  const summaryText =
    localizeDisplayText(item.payload.summaryText, "需要你决定是否允许进入这一敏感议题。");

  return `
      <article class="stack-item">
      <header>
        <strong>敏感议题授权</strong>
        <span class="pill sensitive">${escapeHtml(getSensitiveTopicLabel(item.payload.topicCategory))}</span>
      </header>
      <p><strong>提问方：</strong>${escapeHtml(requesterName)}</p>
      <p><strong>说明：</strong>${escapeHtml(summaryText)}</p>
      <div class="page-actions">
        <button class="primary-button" type="button" data-action="approve-sensitive" data-id="${escapeHtml(item.payload.requestId)}">批准</button>
        <button class="secondary-button" type="button" data-action="reject-sensitive" data-id="${escapeHtml(item.payload.requestId)}">拒绝</button>
        <a class="secondary-button link-button" href="/prechat-session.html?sessionId=${encodeURIComponent(item.payload.sessionId)}">查看会话</a>
      </div>
    </article>
  `;
}

function renderHumanInputRequest(item) {
  const isManualReview = item.payload.fieldKey === "manual_review";
  const counterpartName = item.payload.counterpart?.displayName || "对方";
  const title = isManualReview ? "模型异常暂停" : `${counterpartName} · 人工补充信息`;
  const pillLabel = isManualReview ? "系统兜底" : "需要本人补充";
  const description = isManualReview
    ? "这条会话已暂停：这一轮预沟通没有拿到稳定的模型输出，需要回到会话页用真人消息继续推进。"
    : localizeDisplayText(item.payload.questionText, "需要你补充信息。");

  return `
    <article
      class="stack-item inbox-jump-card"
      data-session-id="${escapeHtml(item.payload.sessionId)}"
      role="link"
      tabindex="0"
      aria-label="打开需要人工补充的会话"
    >
      <header>
        <strong>${escapeHtml(title)}</strong>
        <span class="pill ${isManualReview ? "warn" : "medium"}">${pillLabel}</span>
      </header>
      <p>${escapeHtml(description)}</p>
    </article>
  `;
}

function renderSessionReview(item) {
  const counterpartName = item.payload.counterpart?.displayName || "对方";
  const summary = localizeDisplayText(item.payload.summary, "预沟通已形成阶段结论，点击查看会话。");

  return `
    <article
      class="stack-item inbox-jump-card"
      data-session-id="${escapeHtml(item.payload.sessionId)}"
      role="link"
      tabindex="0"
      aria-label="打开需要查看阶段结论的会话"
    >
      <header>
        <strong>${escapeHtml(`${counterpartName} · 查看阶段结论`)}</strong>
        <span class="pill low">查看结论</span>
      </header>
      <p>${escapeHtml(summary)}</p>
    </article>
  `;
}

function renderSessionPause(item) {
  const counterpartName = item.payload.counterpart?.displayName || "对方";
  const summary = localizeDisplayText(item.payload.summary, "当前预沟通已暂停，点击查看会话。");

  return `
    <article
      class="stack-item inbox-jump-card"
      data-session-id="${escapeHtml(item.payload.sessionId)}"
      role="link"
      tabindex="0"
      aria-label="打开已暂停的会话"
    >
      <header>
        <strong>${escapeHtml(`${counterpartName} · 会话已暂停`)}</strong>
        <span class="pill warn">暂停提醒</span>
      </header>
      <p>${escapeHtml(summary)}</p>
    </article>
  `;
}

function renderItem(item) {
  if (item.type === "invitation") {
    return renderInvitation(item);
  }

  if (item.type === "sensitive_request") {
    return renderSensitiveRequest(item);
  }

  if (item.type === "session_review") {
    return renderSessionReview(item);
  }

  if (item.type === "session_pause") {
    return renderSessionPause(item);
  }

  return renderHumanInputRequest(item);
}

function renderInbox(items) {
  if (!items.length) {
    inboxList.innerHTML = `
      <article class="stack-item">
        <p>当前没有需要你处理的待办事项。</p>
      </article>
    `;
    return;
  }

  inboxList.innerHTML = items.map(renderItem).join("");
}

async function loadInbox() {
  setStatus("saving", "正在加载待办...");
  const { items } = await fetchJson("/api/inbox");
  renderInbox(items);
  await refreshInboxBadge(items.length);
  setStatus("saved", `当前共有 ${items.length} 个待办事项`);
}

inboxList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");

  if (button) {
    const { action, id } = button.dataset;

    try {
      setStatus("saving", "正在提交操作...");

      if (action === "accept-invitation") {
        const { session } = await fetchJson(`/api/prechat/invitations/${encodeURIComponent(id)}/accept`, {
          method: "POST"
        });
        window.location.href = `/prechat-session.html?sessionId=${encodeURIComponent(session.id)}`;
        return;
      } else if (action === "reject-invitation") {
        await fetchJson(`/api/prechat/invitations/${encodeURIComponent(id)}/reject`, { method: "POST" });
      } else if (action === "approve-sensitive") {
        await fetchJson(`/api/sensitive-requests/${encodeURIComponent(id)}/approve`, { method: "POST" });
      } else if (action === "reject-sensitive") {
        await fetchJson(`/api/sensitive-requests/${encodeURIComponent(id)}/reject`, { method: "POST" });
      }

      await loadInbox();
    } catch (error) {
      setStatus("error", `操作失败：${error.message}`);
    }
    return;
  }

  const card = event.target.closest(".inbox-jump-card");
  if (card?.dataset.sessionId) {
    openSessionById(card.dataset.sessionId);
  }
});

inboxList.addEventListener("keydown", (event) => {
  const card = event.target.closest(".inbox-jump-card");
  if (!card?.dataset.sessionId) {
    return;
  }

  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  event.preventDefault();
  openSessionById(card.dataset.sessionId);
});

logoutButton.addEventListener("click", () => logout());

const auth = await requireAuth();
if (auth) {
  await loadInbox();
}
