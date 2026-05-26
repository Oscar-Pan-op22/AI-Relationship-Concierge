import { escapeHtml, fetchJson, logout, requireAuth } from "./common.js";

const inboxList = document.querySelector("#inbox-list");
const statusText = document.querySelector("#inbox-status");
const logoutButton = document.querySelector("#logout-button");

function setStatus(state, message) {
  statusText.dataset.state = state;
  statusText.textContent = message;
}

function renderItem(item) {
  if (item.type === "invitation") {
    return `
      <article class="stack-item">
        <header>
          <strong>预沟通邀请</strong>
          <span class="pill low">${escapeHtml(item.payload.initiator?.displayName || "未知用户")}</span>
        </header>
        <p>${escapeHtml(item.payload.initiator?.displayName || "对方")} 邀请你进入 Twin-Twin 预沟通。</p>
        <div class="page-actions">
          <button class="primary-button" type="button" data-action="accept-invitation" data-id="${escapeHtml(item.payload.sessionId)}">接受邀请</button>
          <button class="secondary-button" type="button" data-action="reject-invitation" data-id="${escapeHtml(item.payload.sessionId)}">拒绝</button>
        </div>
      </article>
    `;
  }

  if (item.type === "sensitive_request") {
    return `
      <article class="stack-item">
        <header>
          <strong>敏感问题授权</strong>
          <span class="pill sensitive">${escapeHtml(item.payload.topicCategory)}</span>
        </header>
        <p><strong>提问方：</strong>${escapeHtml(item.payload.requester?.displayName || "未知用户")}</p>
        <p><strong>问题：</strong>${escapeHtml(item.payload.questionText)}</p>
        <div class="page-actions">
          <button class="primary-button" type="button" data-action="approve-sensitive" data-id="${escapeHtml(item.payload.requestId)}">批准</button>
          <button class="secondary-button" type="button" data-action="reject-sensitive" data-id="${escapeHtml(item.payload.requestId)}">拒绝</button>
          <a class="secondary-button link-button" href="/prechat-session.html?sessionId=${encodeURIComponent(item.payload.sessionId)}">查看会话</a>
        </div>
      </article>
    `;
  }

  return `
    <article class="stack-item">
      <header>
        <strong>人工补充信息</strong>
        <span class="pill medium">${escapeHtml(item.payload.fieldKey)}</span>
      </header>
      <p>${escapeHtml(item.payload.questionText)}</p>
      <form class="inline-form" data-human-input-form data-session-id="${escapeHtml(item.payload.sessionId)}" data-request-id="${escapeHtml(item.payload.requestId)}">
        <textarea name="responseText" rows="3" placeholder="请输入需要补充的信息"></textarea>
        <div class="page-actions">
          <button class="primary-button" type="submit">提交补充</button>
          <a class="secondary-button link-button" href="/prechat-session.html?sessionId=${encodeURIComponent(item.payload.sessionId)}">查看会话</a>
        </div>
      </form>
    </article>
  `;
}

function renderInbox(items) {
  if (!items.length) {
    inboxList.innerHTML = `
      <article class="stack-item">
        <p>当前没有待办事项。</p>
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
  setStatus("saved", `当前共有 ${items.length} 个待办。`);
}

inboxList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");

  if (!button) {
    return;
  }

  const { action, id } = button.dataset;

  try {
    setStatus("saving", "正在提交操作...");

    if (action === "accept-invitation") {
      await fetchJson(`/api/prechat/invitations/${encodeURIComponent(id)}/accept`, { method: "POST" });
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
});

inboxList.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-human-input-form]");

  if (!form) {
    return;
  }

  event.preventDefault();
  const data = new FormData(form);

  try {
    setStatus("saving", "正在提交人工补充...");
    await fetchJson(`/api/prechat/sessions/${encodeURIComponent(form.dataset.sessionId)}/human-input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: form.dataset.requestId,
        responseText: data.get("responseText")
      })
    });
    await loadInbox();
  } catch (error) {
    setStatus("error", `提交失败：${error.message}`);
  }
});

logoutButton.addEventListener("click", () => logout());

await requireAuth();
await loadInbox();
