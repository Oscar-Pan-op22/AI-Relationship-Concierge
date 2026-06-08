import {
  escapeHtml,
  fetchJson,
  formatDateTime,
  getFieldKeyLabel,
  getNextActionLabel,
  getPrechatStatusLabel,
  getSensitiveTopicLabel,
  getStopReasonLabel,
  getTopicKeyLabel,
  localizeDisplayList,
  localizeDisplayText,
  localizeStructuredValue,
  logout,
  renderEmptyState,
  requireAuth
} from "./common.js";
import { dedupeFacts } from "./fact-utils.js";

const sessionShell = document.querySelector("#session-shell");
const sessionHeroText = document.querySelector("#session-hero-text");
const sessionStatus = document.querySelector("#session-status");
const logoutButton = document.querySelector("#logout-button");
const sessionId = new URL(window.location.href).searchParams.get("sessionId");

const MESSAGE_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "👀"];
const LONG_PRESS_MS = 420;

let currentUser = null;
let sessionDetail = null;
let composerState = {
  quotedTurnId: null,
  editingTurnId: null
};
let messageMenuState = {
  turnId: null
};
let longPressTimer = null;
let automationPollTimer = null;

function setStatus(state, message) {
  sessionStatus.dataset.state = state;
  sessionStatus.textContent = message;
}

function actionButton(label, action, tone = "secondary-button", extra = "") {
  return `<button class="${tone}" type="button" data-action="${escapeHtml(action)}" ${extra}>${escapeHtml(label)}</button>`;
}

function getTurnById(turnId) {
  return sessionDetail?.turns?.find((turn) => turn.id === turnId) || null;
}

function clearComposerState() {
  composerState = {
    quotedTurnId: null,
    editingTurnId: null
  };
}

function getManualPauseState(session) {
  const manualPause = session.control?.manualPause || {};
  const legacyActive = Boolean(manualPause.active);
  const legacyCount = Number(manualPause.messageCount || 0);
  const currentRole = session.currentUserRole === "initiator" ? "initiator" : "counterparty";
  const counterpartRole = currentRole === "initiator" ? "counterparty" : "initiator";
  const currentUserPaused = Boolean(
    currentRole === "initiator"
      ? manualPause.initiatorEnded ?? legacyActive
      : manualPause.counterpartyEnded ?? legacyActive
  );
  const counterpartPaused = Boolean(
    currentRole === "initiator"
      ? manualPause.counterpartyEnded ?? legacyActive
      : manualPause.initiatorEnded ?? legacyActive
  );
  const messageCountByRole =
    manualPause.messageCountByRole && typeof manualPause.messageCountByRole === "object"
      ? manualPause.messageCountByRole
      : {};
  const currentUserMessageCount = Number(
    messageCountByRole[currentRole] == null ? legacyCount : messageCountByRole[currentRole]
  );
  const counterpartMessageCount = Number(
    messageCountByRole[counterpartRole] == null ? legacyCount : messageCountByRole[counterpartRole]
  );
  const anyPaused = currentUserPaused || counterpartPaused;
  const pendingHumanInputBlocked = anyPaused;

  return {
    currentUserPaused,
    counterpartPaused,
    anyPaused,
    currentUserMessageCount,
    counterpartMessageCount,
    remainingManualMessages: anyPaused ? Math.max(0, 1 - currentUserMessageCount) : null,
    counterpartRemainingManualMessages: anyPaused ? Math.max(0, 1 - counterpartMessageCount) : null,
    pendingHumanInputBlocked
  };
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

function getComposerMode(session, humanInputRequests = []) {
  const manualPause = getManualPauseState(session);
  const pending = humanInputRequests.find(
    (request) => request.status === "pending" && request.targetUserId === currentUser?.id
  );
  const editingTurn = composerState.editingTurnId ? getTurnById(composerState.editingTurnId) : null;
  const useHumanInputMode = Boolean(pending) && !manualPause.pendingHumanInputBlocked && !editingTurn;

  if (editingTurn) {
    return {
      type: "edit",
      requestId: null,
      pending,
      editingTurn
    };
  }

  if (useHumanInputMode) {
    return {
      type: "human_input",
      requestId: pending.id,
      pending,
      editingTurn: null
    };
  }

  return {
    type: "manual_message",
    requestId: null,
    pending,
    editingTurn: null
  };
}

function renderMessageQuote(turn) {
  if (!turn?.quotedTurn) {
    return "";
  }

  return `
    <div class="chat-quote-block">
      <div class="chat-quote-block__label">${escapeHtml(turn.quotedTurn.actorLabel)}</div>
      <p>${escapeHtml(turn.quotedTurn.content)}</p>
    </div>
  `;
}

function renderMessageReactions(turn) {
  if (!Array.isArray(turn?.reactions) || !turn.reactions.length) {
    return "";
  }

  return `
    <div class="chat-reaction-row">
      ${turn.reactions
        .map(
          (reaction) => `
            <button
              type="button"
              class="chat-reaction-chip ${reaction.reactedByCurrentUser ? "is-selected" : ""}"
              data-action="toggle-reaction"
              data-turn-id="${escapeHtml(turn.id)}"
              data-emoji="${escapeHtml(reaction.emoji)}"
            >
              <span>${escapeHtml(reaction.emoji)}</span>
              <span>${escapeHtml(String(reaction.count))}</span>
            </button>
          `
        )
        .join("")}
    </div>
  `;
}

function renderMessageMeta(turn) {
  const metaBits = [];

  if (turn.isEdited) {
    metaBits.push('<span class="chat-message-meta-tag">已编辑</span>');
  }

  if (turn.isRecalled) {
    metaBits.push('<span class="chat-message-meta-tag">已撤回</span>');
  }

  return metaBits.length ? `<div class="chat-message-meta">${metaBits.join("")}</div>` : "";
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
        <p class="chat-inline-notice">${escapeHtml(localizeDisplayText(turn.content, "系统提示"))}</p>
      </article>
    `;
  }

  if (turn.isRecalled) {
    return `
      <article class="chat-inline-notice-row">
        <p class="chat-inline-notice">${escapeHtml(turn.content)}。</p>
      </article>
    `;
  }

  const isHuman = String(turn.actorRole || "").endsWith("_user");
  const isMine = turn.actorUserId === getCurrentUserId(session);
  const participant = getParticipant(session, turn.actorUserId);
  const bubbleType = isMine ? "mine" : "theirs";
  const owner = isMine ? "self" : turn.actorRole.endsWith("_twin") ? "twin" : "other";

  return `
    <article class="chat-message-row ${escapeHtml(bubbleType)}">
      ${bubbleType === "theirs" ? renderAvatar(participant, { isTwin: !isHuman }) : ""}
      <div
        class="chat-message-stack ${escapeHtml(bubbleType)}"
        data-turn-id="${escapeHtml(turn.id)}"
        data-turn-owner="${escapeHtml(owner)}"
        data-turn-kind="${escapeHtml(isHuman ? "human" : "twin")}"
      >
        <div class="chat-bubble ${escapeHtml(bubbleType)} ${turn.isRecalled ? "is-recalled" : ""}">
          ${renderMessageQuote(turn)}
          <p>${escapeHtml(turn.content)}</p>
        </div>
        ${renderMessageMeta(turn)}
        ${renderMessageReactions(turn)}
      </div>
      ${bubbleType === "mine" ? renderAvatar(participant, { isTwin: !isHuman }) : ""}
    </article>
  `;
}

function renderFacts(facts) {
  const cleanFacts = dedupeFacts(facts).filter(
    (fact) => fact.subjectUserId !== currentUser?.id && fact.subjectUserId !== "self"
  );

  if (!cleanFacts.length) {
    return `<article class="stack-item"><p>当前还没有提取出的对方已确认事实。</p></article>`;
  }

  return cleanFacts
    .map((fact) => {
      const label = getTopicKeyLabel(fact.key);
      return `
        <article class="stack-item">
          <header>
            <strong>${escapeHtml(`对方 · ${label}`)}</strong>
            <span class="pill low">置信度 ${escapeHtml(String(fact.confidence))}</span>
          </header>
          <p>${escapeHtml(localizeStructuredValue(fact.value) || localizeDisplayText(fact.value, "暂无"))}</p>
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
      const nextAction = getNextActionLabel(report.payload.next_action);

      return `
        <article class="stack-item">
          <header>
            <strong>阶段总结</strong>
            <span class="pill medium">${escapeHtml(formatDateTime(report.createdAt))}</span>
          </header>
          <p><strong>摘要：</strong>${escapeHtml(localizeDisplayText(report.payload.summary, "暂无"))}</p>
          <p><strong>未决问题：</strong>${escapeHtml(localizeDisplayList(unresolved, "暂无"))}</p>
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
            const requestStatusLabel =
              request.status === "pending"
                ? "待处理"
                : request.status === "approved"
                  ? "已批准"
                  : request.status === "rejected"
                    ? "已拒绝"
                    : request.status;

            const summaryText =
              localizeDisplayText(
                request.metadata?.summaryText,
                "系统准备进入这一敏感议题，需要先由被问方授权。"
              );

            return `
              <article class="stack-item">
                <header>
                  <strong>${escapeHtml(getSensitiveTopicLabel(request.topicCategory))}</strong>
                  <span class="pill ${request.status === "pending" ? "sensitive" : "low"}">${escapeHtml(requestStatusLabel)}</span>
                </header>
                <p><strong>被问方：</strong>${escapeHtml(targetName)}</p>
                <p><strong>授权说明：</strong>${escapeHtml(summaryText)}</p>
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
      <div class="summary-card summary-card--progress">
        <h4>本轮议题进展</h4>
        <div class="summary-card-scroll summary-card-scroll--progress">
          <p>当前还没有可展示的议题进展。</p>
        </div>
      </div>
    `;
  }

  return `
    <div class="summary-card summary-card--progress">
      <h4>本轮议题进展</h4>
      <div class="summary-card-scroll summary-card-scroll--progress">
        <div class="progress-list">
        ${progress
          .map((item) => {
            const label =
              item.status === "confirmed" ? "已确认" : item.status === "pending" ? "待推进" : "未解决";
            const tone = item.status === "confirmed" ? "ok" : item.status === "pending" ? "medium" : "low";

            return `
              <div class="progress-item">
                <strong>${escapeHtml(localizeDisplayText(item.label, getTopicKeyLabel(item.topicKey || item.key)))}</strong>
                <span class="pill ${escapeHtml(tone)}">${escapeHtml(label)}</span>
              </div>
            `;
          })
          .join("")}
        </div>
      </div>
    </div>
  `;
}

function renderInlinePauseNotice(session, humanInputRequests = []) {
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

function renderManualPauseNotice(session) {
  const manualPause = getManualPauseState(session);

  if (!manualPause.anyPaused) {
    return "";
  }

  const stateText = manualPause.currentUserPaused
    ? "你已将这条会话设为“结束推进”。"
    : "对方已将这条会话设为“结束推进”。";
  const myQuotaText = `你剩余 ${manualPause.remainingManualMessages} / 1 条真人消息额度。`;
  const counterpartQuotaText = `对方剩余 ${manualPause.counterpartRemainingManualMessages} / 1 条真人消息额度。`;
  const pendingText = session.humanInputRequestsBlocked
    ? "当前若有待处理的本人补充，也需要先恢复“继续推进”。"
    : "";

  return `
    <article class="chat-inline-notice-row">
      <p class="chat-inline-notice">${escapeHtml(`${stateText} 只要任意一方处于“结束推进”，双方 Twin 都会停止沟通；${myQuotaText} ${counterpartQuotaText}${pendingText ? ` ${pendingText}` : ""}`)}</p>
    </article>
  `;
}

function renderComposerQuoteBar() {
  const quotedTurn = composerState.quotedTurnId ? getTurnById(composerState.quotedTurnId) : null;

  if (!quotedTurn) {
    return "";
  }

  const actorLabel = quotedTurn.actorUserId === currentUser?.id
    ? "你"
    : quotedTurn.actorUserId == null
      ? "系统"
      : quotedTurn.actorRole.endsWith("_twin")
        ? "Twin"
        : "对方";

  const content = quotedTurn.isRecalled
    ? "该消息已撤回"
    : quotedTurn.content;

  return `
    <div class="composer-quote-bar">
      <div class="composer-quote-bar__copy">
        <strong>引用 ${escapeHtml(actorLabel)}</strong>
        <p>${escapeHtml(content)}</p>
      </div>
      <button type="button" class="composer-quote-bar__close" data-action="clear-quote">取消</button>
    </div>
  `;
}

function renderComposerEditBar(turn) {
  if (!turn) {
    return "";
  }

  return `
    <div class="composer-quote-bar is-editing">
      <div class="composer-quote-bar__copy">
        <strong>正在修改消息</strong>
        <p>${escapeHtml(turn.content)}</p>
      </div>
      <button type="button" class="composer-quote-bar__close" data-action="cancel-edit">取消</button>
    </div>
  `;
}

function renderDirectComposer(session, humanInputRequests = []) {
  if (["awaiting_counterparty_acceptance", "rejected", "blocked_risk"].includes(session.status)) {
    return "";
  }

  const manualPause = getManualPauseState(session);
  const mode = getComposerMode(session, humanInputRequests);
  const canSubmit =
    mode.type === "edit" ||
    mode.type === "human_input" ||
    !manualPause.anyPaused ||
    manualPause.remainingManualMessages > 0;
  const placeholder =
    mode.type === "edit"
      ? "修改这条真人消息"
      : mode.type === "human_input"
        ? "输入你想以本人身份补充的内容"
        : manualPause.anyPaused
          ? manualPause.remainingManualMessages > 0
            ? "Twin 已暂停，输入你想发送的真人消息"
            : "当前暂停期间，你的真人消息额度已用完"
          : "输入你想发送的真人消息";
  const helperText =
    mode.pending && manualPause.pendingHumanInputBlocked
      ? "当前有待处理的本人补充，但限制期内不能提交；如需继续，请先点击“继续推进”。"
      : "";
  const submitLabel = mode.type === "edit" ? "保存" : "发送";
  const quotedMarkup = mode.type === "edit" ? "" : renderComposerQuoteBar();
  const editMarkup = mode.type === "edit" ? renderComposerEditBar(mode.editingTurn) : "";
  const initialValue = mode.type === "edit" ? escapeHtml(mode.editingTurn?.content || "") : "";

  return `
    <section class="message-composer">
      <form
        class="composer-form-inline"
        data-direct-message-form
        data-mode="${escapeHtml(mode.type)}"
        ${mode.requestId ? `data-request-id="${escapeHtml(mode.requestId)}"` : ""}
        ${mode.editingTurn ? `data-edit-turn-id="${escapeHtml(mode.editingTurn.id)}"` : ""}
      >
        ${editMarkup}
        ${quotedMarkup}
        <div class="composer-input-shell">
          <textarea
            name="content"
            rows="3"
            placeholder="${escapeHtml(placeholder)}"
            ${!canSubmit ? "disabled" : ""}
          >${initialValue}</textarea>
          <button
            class="primary-button composer-send-button composer-send-button--floating"
            type="submit"
            ${!canSubmit ? "disabled" : ""}
          >${escapeHtml(submitLabel)}</button>
        </div>
      </form>
      ${helperText ? `<p class="chat-inline-notice">${escapeHtml(helperText)}</p>` : ""}
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

  if (!actions.length) {
    return "";
  }

  return `<div class="chat-panel-actions">${actions.join("")}</div>`;
}

function renderManualPauseToggle(session) {
  if (!["active", "paused_review", "pending_human_input", "pending_sensitive_approval", "completed"].includes(session.status)) {
    return "";
  }

  const manualPause = getManualPauseState(session);
  return `
    <div class="chat-panel-head-side">
      ${actionButton(manualPause.currentUserPaused ? "继续推进" : "结束推进", "toggle-manual-pause", "primary-button")}
    </div>
  `;
}

function renderSidebar(detail) {
  return `
    <aside class="messenger-sidebar">
      ${renderObjectiveProgress(detail.stageReports)}

      <div class="summary-card summary-card--facts">
        <h4>已确认事实</h4>
        <div class="summary-card-scroll summary-card-scroll--facts">
          <div class="stack-list compact-list">${renderFacts(detail.facts)}</div>
        </div>
      </div>

      <div class="summary-card summary-card--reports">
        <h4>阶段报告</h4>
        <div class="summary-card-scroll summary-card-scroll--reports">
          <div class="stack-list compact-list">${renderStageReports(detail.stageReports)}</div>
        </div>
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
      ${renderManualPauseToggle(session)}
    </div>
  `;
}

function renderEmptyThreadNotice(session) {
  const latestStageReport = Array.isArray(session.stageReports) ? session.stageReports[0] : null;
  const stopReason = latestStageReport?.payload?.stop_reason || session.latestStopReason || null;

  if (session.status === "active") {
    return "系统正在自动启动 Twin 预沟通…";
  }

  if (session.status === "paused_review" && stopReason === "auto_start_failed") {
    return "系统已暂停自动启动，请查看线程说明或等待恢复。";
  }

  if (stopReason) {
    return `当前会话暂无新消息，当前状态：${getStopReasonLabel(stopReason)}。`;
  }

  return "当前还没有预沟通消息。";
}

function ensureMessageMenu() {
  let menu = document.querySelector("#message-context-menu");

  if (menu) {
    return menu;
  }

  menu = document.createElement("div");
  menu.id = "message-context-menu";
  menu.className = "session-context-menu";
  menu.hidden = true;
  document.body.appendChild(menu);
  return menu;
}

function hideMessageMenu() {
  const menu = document.querySelector("#message-context-menu");

  if (!menu) {
    return;
  }

  menu.hidden = true;
  menu.innerHTML = "";
  messageMenuState = { turnId: null };
}

function getMessageMenuItems(turn) {
  if (!turn || turn.isRecalled) {
    return [];
  }

  const items = [];

  if (turn.canDelete) {
    items.push({ action: "delete-message", label: "删除" });
  }

  if (turn.canRecall) {
    items.push({ action: "recall-message", label: "撤回" });
  }

  if (turn.canQuote) {
    items.push({ action: "quote-message", label: "引用" });
  }

  if (turn.canEdit) {
    items.push({ action: "edit-message", label: "修改" });
  }

  if (turn.canReact) {
    items.push({ action: "open-reaction-menu", label: "反应" });
  }

  return items;
}

function showMessageMenu(turnId, x, y) {
  const turn = getTurnById(turnId);
  const items = getMessageMenuItems(turn);

  if (!items.length) {
    hideMessageMenu();
    return;
  }

  const menu = ensureMessageMenu();
  menu.innerHTML = items
    .map(
      (item) =>
        `<button type="button" class="session-context-menu__item" data-action="${escapeHtml(item.action)}">${escapeHtml(item.label)}</button>`
    )
    .join("");
  menu.hidden = false;
  messageMenuState = { turnId };
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const rect = menu.getBoundingClientRect();
  const maxLeft = Math.max(12, window.innerWidth - rect.width - 12);
  const maxTop = Math.max(12, window.innerHeight - rect.height - 12);
  menu.style.left = `${Math.min(x, maxLeft)}px`;
  menu.style.top = `${Math.min(y, maxTop)}px`;
}

function startLongPress(event) {
  const target = event.target.closest("[data-turn-id]");
  const turnId = target?.dataset.turnId;

  if (!turnId || longPressTimer) {
    return;
  }

  longPressTimer = window.setTimeout(() => {
    const touch = event.touches?.[0];
    if (!touch) {
      return;
    }

    showMessageMenu(turnId, touch.clientX, touch.clientY);
    longPressTimer = null;
  }, LONG_PRESS_MS);
}

function cancelLongPress() {
  if (longPressTimer) {
    window.clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

function scrollFeedToBottom() {
  const feed = sessionShell.querySelector(".message-feed");

  if (feed) {
    feed.scrollTop = feed.scrollHeight;
  }
}

function stopAutomationPolling() {
  if (automationPollTimer) {
    window.clearTimeout(automationPollTimer);
    automationPollTimer = null;
  }
}

function getAutomationRunState(session) {
  return session?.control?.automation?.runState || "idle";
}

function isAutomationRunning(session) {
  return ["queued", "running"].includes(getAutomationRunState(session));
}

function scheduleAutomationPolling() {
  stopAutomationPolling();

  if (!sessionDetail?.session || !isAutomationRunning(sessionDetail.session)) {
    return;
  }

  automationPollTimer = window.setTimeout(async () => {
    try {
      await loadSession({ preserveStatus: true, silent: true });
    } catch (error) {
      setStatus("error", `刷新会话失败：${error.message}`);
    }
  }, 900);
}

function syncComposerClearance() {
  const panel = sessionShell.querySelector(".chat-panel");
  if (!panel) {
    return;
  }

  const composer = panel.querySelector(".message-composer");
  const clearance = composer ? Math.ceil(composer.getBoundingClientRect().height) : 0;
  panel.style.setProperty("--composer-clearance", `${clearance}px`);
}

function renderSession(detail) {
  const { session, turns, humanInputRequests } = detail;
  session.humanInputRequestsBlocked = getManualPauseState(session).pendingHumanInputBlocked;
  session.stageReports = detail.stageReports;

  if (composerState.editingTurnId && !turns.some((turn) => turn.id === composerState.editingTurnId && turn.canEdit)) {
    composerState.editingTurnId = null;
  }

  if (composerState.quotedTurnId && !turns.some((turn) => turn.id === composerState.quotedTurnId)) {
    composerState.quotedTurnId = null;
  }

  sessionHeroText.textContent = "当前正在查看透明预沟通会话。";
  setStatus(
    isAutomationRunning(session) ? "saving" : "saved",
    isAutomationRunning(session)
      ? `Twin 正在继续沟通 · ${getPrechatStatusLabel(session.status)}`
      : `会话已加载 · ${getPrechatStatusLabel(session.status)}`
  );

  sessionShell.innerHTML = `
    <div class="messenger-layout">
      <section class="messenger-main">
        <div class="chat-panel">
          ${renderChatPanelHead(session)}
          ${renderActions(detail)}
          <div class="message-feed">
            ${
              turns.length
                ? turns.map((turn) => renderTurn(turn, session)).join("")
                : `<article class="chat-inline-notice-row"><p class="chat-inline-notice">${escapeHtml(renderEmptyThreadNotice(session))}</p></article>`
            }
            ${renderManualPauseNotice(session)}
            ${renderInlinePauseNotice(session, humanInputRequests)}
          </div>
          ${renderDirectComposer(session, humanInputRequests)}
        </div>
      </section>
      ${renderSidebar(detail)}
    </div>
  `;

  const textarea = sessionShell.querySelector('[data-direct-message-form] textarea');
  if (textarea && composerState.editingTurnId) {
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  requestAnimationFrame(() => {
    syncComposerClearance();
    scrollFeedToBottom();
  });
  scheduleAutomationPolling();
}

async function loadSession(options = {}) {
  const { preserveStatus = false, silent = false } = options;

  if (!sessionId) {
    sessionShell.innerHTML = renderEmptyState("缺少 sessionId", "请从匹配页、待办箱或所有会话进入具体会话。");
    setStatus("error", "缺少 sessionId。");
    return;
  }

  if (!preserveStatus && !silent) {
    setStatus("saving", "正在加载会话...");
  }
  sessionDetail = await fetchJson(`/api/prechat/sessions/${encodeURIComponent(sessionId)}`);
  renderSession(sessionDetail);
}

async function performMessageAction(action, turnId, extra = {}) {
  if (!turnId) {
    return;
  }

  if (action === "quote-message") {
    composerState.quotedTurnId = turnId;
    composerState.editingTurnId = null;
    renderSession(sessionDetail);
    hideMessageMenu();
    return;
  }

  if (action === "edit-message") {
    const turn = getTurnById(turnId);
    if (!turn?.canEdit) {
      return;
    }

    composerState.editingTurnId = turnId;
    composerState.quotedTurnId = null;
    renderSession(sessionDetail);
    hideMessageMenu();
    return;
  }

  if (action === "open-reaction-menu") {
    const menu = ensureMessageMenu();
    menu.innerHTML = MESSAGE_REACTIONS.map(
      (emoji) =>
        `<button type="button" class="session-context-menu__item" data-action="apply-reaction" data-emoji="${escapeHtml(emoji)}">${escapeHtml(emoji)}</button>`
    ).join("");
    return;
  }

  const routes = {
    "delete-message": "delete",
    "recall-message": "recall"
  };

  if (action === "apply-reaction" || action === "toggle-reaction") {
    await fetchJson(
      `/api/prechat/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(turnId)}/react`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji: extra.emoji })
      }
    );
    hideMessageMenu();
    await loadSession();
    return;
  }

  const route = routes[action];
  if (!route) {
    return;
  }

  await fetchJson(
    `/api/prechat/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(turnId)}/${route}`,
    { method: "POST" }
  );

  if (composerState.quotedTurnId === turnId) {
    composerState.quotedTurnId = null;
  }
  if (composerState.editingTurnId === turnId) {
    composerState.editingTurnId = null;
  }

  hideMessageMenu();
  await loadSession();
}

sessionShell.addEventListener("contextmenu", (event) => {
  const target = event.target.closest("[data-turn-id]");
  if (!target) {
    return;
  }

  const turnId = target.dataset.turnId;
  const turn = getTurnById(turnId);
  if (!turn || !getMessageMenuItems(turn).length) {
    return;
  }

  event.preventDefault();
  showMessageMenu(turnId, event.clientX, event.clientY);
});

sessionShell.addEventListener("touchstart", (event) => {
  startLongPress(event);
}, { passive: true });

sessionShell.addEventListener("touchmove", cancelLongPress, { passive: true });
sessionShell.addEventListener("touchend", cancelLongPress, { passive: true });
sessionShell.addEventListener("touchcancel", cancelLongPress, { passive: true });
sessionShell.addEventListener("scroll", hideMessageMenu, true);

sessionShell.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");

  if (!button) {
    return;
  }

  const action = button.dataset.action;
  const id = button.dataset.id;
  const turnId = button.dataset.turnId || messageMenuState.turnId;
  const emoji = button.dataset.emoji;

  try {
    if (action === "clear-quote") {
      composerState.quotedTurnId = null;
      renderSession(sessionDetail);
      return;
    }

    if (action === "cancel-edit") {
      composerState.editingTurnId = null;
      renderSession(sessionDetail);
      return;
    }

    if (
      [
        "delete-message",
        "recall-message",
        "quote-message",
        "edit-message",
        "open-reaction-menu",
        "apply-reaction",
        "toggle-reaction"
      ].includes(action)
    ) {
      setStatus("saving", "正在提交消息操作...");
      await performMessageAction(action, turnId, { emoji });
      return;
    }

    setStatus("saving", "正在提交操作...");

    if (action === "accept-invitation") {
      await fetchJson(`/api/prechat/invitations/${encodeURIComponent(sessionId)}/accept`, { method: "POST" });
    } else if (action === "reject-invitation") {
      await fetchJson(`/api/prechat/invitations/${encodeURIComponent(sessionId)}/reject`, { method: "POST" });
    } else if (action === "reject-session") {
      await fetchJson(`/api/prechat/sessions/${encodeURIComponent(sessionId)}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject" })
      });
    } else if (action === "toggle-manual-pause") {
      await fetchJson(`/api/prechat/sessions/${encodeURIComponent(sessionId)}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "toggle_manual_pause" })
      });
    } else if (action === "approve-sensitive") {
      await fetchJson(`/api/sensitive-requests/${encodeURIComponent(id)}/approve`, { method: "POST" });
    } else if (action === "reject-sensitive") {
      await fetchJson(`/api/sensitive-requests/${encodeURIComponent(id)}/reject`, { method: "POST" });
    }

    hideMessageMenu();
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
  const content = String(data.get("content") || "");
  const quotedTurnId = composerState.editingTurnId ? null : composerState.quotedTurnId;

  try {
    if (form.dataset.editTurnId) {
      setStatus("saving", "正在保存修改...");
      await fetchJson(
        `/api/prechat/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(form.dataset.editTurnId)}/edit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content })
        }
      );
    } else if (form.dataset.requestId) {
      setStatus("saving", "正在发送本人消息并继续...");
      await fetchJson(`/api/prechat/sessions/${encodeURIComponent(sessionId)}/human-input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: form.dataset.requestId,
          responseText: content,
          quotedTurnId
        })
      });
    } else {
      setStatus("saving", "正在发送真人消息...");
      await fetchJson(`/api/prechat/sessions/${encodeURIComponent(sessionId)}/manual-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          quotedTurnId
        })
      });
    }

    clearComposerState();
    hideMessageMenu();
    await loadSession({ preserveStatus: true });
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

document.addEventListener("click", (event) => {
  const menuAction = event.target.closest("#message-context-menu [data-action]");
  if (menuAction) {
    const action = menuAction.dataset.action;
    const turnId = messageMenuState.turnId;
    const emoji = menuAction.dataset.emoji;

    if (!["quote-message", "edit-message", "open-reaction-menu"].includes(action)) {
      setStatus("saving", "正在提交消息操作...");
    }
    performMessageAction(action, turnId, { emoji }).catch((error) => {
      setStatus("error", `操作失败：${error.message}`);
    });
    return;
  }

  if (!event.target.closest("#message-context-menu")) {
    hideMessageMenu();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hideMessageMenu();
  }
});

logoutButton.addEventListener("click", () => logout());

window.addEventListener("resize", () => {
  requestAnimationFrame(syncComposerClearance);
});

const auth = await requireAuth();
if (auth) {
  currentUser = auth.user;
  await loadSession();
}
