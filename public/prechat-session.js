import {
  escapeHtml,
  fetchJson,
  formatDateTime,
  getPrechatStatusLabel,
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

const FACT_KEY_LABELS = {
  relationshipGoal: "关系目标",
  cities: "长期城市安排",
  cityPlan: "城市与生活规划",
  marriageTimeline: "结婚节奏",
  childrenPreference: "孩子与生育态度",
  familyBoundary: "家庭边界",
  financialView: "财务观",
  communicationStyle: "沟通风格",
  incomeBand: "收入区间",
  incomeStability: "收入稳定性",
  debtLevel: "负债压力",
  housingStatus: "住房状态",
  vehicleStatus: "车辆状态",
  siblingStructure: "兄弟姐妹结构",
  parentCareBurden: "父母照护压力",
  postMaritalLivingPreference: "婚后居住取向"
};

const NEXT_ACTION_LABELS = {
  continue: "继续自动推进",
  pause_review: "暂停并等待查看阶段结论",
  handoff_ready: "进入真人接手",
  blocked_risk: "因风险暂停"
};

function setStatus(state, message) {
  sessionStatus.dataset.state = state;
  sessionStatus.textContent = message;
}

function actionButton(label, action, tone = "secondary-button", extra = "") {
  return `<button class="${tone}" type="button" data-action="${escapeHtml(action)}" ${extra}>${escapeHtml(label)}</button>`;
}

function getParticipant(session, actorUserId) {
  if (actorUserId === session.initiator.id) {
    return {
      id: session.initiator.id,
      displayName: session.initiator.displayName,
      tone: "initiator"
    };
  }

  return {
    id: session.counterparty.id,
    displayName: session.counterparty.displayName,
    tone: "counterparty"
  };
}

function getCounterpart(session) {
  return session.currentUserRole === "initiator" ? session.counterparty : session.initiator;
}

function getCurrentUserId(session) {
  return session.currentUserRole === "initiator" ? session.initiator.id : session.counterparty.id;
}

function getInitial(name) {
  const text = String(name || "").trim();
  return text ? text.slice(0, 1).toUpperCase() : "T";
}

function renderAvatar(participant, { isTwin = false } = {}) {
  return `
    <div class="chat-avatar-shell">
      <div class="chat-avatar ${escapeHtml(participant.tone)}" aria-hidden="true">
        <span>${escapeHtml(getInitial(participant.displayName))}</span>
      </div>
      ${isTwin ? '<span class="chat-avatar-badge">数字分身</span>' : ""}
    </div>
  `;
}

function isManualReviewNotice(turn) {
  return (
    turn.actorUserId == null &&
    (turn.actorRole === "system_pause_notice" ||
      (turn.actorRole === "system" &&
        turn.metadata?.pauseReason === "pending_human_input" &&
        turn.metadata?.fieldKey === "manual_review"))
  );
}

function renderTurn(turn, session) {
  if (isManualReviewNotice(turn)) {
    return `
      <article class="chat-inline-notice-row">
        <p class="chat-inline-notice">这一轮因模型输出不稳定已暂停，等待你本人继续。</p>
      </article>
    `;
  }

  if (turn.actorUserId == null) {
    return `
      <article class="chat-inline-notice-row">
        <p class="chat-inline-notice">${escapeHtml(turn.content)}</p>
      </article>
    `;
  }

  const isHuman = String(turn.actorRole || "").endsWith("_user");
  const isMine = turn.actorUserId === getCurrentUserId(session);
  const participant = getParticipant(session, turn.actorUserId);
  const bubbleType = isMine ? "mine" : "theirs";

  return `
    <article class="chat-message-row ${escapeHtml(bubbleType)}">
      ${bubbleType === "theirs" ? renderAvatar(participant, { isTwin: !isHuman }) : ""}
      <div class="chat-message-stack ${escapeHtml(bubbleType)}">
        <div class="chat-bubble ${escapeHtml(bubbleType)}">
          <p>${escapeHtml(turn.content)}</p>
        </div>
      </div>
      ${bubbleType === "mine" ? renderAvatar(participant, { isTwin: !isHuman }) : ""}
    </article>
  `;
}

function dedupeFacts(facts) {
  const seen = new Set();
  const result = [];

  for (const fact of facts) {
    const signature = [
      String(fact.subjectUserId || ""),
      String(fact.key || "").trim(),
      String(fact.value || "").trim()
    ].join("::");

    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    result.push(fact);
  }

  return result;
}

function getFactSubjectLabel(fact) {
  if (fact.subjectUserId === currentUser?.id || fact.subjectUserId === "self") {
    return "你";
  }

  return "对方";
}

function renderFacts(facts) {
  const cleanFacts = dedupeFacts(facts);

  if (!cleanFacts.length) {
    return `<article class="stack-item"><p>当前还没有提取出的已确认事实。</p></article>`;
  }

  return cleanFacts
    .map((fact) => {
      const label = FACT_KEY_LABELS[fact.key] || fact.key || "已确认信息";
      return `
        <article class="stack-item">
          <header>
            <strong>${escapeHtml(`${getFactSubjectLabel(fact)} · ${label}`)}</strong>
            <span class="pill low">置信度 ${escapeHtml(String(fact.confidence))}</span>
          </header>
          <p>${escapeHtml(fact.value)}</p>
        </article>
      `;
    })
    .join("");
}

function renderStageReports(stageReports) {
  if (!stageReports.length) {
    return `<article class="stack-item"><p>当前还没有阶段报告。</p></article>`;
  }

  return stageReports
    .map((report) => {
      const unresolved = Array.isArray(report.payload.unresolved_questions)
        ? report.payload.unresolved_questions
        : [];
      const nextAction =
        NEXT_ACTION_LABELS[report.payload.next_action] || report.payload.next_action || "继续自动推进";

      return `
        <article class="stack-item">
          <header>
            <strong>阶段总结</strong>
            <span class="pill medium">${escapeHtml(formatDateTime(report.createdAt))}</span>
          </header>
          <p><strong>摘要：</strong>${escapeHtml(report.payload.summary || "暂无")}</p>
          <p><strong>未决问题：</strong>${escapeHtml(unresolved.join("、") || "暂无")}</p>
          <p><strong>下一步：</strong>${escapeHtml(nextAction)}</p>
        </article>
      `;
    })
    .join("");
}

function renderSensitiveRequests(session, requests) {
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
            const canAct = request.status === "pending" && request.targetUserId === currentUser?.id;

            return `
              <article class="stack-item">
                <header>
                  <strong>${escapeHtml(request.topicCategory)}</strong>
                  <span class="pill ${request.status === "pending" ? "sensitive" : "low"}">${escapeHtml(request.status)}</span>
                </header>
                <p><strong>被问方：</strong>${escapeHtml(targetName)}</p>
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

function renderObjectiveProgress(stageReports) {
  const latest = stageReports[0]?.payload;
  const progress = latest?.objective_progress || [];

  if (!progress.length) {
    return `
      <div class="summary-card">
        <h4>本轮议题进展</h4>
        <p>当前还没有可展示的议题进展。</p>
      </div>
    `;
  }

  return `
    <div class="summary-card">
      <h4>本轮议题进展</h4>
      <div class="progress-list">
        ${progress
          .map((item) => {
            const label =
              item.status === "confirmed" ? "已确认" : item.status === "pending" ? "待推进" : "未解决";
            const tone = item.status === "confirmed" ? "ok" : item.status === "pending" ? "medium" : "low";

            return `
              <div class="progress-item">
                <strong>${escapeHtml(item.label)}</strong>
                <span class="pill ${escapeHtml(tone)}">${escapeHtml(label)}</span>
              </div>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function renderInlinePauseNotice(humanInputRequests = []) {
  const pending = humanInputRequests.find((request) => request.status === "pending");

  if (!pending || pending.fieldKey === "manual_review") {
    return "";
  }

  const text =
    pending.targetUserId === currentUser?.id
      ? "当前会话正在等待你本人补充后继续。"
      : "当前会话正在等待对方本人补充后继续。";

  return `
    <article class="chat-inline-notice-row">
      <p class="chat-inline-notice">${escapeHtml(text)}</p>
    </article>
  `;
}

function renderDirectComposer(session, humanInputRequests = []) {
  if (["awaiting_counterparty_acceptance", "rejected", "blocked_risk"].includes(session.status)) {
    return "";
  }

  const pending = humanInputRequests.find(
    (request) => request.status === "pending" && request.targetUserId === currentUser?.id
  );

  return `
    <section class="message-composer">
      <form
        class="composer-form-inline"
        data-direct-message-form
        ${pending ? `data-request-id="${escapeHtml(pending.id)}"` : ""}
      >
        <div class="composer-input-shell">
          <textarea name="content" rows="3" placeholder=""></textarea>
          <button class="primary-button composer-send-button composer-send-button--floating" type="submit">发送</button>
        </div>
      </form>
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
    actions.push(actionButton("暂停观察", "pause-session"));
    actions.push(actionButton("结束推进", "reject-session"));
    actions.push(actionButton("进入真人接手", "handoff-session"));
  }

  if (session.status === "handoff_ready") {
    actions.push(actionButton("结束推进", "reject-session"));
  }

  if (!actions.length) {
    return "";
  }

  return `<div class="chat-panel-actions">${actions.join("")}</div>`;
}

function renderTransparencyCard(session) {
  const counterpart = getCounterpart(session);

  return `
    <section class="messenger-banner">
      <div class="messenger-banner-copy">
        <p class="eyebrow">透明预沟通</p>
        <h3>你正在与 ${escapeHtml(counterpart.displayName)} 的 Twin 对话</h3>
        <p>这是平台内的透明 Twin-Twin 预沟通。双方都能看到完整线程；敏感问题不会直接发出，必须先由被问方逐题授权。</p>
      </div>
      <div class="messenger-banner-tags">
        <span class="pill low">双方可见</span>
        <span class="pill medium">敏感问题逐题授权</span>
        <span class="pill ok">禁止真人承诺代发</span>
      </div>
    </section>
  `;
}

function renderSidebar(detail) {
  return `
    <aside class="messenger-sidebar">
      ${renderObjectiveProgress(detail.stageReports)}

      <div class="summary-card">
        <h4>已确认事实</h4>
        <div class="stack-list compact-list">${renderFacts(detail.facts)}</div>
      </div>

      <div class="summary-card">
        <h4>阶段报告</h4>
        <div class="stack-list compact-list">${renderStageReports(detail.stageReports)}</div>
      </div>

      ${renderSensitiveRequests(detail.session, detail.sensitiveRequests)}
    </aside>
  `;
}

function renderChatPanelHead(session) {
  const counterpart = getCounterpart(session);
  const counterpartSummary = getParticipant(session, counterpart.id);

  return `
    <div class="chat-panel-head">
      <div class="chat-panel-identity">
        ${renderAvatar(counterpartSummary)}
        <div class="chat-panel-identity-copy">
          <h4>${escapeHtml(counterpart.displayName)}</h4>
        </div>
      </div>
    </div>
  `;
}

function renderSession(detail) {
  const { session, turns, humanInputRequests } = detail;
  const counterpart = getCounterpart(session);

  sessionHeroText.textContent = `你正在与 ${counterpart.displayName} 的 Twin 进行透明预沟通。`;
  setStatus("saved", `会话已加载 · ${getPrechatStatusLabel(session.status)}`);

  sessionShell.innerHTML = `
    ${renderTransparencyCard(session)}
    <div class="messenger-layout">
      <section class="messenger-main">
        <div class="chat-panel">
          ${renderChatPanelHead(session)}
          ${renderActions(detail)}
          <div class="message-feed">
            ${
              turns.length
                ? turns.map((turn) => renderTurn(turn, session)).join("")
                : `<article class="chat-inline-notice-row"><p class="chat-inline-notice">当前还没有 Twin 消息。</p></article>`
            }
            ${renderInlinePauseNotice(humanInputRequests)}
          </div>
          ${renderDirectComposer(session, humanInputRequests)}
        </div>
      </section>
      ${renderSidebar(detail)}
    </div>
  `;
}

async function loadSession() {
  if (!sessionId) {
    sessionShell.innerHTML = renderEmptyState("缺少 sessionId", "请从匹配页、待办箱或所有会话进入具体会话。");
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
  const form = event.target.closest("[data-direct-message-form]");

  if (!form) {
    return;
  }

  event.preventDefault();
  const data = new FormData(form);

  try {
    if (form.dataset.requestId) {
      setStatus("saving", "正在发送本人消息并继续...");
      await fetchJson(`/api/prechat/sessions/${encodeURIComponent(sessionId)}/human-input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: form.dataset.requestId,
          responseText: data.get("content")
        })
      });
    } else {
      setStatus("saving", "正在发送本人消息...");
      await fetchJson(`/api/prechat/sessions/${encodeURIComponent(sessionId)}/manual-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: data.get("content")
        })
      });
    }

    await loadSession();
  } catch (error) {
    setStatus("error", `提交失败：${error.message}`);
  }
});

sessionShell.addEventListener("keydown", (event) => {
  const textarea = event.target.closest('[data-direct-message-form] textarea');

  if (!textarea) {
    return;
  }

  if (event.key !== "Enter" || event.shiftKey) {
    return;
  }

  event.preventDefault();
  textarea.form?.requestSubmit();
});

logoutButton.addEventListener("click", () => logout());

const auth = await requireAuth();
if (auth) {
  currentUser = auth.user;
  await loadSession();
}
