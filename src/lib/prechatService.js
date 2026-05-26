import {
  addConversationTurn,
  createHumanInputRequest,
  createPrechatRound,
  createSensitiveQuestionRequest,
  createStageReport,
  finishPrechatRound,
  getCurrentTwin,
  getLatestOpenSessionForMatch,
  getLatestTurnNumber,
  getMatchForUser,
  getPrechatRound,
  getPrechatSessionById,
  getPrechatSessionForUser,
  getSessionDetailForUser,
  getSessionParticipantProfiles,
  getSensitiveQuestionRequestForUser,
  getHumanInputRequestForUser,
  listConversationTurns,
  listExtractedFacts,
  resolveHumanInputRequest,
  saveCurrentTwin,
  saveExtractedFacts,
  updatePrechatSession,
  updateSensitiveQuestionRequest
} from "./database.js";
import { generatePrechatTurn, summarizeStage } from "./llmAdapter.js";

const MAX_TURNS_PER_ROUND = 6;
const MAX_OBJECTIVES = 3;
const HIGH_RISK_TYPES = new Set(["money_request", "coercion", "harassment", "identity_conflict"]);

const TOPIC_CONFIG = [
  {
    key: "relationshipGoal",
    label: "关系目标",
    prompt: "确认双方是否都以认真长期关系为导向。"
  },
  {
    key: "cities",
    label: "城市与生活安排",
    prompt: "确认长期城市安排与生活落地预期。"
  },
  {
    key: "marriageTimeline",
    label: "结婚节奏",
    prompt: "确认结婚推进节奏是否接近。"
  },
  {
    key: "childrenPreference",
    label: "孩子与生育态度",
    prompt: "确认对未来孩子与生育的态度。"
  },
  {
    key: "familyBoundary",
    label: "家庭边界",
    prompt: "确认父母参与度和婚后边界。"
  },
  {
    key: "financialView",
    label: "财务观",
    prompt: "确认金钱观、消费观与现实安排。"
  }
];

function normalizeText(value) {
  return String(value || "").trim();
}

function participantRole(session, userId) {
  return session.initiatorUserId === userId ? "initiator" : "counterparty";
}

function isHighRisk(riskFlags = []) {
  return riskFlags.some(
    (flag) => String(flag.severity || "").toLowerCase() === "high" || HIGH_RISK_TYPES.has(flag.type)
  );
}

function resolveTargetUserId(selector, speakerUserId, listenerUserId) {
  const normalized = String(selector || "").toLowerCase();

  if (["listener", "counterparty", "other", "target"].includes(normalized)) {
    return listenerUserId;
  }

  if (["speaker", "self", "me"].includes(normalized)) {
    return speakerUserId;
  }

  return listenerUserId;
}

function resolveFactSubjectUserId(subjectUserId, speakerUserId, listenerUserId) {
  const normalized = String(subjectUserId || "").toLowerCase();

  if (["self", "speaker", "me"].includes(normalized)) {
    return speakerUserId;
  }

  if (["listener", "counterparty", "other", "target"].includes(normalized)) {
    return listenerUserId;
  }

  return subjectUserId || speakerUserId;
}

function ensureSensitiveCategoryAllowed(targetTwin, category) {
  const allowed = Array.isArray(targetTwin?.twinProfile?.authorizedSensitiveTopics)
    ? targetTwin.twinProfile.authorizedSensitiveTopics
    : [];

  return allowed.includes(category);
}

function buildObjectives(initiatorTwin, counterpartyTwin, facts = []) {
  const factKeys = new Set(facts.map((fact) => fact.key));
  const objectives = [];

  for (const topic of TOPIC_CONFIG) {
    if (factKeys.has(topic.key)) {
      continue;
    }

    const left = normalizeText(initiatorTwin?.twinProfile?.[topic.key]);
    const right = normalizeText(counterpartyTwin?.twinProfile?.[topic.key]);

    if (!left || !right || left !== right) {
      objectives.push(topic);
    }

    if (objectives.length >= MAX_OBJECTIVES) {
      break;
    }
  }

  return objectives.length ? objectives : TOPIC_CONFIG.slice(0, MAX_OBJECTIVES);
}

function buildTurnContext({ session, round, speaker, listener, objectives, turns, facts }) {
  return {
    session_id: session.id,
    round_number: round.roundNumber,
    speaker_role: participantRole(session, speaker.userId),
    listener_role: participantRole(session, listener.userId),
    speaker: {
      userId: speaker.userId,
      displayName: speaker.displayName,
      twinProfile: speaker.twinProfile
    },
    listener: {
      userId: listener.userId,
      displayName: listener.displayName,
      twinProfile: listener.twinProfile
    },
    objectives: objectives.map((item) => ({
      key: item.key,
      label: item.label,
      prompt: item.prompt
    })),
    recent_turns: turns.slice(-6).map((turn) => ({
      actorRole: turn.actorRole,
      actorUserId: turn.actorUserId,
      content: turn.content
    })),
    known_facts: facts.slice(-12).map((fact) => ({
      key: fact.key,
      value: fact.value,
      confidence: fact.confidence,
      subjectUserId: fact.subjectUserId
    })),
    constraints: {
      max_messages_this_round: MAX_TURNS_PER_ROUND,
      if_sensitive_then_request_approval: true,
      if_missing_self_fact_then_needs_human_input: true,
      must_output_json: true
    }
  };
}

function buildStageContext({ session, round, turns, facts, stopReason }) {
  return {
    session_id: session.id,
    round_number: round.roundNumber,
    stop_reason: stopReason,
    turns: turns.map((turn) => ({
      actorRole: turn.actorRole,
      content: turn.content
    })),
    facts: facts.map((fact) => ({
      key: fact.key,
      value: fact.value,
      confidence: fact.confidence,
      subjectUserId: fact.subjectUserId
    }))
  };
}

function toSessionResponse(detail, currentUserId) {
  const { session } = detail;
  const participants = getSessionParticipantProfiles(session);
  const currentTwin =
    participants.initiator?.userId === currentUserId ? participants.initiator : participants.counterparty;

  return {
    ...detail,
    currentUser: currentTwin
      ? {
          id: currentTwin.userId,
          displayName: currentTwin.displayName,
          email: currentTwin.email
        }
      : null,
    session: {
      ...session,
      currentUserRole: participantRole(session, currentUserId),
      initiator: {
        id: participants.initiator?.userId,
        displayName: participants.initiator?.displayName
      },
      counterparty: {
        id: participants.counterparty?.userId,
        displayName: participants.counterparty?.displayName
      }
    }
  };
}

async function createRoundSummary(session, round, stopReason) {
  const turns = listConversationTurns(session.id).filter((turn) => turn.roundId === round.id);
  const facts = listExtractedFacts(session.id).filter((fact) => fact.roundId === round.id);
  const payload = await summarizeStage(buildStageContext({ session, round, turns, facts, stopReason }));
  return createStageReport(session.id, round.id, payload);
}

async function completeRound(session, round, status, stopReason) {
  finishPrechatRound(round.id, { status: "completed", stopReason });
  updatePrechatSession(session.id, { status });
  const stageReport = await createRoundSummary(session, round, stopReason);
  return { status, stageReport, stopReason };
}

async function executeConversationLoop({ session, round, speakerUserId, startingTurnNumber }) {
  const participants = getSessionParticipantProfiles(session);
  const objectives = buildObjectives(
    participants.initiator,
    participants.counterparty,
    listExtractedFacts(session.id)
  );
  let currentSpeakerId = speakerUserId;
  let nextTurnNumber = startingTurnNumber;

  while (nextTurnNumber <= MAX_TURNS_PER_ROUND) {
    const speaker =
      session.initiatorUserId === currentSpeakerId ? participants.initiator : participants.counterparty;
    const listener =
      session.initiatorUserId === currentSpeakerId ? participants.counterparty : participants.initiator;
    const turnsSoFar = listConversationTurns(session.id);
    const factsSoFar = listExtractedFacts(session.id);

    const result = await generatePrechatTurn(
      buildTurnContext({
        session,
        round,
        speaker,
        listener,
        objectives,
        turns: turnsSoFar,
        facts: factsSoFar
      })
    );

    if (result.needs_sensitive_approval || result.is_sensitive_question) {
      const targetUserId = resolveTargetUserId(
        result.target_user_for_approval,
        speaker.userId,
        listener.userId
      );
      const targetTwin =
        targetUserId === participants.initiator.userId ? participants.initiator : participants.counterparty;

      if (!ensureSensitiveCategoryAllowed(targetTwin, result.sensitive_topic_category)) {
        return completeRound(session, round, "paused_review", "sensitive_topic_not_authorized");
      }

      createSensitiveQuestionRequest({
        sessionId: session.id,
        roundId: round.id,
        requestingUserId: speaker.userId,
        targetUserId,
        questionText: result.reply,
        topicCategory: result.sensitive_topic_category || "unknown",
        metadata: { turnNumber: nextTurnNumber }
      });

      return completeRound(session, round, "pending_sensitive_approval", "pending_sensitive_approval");
    }

    if (result.needs_human_input.required) {
      const targetUserId = resolveTargetUserId(
        result.needs_human_input.target_user_for_input,
        speaker.userId,
        listener.userId
      );

      createHumanInputRequest({
        sessionId: session.id,
        roundId: round.id,
        targetUserId,
        fieldKey: result.needs_human_input.field || "manual_review",
        questionText: result.needs_human_input.question || "请人工补充这一项信息。",
        metadata: { turnNumber: nextTurnNumber }
      });

      return completeRound(session, round, "pending_human_input", "pending_human_input");
    }

    const turn = addConversationTurn({
      sessionId: session.id,
      roundId: round.id,
      turnNumber: nextTurnNumber,
      actorUserId: speaker.userId,
      actorRole: `${participantRole(session, speaker.userId)}_twin`,
      content: result.reply,
      metadata: result
    });

    if (result.confirmed_facts.length) {
      saveExtractedFacts(
        session.id,
        round.id,
        result.confirmed_facts.map((fact) => ({
          ...fact,
          subjectUserId: resolveFactSubjectUserId(fact.subjectUserId, speaker.userId, listener.userId)
        })),
        turn.id
      );
    }

    if (isHighRisk(result.risk_flags)) {
      return completeRound(session, round, "blocked_risk", "blocked_risk");
    }

    if (result.recommendation === "handoff_ready") {
      return completeRound(session, round, "handoff_ready", "handoff_ready");
    }

    if (result.recommendation === "pause_review") {
      return completeRound(session, round, "paused_review", "paused_review");
    }

    currentSpeakerId = listener.userId;
    nextTurnNumber += 1;
  }

  return completeRound(session, round, "paused_review", "max_turns_reached");
}

export async function createPrechatInvitation(matchId, initiatorUserId, createSessionFn) {
  const match = getMatchForUser(matchId, initiatorUserId);

  if (!match) {
    throw new Error("未找到可发起预沟通的匹配。");
  }

  const existing = getLatestOpenSessionForMatch(matchId);

  if (existing) {
    return existing;
  }

  const counterpartyUserId = match.userAId === initiatorUserId ? match.userBId : match.userAId;
  return createSessionFn({ matchId, initiatorUserId, counterpartyUserId });
}

export async function acceptInvitation(sessionId, currentUserId) {
  const session = getPrechatSessionForUser(sessionId, currentUserId);

  if (!session || session.counterpartyUserId !== currentUserId) {
    throw new Error("未找到可接受的预沟通邀请。");
  }

  if (session.status !== "awaiting_counterparty_acceptance") {
    throw new Error("当前邀请状态无法接受。");
  }

  updatePrechatSession(session.id, { status: "active" });
  return getPrechatSessionForUser(session.id, currentUserId);
}

export async function rejectInvitation(sessionId, currentUserId) {
  const session = getPrechatSessionForUser(sessionId, currentUserId);

  if (!session || session.counterpartyUserId !== currentUserId) {
    throw new Error("未找到可拒绝的预沟通邀请。");
  }

  updatePrechatSession(session.id, { status: "rejected" });
  return getPrechatSessionForUser(session.id, currentUserId);
}

export async function runSessionRound(sessionId, currentUserId) {
  const session = getPrechatSessionForUser(sessionId, currentUserId);

  if (!session) {
    throw new Error("未找到该预沟通会话。");
  }

  if (["awaiting_counterparty_acceptance", "pending_sensitive_approval", "pending_human_input"].includes(session.status)) {
    throw new Error("当前会话状态下不能继续运行新一轮。");
  }

  if (["blocked_risk", "rejected", "completed"].includes(session.status)) {
    throw new Error("当前会话已结束，无法继续。");
  }

  const roundNumber = session.currentRound + 1;
  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber,
    objective: {
      topics: buildObjectives(
        getCurrentTwin(session.initiatorUserId),
        getCurrentTwin(session.counterpartyUserId),
        listExtractedFacts(session.id)
      )
    }
  });

  updatePrechatSession(session.id, { status: "active", currentRound: roundNumber });
  return executeConversationLoop({
    session: getPrechatSessionById(session.id),
    round,
    speakerUserId: session.initiatorUserId,
    startingTurnNumber: 1
  });
}

export async function approveSensitiveQuestion(requestId, currentUserId) {
  const request = getSensitiveQuestionRequestForUser(requestId, currentUserId);

  if (!request || request.status !== "pending" || request.targetUserId !== currentUserId) {
    throw new Error("未找到可批准的敏感问题请求。");
  }

  updateSensitiveQuestionRequest(requestId, {
    status: "approved",
    metadata: {
      ...(request.metadata || {}),
      approvedByUserId: currentUserId
    }
  });

  const session = getPrechatSessionById(request.sessionId);
  const round = getPrechatRound(request.roundId);
  const turnNumber = getLatestTurnNumber(round.id) + 1;

  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber,
    actorUserId: request.requestingUserId,
    actorRole: `${participantRole(session, request.requestingUserId)}_twin`,
    content: request.questionText,
    metadata: {
      sensitiveApproved: true,
      topicCategory: request.topicCategory
    }
  });

  updatePrechatSession(session.id, { status: "active" });

  return executeConversationLoop({
    session,
    round,
    speakerUserId: currentUserId,
    startingTurnNumber: turnNumber + 1
  });
}

export async function rejectSensitiveQuestion(requestId, currentUserId) {
  const request = getSensitiveQuestionRequestForUser(requestId, currentUserId);

  if (!request || request.status !== "pending") {
    throw new Error("未找到可拒绝的敏感问题请求。");
  }

  updateSensitiveQuestionRequest(requestId, {
    status: "rejected",
    metadata: {
      ...(request.metadata || {}),
      rejectedByUserId: currentUserId
    }
  });

  updatePrechatSession(request.sessionId, { status: "paused_review" });
  const session = getPrechatSessionById(request.sessionId);
  const round = getPrechatRound(request.roundId);
  const stageReport = await createRoundSummary(session, round, "sensitive_question_rejected");

  return { status: "paused_review", stageReport };
}

export async function submitHumanInput(requestId, currentUserId, responseText) {
  const request = getHumanInputRequestForUser(requestId, currentUserId);

  if (!request || request.status !== "pending") {
    throw new Error("未找到需要补充的人工问题。");
  }

  resolveHumanInputRequest(requestId, responseText, { resolvedByUserId: currentUserId });

  const currentTwin = getCurrentTwin(currentUserId);
  const nextTwinProfile = {
    ...(currentTwin?.twinProfile || {}),
    [request.fieldKey]: responseText
  };

  if (!currentTwin?.twinProfile?.displayName) {
    nextTwinProfile.displayName = currentTwin?.displayName || "未命名用户";
  }

  saveCurrentTwin(currentUserId, nextTwinProfile);
  updatePrechatSession(request.sessionId, { status: "active" });
  return getPrechatSessionForUser(request.sessionId, currentUserId);
}

export function getSessionView(sessionId, currentUserId) {
  const detail = getSessionDetailForUser(sessionId, currentUserId);

  if (!detail) {
    return null;
  }

  return toSessionResponse(detail, currentUserId);
}

export function applySessionDecision(sessionId, currentUserId, action) {
  const session = getPrechatSessionForUser(sessionId, currentUserId);

  if (!session) {
    throw new Error("未找到该预沟通会话。");
  }

  if (action === "pause") {
    updatePrechatSession(session.id, { status: "paused_review" });
  } else if (action === "reject") {
    updatePrechatSession(session.id, { status: "rejected" });
  } else if (action === "handoff") {
    updatePrechatSession(session.id, { status: "handoff_ready" });
  } else {
    throw new Error("不支持的会话操作。");
  }

  return getPrechatSessionForUser(session.id, currentUserId);
}
