import {
  escapeHtml,
  fetchJson,
  formatDateTime,
  logout,
  renderEmptyState,
  requireAuth
} from "./common.js";

const sessionShell = document.querySelector("#session-shell");
const sessionHeroText = document.querySelector("#session-hero-text");
const sessionStatus = document.querySelector("#session-status");
const logoutButton = document.querySelector("#logout-button");
const sessionId = new URL(window.location.href).searchParams.get("sessionId");

let currentUser = null;

function setStatus(state, message) {
  sessionStatus.dataset.state = state;
  sessionStatus.textContent = message;
}

function actionButton(label, action, tone = "secondary-button") {
  return `<button class="${tone}" type="button" data-action="${escapeHtml(action)}">${escapeHtml(label)}</button>`;
}

function renderTurn(turn, session) {
  const side =
    turn.actorUserId === session.initiator.id ? "initiator" : turn.actorUserId === session.counterparty.id ? "counterparty" : "system";
  const roleLabel =
    side === "initiator"
      ? `${session.initiator.displayName} 的 Twin`
      : side === "counterparty"
        ? `${session.counterparty.displayName} 的 Twin`
        : "系统";

  return `
    <article class="turn-card ${escapeHtml(side)}">
      <header>
        <strong>${escapeHtml(roleLabel)}</strong>
        <span class="pill low">第 ${escapeHtml(String(turn.turnNumber))} 条</span>
      </header>
      <p>${escapeHtml(turn.content)}</p>
    </article>
  `;
}

function renderFacts(facts) {
  if (!facts.length) {
    return `<article class="stack-item"><p>当前还没有提取出的已确认事实。</p></article>`;
  }

  return facts
    .map(
      (fact) => `
        <article class="stack-item">
          <header>
            <strong>${escapeHtml(fact.key)}</strong>
            <span class="pill low">置信度 ${escapeHtml(String(fact.confidence))}</span>
          </header>
          <p>${escapeHtml(fact.value)}</p>
        </article>
      `
    )
    .join("");
}

function renderStageReports(stageReports) {
  if (!stageReports.length) {
    return `<article class="stack-item"><p>当前还没有阶段报告。</p></article>`;
  }

  return stageReports
    .map(
      (report) => `
        <article class="stack-item">
          <header>
            <strong>阶段总结</strong>
            <span class="pill medium">${escapeHtml(formatDateTime(report.createdAt))}</span>
          </header>
          <p><strong>摘要：</strong>${escapeHtml(report.payload.summary || "暂无")}</p>
          <p><strong>未决问题：</strong>${escapeHtml((report.payload.unresolved_questions || []).join("；") || "暂无")}</p>
          <p><strong>下一步：</strong>${escapeHtml(report.payload.next_action || "pause_review")}</p>
        </article>
      `
    )
    .join("");
}

function renderSensitiveRequests(session, currentUserId, requests) {
  if (!requests.length) {
    return "";
  }

  return `
    <section class="report-section">
      <h3>敏感问题授权</h3>
      <div class="stack-list">
        ${requests
          .map((request) => {
            const targetName =
              request.targetUserId === session.initiator.id
                ? session.initiator.displayName
                : session.counterparty.displayName;
            const canAct = request.status === "pending" && request.targetUserId === currentUserId;

            return `
              <article class="stack-item">
                <header>
                  <strong>${escapeHtml(request.topicCategory)}</strong>
                  <span class="pill ${request.status === "pending" ? "sensitive" : "low"}">${escapeHtml(request.status)}</span>
                </header>
                <p><strong>目标用户：</strong>${escapeHtml(targetName)}</p>
                <p><strong>原始问题：</strong>${escapeHtml(request.questionText)}</p>
                ${
                  canAct
                    ? `<div class="page-actions">
                        <button class="primary-button" type="button" data-action="approve-sensitive" data-id="${escapeHtml(request.id)}">批准</button>
                        <button class="secondary-button" type="button" data-action="reject-sensitive" data-id="${escapeHtml(request.id)}">拒绝</button>
                      </div>`
                    : ""
                }
              </article>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function renderHumanInputRequests(requests) {
  if (!requests.length) {
    return "";
  }

  return `
    <section class="report-section">
      <h3>人工补充</h3>
      <div class="stack-list">
        ${requests
          .map(
            (request) => `
              <article class="stack-item">
                <header>
                  <strong>${escapeHtml(request.fieldKey)}</strong>
                  <span class="pill ${request.status === "pending" ? "medium" : "low"}">${escapeHtml(request.status)}</span>
                </header>
                <p>${escapeHtml(request.questionText)}</p>
                ${
                  request.status === "pending"
                    ? `<form class="inline-form" data-human-input-form data-request-id="${escapeHtml(request.id)}">
                        <textarea name="responseText" rows="3" placeholder="请输入补充信息"></textarea>
                        <div class="page-actions">
                          <button class="primary-button" type="submit">提交补充</button>
                        </div>
                      </form>`
                    : `<p><strong>已提交：</strong>${escapeHtml(request.responseText || "无")}</p>`
                }
              </article>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderActions(detail) {
  const { session } = detail;
  const actions = [];

  if (session.status === "awaiting_counterparty_acceptance" && session.currentUserRole === "counterparty") {
    actions.push(actionButton("接受邀请", "accept-invitation", "primary-button"));
    actions.push(actionButton("拒绝邀请", "reject-invitation"));
  }

  if (["active", "paused_review"].includes(session.status)) {
    actions.push(actionButton("继续一轮", "run-round", "primary-button"));
    actions.push(actionButton("暂停观察", "pause-session"));
    actions.push(actionButton("淘汰该对象", "reject-session"));
    actions.push(actionButton("进入真人交接", "handoff-session"));
  }

  if (session.status === "handoff_ready") {
    actions.push(actionButton("重新跑一轮", "run-round", "primary-button"));
    actions.push(actionButton("淘汰该对象", "reject-session"));
  }

  if (!actions.length) {
    return "";
  }

  return `
    <div class="decision-row">
      ${actions.join("")}
    </div>
  `;
}

function renderSession(detail) {
  const { session, turns, facts, stageReports, sensitiveRequests, humanInputRequests } = detail;
  const counterpart =
    session.currentUserRole === "initiator" ? session.counterparty.displayName : session.initiator.displayName;

  sessionHeroText.textContent = `你正在与 ${counterpart} 的 Twin 进行透明预沟通。`;
  setStatus("saved", `当前状态：${session.status}`);

  sessionShell.innerHTML = `
    <div class="report-topline">
      <span class="badge promising">${escapeHtml(session.status)}</span>
      <span class="pill low">当前轮次 ${escapeHtml(String(session.currentRound))}</span>
    </div>

    <section class="report-section">
      <h3>会话概览</h3>
      <div class="meta-grid">
        <div class="stack-item">
          <strong>发起方</strong>
          <p>${escapeHtml(session.initiator.displayName)}</p>
        </div>
        <div class="stack-item">
          <strong>对方</strong>
          <p>${escapeHtml(session.counterparty.displayName)}</p>
        </div>
        <div class="stack-item">
          <strong>创建时间</strong>
          <p>${escapeHtml(formatDateTime(session.createdAt))}</p>
        </div>
        <div class="stack-item">
          <strong>最近更新</strong>
          <p>${escapeHtml(formatDateTime(session.updatedAt))}</p>
        </div>
      </div>
      ${renderActions(detail)}
    </section>

    <section class="report-section">
      <h3>Twin-Twin 线程</h3>
      <div class="thread-list">
        ${
          turns.length
            ? turns.map((turn) => renderTurn(turn, session)).join("")
            : `<article class="stack-item"><p>当前还没有 Twin 消息。可以先启动一轮预沟通。</p></article>`
        }
      </div>
    </section>

    ${renderSensitiveRequests(session, currentUser?.id, sensitiveRequests)}
    ${renderHumanInputRequests(humanInputRequests)}

    <section class="report-section">
      <h3>已确认事实</h3>
      <div class="stack-list">${renderFacts(facts)}</div>
    </section>

    <section class="report-section">
      <h3>阶段报告</h3>
      <div class="stack-list">${renderStageReports(stageReports)}</div>
    </section>
  `;
}

async function loadSession() {
  if (!sessionId) {
    sessionShell.innerHTML = renderEmptyState("缺少 sessionId", "请从匹配页或待办箱进入具体会话。");
    setStatus("error", "缺少 sessionId。");
    return;
  }

  setStatus("saving", "正在加载会话...");
  const detail = await fetchJson(`/api/prechat/sessions/${encodeURIComponent(sessionId)}`);
  renderSession(detail);
}

sessionShell.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");

  if (!button) {
    return;
  }

  const action = button.dataset.action;
  const id = button.dataset.id;

  try {
    setStatus("saving", "正在提交操作...");

    if (action === "accept-invitation") {
      await fetchJson(`/api/prechat/invitations/${encodeURIComponent(sessionId)}/accept`, { method: "POST" });
    } else if (action === "reject-invitation") {
      await fetchJson(`/api/prechat/invitations/${encodeURIComponent(sessionId)}/reject`, { method: "POST" });
    } else if (action === "run-round") {
      await fetchJson(`/api/prechat/sessions/${encodeURIComponent(sessionId)}/run-round`, { method: "POST" });
    } else if (action === "pause-session") {
      await fetchJson(`/api/prechat/sessions/${encodeURIComponent(sessionId)}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pause" })
      });
    } else if (action === "reject-session") {
      await fetchJson(`/api/prechat/sessions/${encodeURIComponent(sessionId)}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject" })
      });
    } else if (action === "handoff-session") {
      await fetchJson(`/api/prechat/sessions/${encodeURIComponent(sessionId)}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "handoff" })
      });
    } else if (action === "approve-sensitive") {
      await fetchJson(`/api/sensitive-requests/${encodeURIComponent(id)}/approve`, { method: "POST" });
    } else if (action === "reject-sensitive") {
      await fetchJson(`/api/sensitive-requests/${encodeURIComponent(id)}/reject`, { method: "POST" });
    }

    await loadSession();
  } catch (error) {
    setStatus("error", `操作失败：${error.message}`);
  }
});

sessionShell.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-human-input-form]");

  if (!form) {
    return;
  }

  event.preventDefault();
  const data = new FormData(form);

  try {
    setStatus("saving", "正在提交人工补充...");
    await fetchJson(`/api/prechat/sessions/${encodeURIComponent(sessionId)}/human-input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: form.dataset.requestId,
        responseText: data.get("responseText")
      })
    });
    await loadSession();
  } catch (error) {
    setStatus("error", `提交失败：${error.message}`);
  }
});

logoutButton.addEventListener("click", () => logout());

const auth = await requireAuth();
if (auth) {
  currentUser = auth.user;
  await loadSession();
}
