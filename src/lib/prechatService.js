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
  listPrechatRounds,
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
  rejectSiblingPendingInvitations,
  saveCurrentTwin,
  saveExtractedFacts,
  updatePrechatSession,
  updateSensitiveQuestionRequest
} from "./database.js";
import { generatePrechatTurn, summarizeStage } from "./llmAdapter.js";

const MAX_TURNS_PER_ROUND = 6;
const MAX_OBJECTIVES = 3;
const MAX_AUTO_ROUNDS = 12;
const HIGH_RISK_TYPES = new Set(["money_request", "coercion", "harassment", "identity_conflict"]);
const AUTO_CONTINUE_STOP_REASONS = new Set(["objectives_completed", "paused_review", "max_turns_reached"]);

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

function buildPauseMessage(targetDisplayName, fieldKey, questionText) {
  if (fieldKey === "manual_review") {
    return "系统暂停：这一轮没有拿到稳定的模型输出，等待用户本人补充说明或手动接管后再继续。";
  }

  return `系统暂停：需要 ${targetDisplayName} 本人补充信息后才能继续。待确认内容：${questionText}`;
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

function getPrechatGoalConfig(initiatorTwin) {
  const goals = initiatorTwin?.twinProfile?.prechatGoals;
  return goals && typeof goals === "object" ? goals : {};
}

function getSelectedObjectiveKeys(initiatorTwin) {
  const keys = getPrechatGoalConfig(initiatorTwin).selectedObjectiveKeys;
  return Array.isArray(keys) ? keys.filter(Boolean) : [];
}

function isAutoModeEnabledForSession(session) {
  const initiatorTwin = getCurrentTwin(session.initiatorUserId);
  const goalConfig = getPrechatGoalConfig(initiatorTwin);
  const selectedMatchIds = Array.isArray(goalConfig.selectedMatchIds) ? goalConfig.selectedMatchIds : [];
  return selectedMatchIds.includes(session.matchId);
}

function buildObjectives(initiatorTwin, counterpartyTwin, facts = []) {
  const factKeys = new Set(facts.map((fact) => fact.key));
  const selectedKeys = getSelectedObjectiveKeys(initiatorTwin);
  const topicPool = selectedKeys.length
    ? TOPIC_CONFIG.filter((topic) => selectedKeys.includes(topic.key))
    : TOPIC_CONFIG;
  const objectives = [];

  for (const topic of topicPool) {
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

  if (objectives.length) {
    return objectives;
  }

  return selectedKeys.length ? [] : TOPIC_CONFIG.slice(0, MAX_OBJECTIVES);
}

function buildObjectiveProgress(objectives, facts = [], openQuestions = []) {
  const factKeys = new Set(facts.map((fact) => fact.key));
  const questionText = openQuestions.map((item) => normalizeText(item)).join(" ");

  return objectives.map((objective) => {
    if (factKeys.has(objective.key)) {
      return {
        key: objective.key,
        label: objective.label,
        status: "confirmed"
      };
    }

    if (questionText && (questionText.includes(objective.label) || questionText.includes(objective.key))) {
      return {
        key: objective.key,
        label: objective.label,
        status: "pending"
      };
    }

    return {
      key: objective.key,
      label: objective.label,
      status: "unresolved"
    };
  });
}

function allObjectivesConfirmed(objectiveProgress = []) {
  return objectiveProgress.length > 0 && objectiveProgress.every((item) => item.status === "confirmed");
}

function guardTurnResult(result) {
  const next = {
    ...result,
    needs_human_input: {
      required: Boolean(result.needs_human_input?.required),
      field: result.needs_human_input?.field || null,
      question: result.needs_human_input?.question || null,
      target_user_for_input: result.needs_human_input?.target_user_for_input || null
    }
  };

  if (next.needs_human_input.required) {
    next.needs_human_input.field = next.needs_human_input.field || "manual_review";
    next.needs_human_input.question =
      next.needs_human_input.question || "这一项信息需要由用户本人补充。";
    next.needs_human_input.target_user_for_input =
      next.needs_human_input.target_user_for_input || "self";
  }

  if (!next.needs_human_input.required && next.recommendation === "continue" && !normalizeText(next.reply)) {
    return { stopReason: "empty_reply_with_continue" };
  }

  if ((next.is_sensitive_question || next.needs_sensitive_approval) && !normalizeText(next.reply)) {
    return { stopReason: "invalid_sensitive_question" };
  }

  if ((next.is_sensitive_question || next.needs_sensitive_approval) && !normalizeText(next.sensitive_topic_category)) {
    return { stopReason: "invalid_sensitive_category" };
  }

  return { result: next };
}

function textLooksLikeQuestion(text) {
  const value = normalizeText(text);
  return /[?？]/u.test(value) || /(吗|呢|么|是否|是不是|有没有|能否|可否)$/u.test(value);
}

function normalizeComparableText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/我是.{0,12}?twin/giu, "")
    .replace(/你好/gu, "")
    .replace(/[\s,.!?，。！？、:：;；"'“”‘’（）()【】\[\]\-]/gu, "");
}

function isNearDuplicateText(left, right) {
  const a = normalizeComparableText(left);
  const b = normalizeComparableText(right);

  if (!a || !b) {
    return false;
  }

  if (a === b) {
    return true;
  }

  return a.length >= 12 && b.length >= 12 && (a.includes(b) || b.includes(a));
}

function inferTopicKeyFromText(text) {
  const value = normalizeText(text);

  if (!value) {
    return null;
  }

  if (/(城市|上海|杭州|北京|定居|生活)/u.test(value)) {
    return "cities";
  }

  if (/(结婚|几年|推进|婚期|时间)/u.test(value)) {
    return "marriageTimeline";
  }

  if (/(孩子|生育|备孕|丁克)/u.test(value)) {
    return "childrenPreference";
  }

  if (/(父母|同住|独立小家庭|家庭边界|住得近)/u.test(value)) {
    return "familyBoundary";
  }

  if (/(财务|负债|消费|收入|借钱|存款)/u.test(value)) {
    return "financialView";
  }

  if (/(关系目标|长期关系|结婚为目标|认真发展)/u.test(value)) {
    return "relationshipGoal";
  }

  return null;
}

function buildTopicAnswer(profile, topicKey) {
  const value = normalizeText(profile?.twinProfile?.[topicKey]);

  if (!topicKey || !value) {
    return null;
  }

  switch (topicKey) {
    case "cities":
      return `我这边长期更倾向在${value}生活。`;
    case "marriageTimeline":
      return `结婚节奏这边更偏向${value}。`;
    case "childrenPreference":
      return `关于孩子这件事，我这边是${value}。`;
    case "familyBoundary":
      return `家庭边界上，我这边更偏向${value}。`;
    case "financialView":
      return `财务观这边，我更认同${value}。`;
    case "relationshipGoal":
      return `关系目标上，我这边是${value}。`;
    default:
      return `这件事上，我这边是${value}。`;
  }
}

function buildObjectiveQuestion(objective) {
  if (!objective?.key) {
    return null;
  }

  switch (objective.key) {
    case "cities":
      return "你这边未来长期更倾向在哪个城市生活？";
    case "marriageTimeline":
      return "如果关系顺利推进，你更接受怎样的结婚节奏？";
    case "childrenPreference":
      return "你对未来要不要孩子这件事，目前更偏向什么想法？";
    case "familyBoundary":
      return "婚后和父母的相处边界上，你更偏向怎样的安排？";
    case "financialView":
      return "在消费、储蓄和负债这类现实安排上，你更看重什么原则？";
    case "relationshipGoal":
      return "你现在更明确想进入怎样的长期关系？";
    default:
      return normalizeText(objective.prompt) || null;
  }
}

function chooseNextObjective(objectives, excludedTopicKey, turns) {
  const recentContents = (turns || []).slice(-6).map((turn) => turn.content);

  for (const objective of objectives || []) {
    if (!objective?.key || objective.key === excludedTopicKey) {
      continue;
    }

    const question = buildObjectiveQuestion(objective);
    if (!question) {
      continue;
    }

    if (!recentContents.some((content) => isNearDuplicateText(content, question))) {
      return objective;
    }
  }

  return null;
}

function repairLoopingReply({ result, speaker, listener, objectives, turns }) {
  const latestTurn = turns.length ? turns[turns.length - 1] : null;
  const recentTurns = turns.slice(-6);
  const reply = normalizeText(result.reply);

  if (!reply) {
    return result;
  }

  const duplicatedLatest = latestTurn ? isNearDuplicateText(reply, latestTurn.content) : false;
  const duplicatedRecent = recentTurns.some((turn) => isNearDuplicateText(reply, turn.content));

  if (!duplicatedLatest && !duplicatedRecent) {
    return result;
  }

  const repeatedTopicKey =
    inferTopicKeyFromText(latestTurn?.content) || inferTopicKeyFromText(reply) || objectives?.[0]?.key || null;
  const answer = buildTopicAnswer(speaker, repeatedTopicKey);
  const nextObjective = chooseNextObjective(objectives, repeatedTopicKey, recentTurns);
  const nextQuestion = buildObjectiveQuestion(nextObjective);
  const replyParts = [];

  if (answer && latestTurn?.actorUserId === listener.userId) {
    replyParts.push(answer);
  }

  if (nextQuestion) {
    replyParts.push(nextQuestion);
  }

  if (!replyParts.length) {
    return {
      ...result,
      reply: "",
      open_questions: ["当前议题需要人工确认后再继续。"],
      needs_human_input: {
        required: true,
        field: repeatedTopicKey || "manual_review",
        question: "这轮预沟通出现重复问答，请本人确认这一题的真实答案。",
        target_user_for_input: "self"
      },
      recommendation: "pause_review",
      repair_note: "loop_detected_without_safe_rewrite"
    };
  }

  const confirmedFacts = [...(Array.isArray(result.confirmed_facts) ? result.confirmed_facts : [])];
  const speakerValue = normalizeText(speaker?.twinProfile?.[repeatedTopicKey]);

  if (
    answer &&
    repeatedTopicKey &&
    speakerValue &&
    !confirmedFacts.some(
      (fact) =>
        String(fact.key || "").trim() === repeatedTopicKey && String(fact.subjectUserId || "").toLowerCase() === "self"
    )
  ) {
    confirmedFacts.push({
      subjectUserId: "self",
      key: repeatedTopicKey,
      value: speakerValue,
      confidence: 0.92,
      status: "confirmed"
    });
  }

  return {
    ...result,
    reply: replyParts.join(" "),
    confirmed_facts: confirmedFacts,
    open_questions: nextQuestion ? [nextQuestion] : [],
    needs_human_input: {
      required: false,
      field: null,
      question: null,
      target_user_for_input: null
    },
    recommendation: nextQuestion ? "continue" : "pause_review",
    repair_note: "looping_reply_rewritten"
  };
}

function buildTurnContext({ session, round, speaker, listener, objectives, turns, facts }) {
  const latestTurn = turns.length ? turns[turns.length - 1] : null;
  const lastSpeakerTurn = [...turns].reverse().find((turn) => turn.actorUserId === speaker.userId) || null;
  const lastListenerTurn = [...turns].reverse().find((turn) => turn.actorUserId === listener.userId) || null;

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
    objective_progress: buildObjectiveProgress(objectives, facts),
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
    conversation_state: {
      conversation_started: turns.length > 0,
      latest_turn_from_listener: latestTurn?.actorUserId === listener.userId,
      latest_turn_is_question: textLooksLikeQuestion(latestTurn?.content),
      latest_turn_content: latestTurn?.content || null,
      last_speaker_message: lastSpeakerTurn?.content || null,
      last_listener_message: lastListenerTurn?.content || null
    },
    constraints: {
      max_messages_this_round: MAX_TURNS_PER_ROUND,
      if_sensitive_then_request_approval: true,
      if_missing_self_fact_then_needs_human_input: true,
      must_output_json: true
    }
  };
}

function buildStageContext({ session, round, turns, facts, stopReason }) {
  const objectives = Array.isArray(round.objective?.topics) ? round.objective.topics : [];
  return {
    session_id: session.id,
    round_number: round.roundNumber,
    stop_reason: stopReason,
    objectives: objectives.map((item) => ({
      key: item.key,
      label: item.label,
      prompt: item.prompt
    })),
    objective_progress: buildObjectiveProgress(objectives, facts),
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

function isAutoRecoverableManualReviewSession(detail, currentUserId) {
  const pendingRequests = (detail.humanInputRequests || []).filter((request) => request.status === "pending");

  if (detail.session.status !== "pending_human_input" || !pendingRequests.length) {
    return false;
  }

  if (!pendingRequests.every((request) => request.fieldKey === "manual_review" && request.targetUserId === currentUserId)) {
    return false;
  }

  const turns = detail.turns || [];

  return (
    turns.length > 0 &&
    turns.every(
      (turn) =>
        turn.actorUserId == null &&
        turn.metadata?.pauseReason === "pending_human_input" &&
        turn.metadata?.fieldKey === "manual_review"
    )
  );
}

async function autoRecoverManualReviewSession(sessionId, currentUserId) {
  const detail = getSessionDetailForUser(sessionId, currentUserId);

  if (!detail || !isAutoRecoverableManualReviewSession(detail, currentUserId)) {
    return false;
  }

  for (const request of detail.humanInputRequests.filter((item) => item.status === "pending")) {
    resolveHumanInputRequest(request.id, "[auto-resume]", {
      resolvedByUserId: currentUserId,
      autoResolved: true
    });
  }

  updatePrechatSession(sessionId, { status: "paused_review" });
  await runSessionRound(sessionId, currentUserId);
  return true;
}

async function autoStartEligibleSession(sessionId, currentUserId) {
  const detail = getSessionDetailForUser(sessionId, currentUserId);

  if (!detail) {
    return false;
  }

  if (!isAutoModeEnabledForSession(detail.session)) {
    return false;
  }

  if (!["active", "paused_review"].includes(detail.session.status)) {
    return false;
  }

  if ((detail.humanInputRequests || []).some((item) => item.status === "pending")) {
    return false;
  }

  if ((detail.sensitiveRequests || []).some((item) => item.status === "pending")) {
    return false;
  }

  const result = await runSessionRound(detail.session.id, detail.session.initiatorUserId);
  await autoAdvanceSessionIfNeeded(detail.session.id, detail.session.initiatorUserId, result);
  return true;
}

async function createRoundSummary(session, round, stopReason) {
  const turns = listConversationTurns(session.id).filter((turn) => turn.roundId === round.id);
  const facts = listExtractedFacts(session.id).filter((fact) => fact.roundId === round.id);
  const objectiveProgress = buildObjectiveProgress(
    Array.isArray(round.objective?.topics) ? round.objective.topics : [],
    facts
  );
  const payload = await summarizeStage(buildStageContext({ session, round, turns, facts, stopReason }));
  return createStageReport(session.id, round.id, {
    ...payload,
    objective_progress: objectiveProgress,
    all_objectives_confirmed: allObjectivesConfirmed(objectiveProgress)
  });
}

async function completeRound(session, round, status, stopReason) {
  finishPrechatRound(round.id, { status: "completed", stopReason });
  updatePrechatSession(session.id, { status });
  const stageReport = await createRoundSummary(session, round, stopReason);
  return { status, stageReport, stopReason };
}

async function autoAdvanceSessionIfNeeded(sessionId, actorUserId, result, depth = 0) {
  if (
    !result ||
    result.status !== "paused_review" ||
    !AUTO_CONTINUE_STOP_REASONS.has(result.stopReason) ||
    depth >= MAX_AUTO_ROUNDS
  ) {
    return result;
  }

  const session = getPrechatSessionById(sessionId);

  if (!session || !isAutoModeEnabledForSession(session)) {
    return result;
  }

  const nextResult = await runSessionRound(sessionId, actorUserId);
  return autoAdvanceSessionIfNeeded(sessionId, actorUserId, nextResult, depth + 1);
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

    const guard = guardTurnResult(result);

    if (!guard.result) {
      return completeRound(session, round, "paused_review", guard.stopReason);
    }

    const safeResult = repairLoopingReply({
      result: guard.result,
      speaker,
      listener,
      objectives,
      turns: turnsSoFar
    });

    if (safeResult.needs_sensitive_approval || safeResult.is_sensitive_question) {
      const targetUserId = resolveTargetUserId(
        safeResult.target_user_for_approval,
        speaker.userId,
        listener.userId
      );
      const targetTwin =
        targetUserId === participants.initiator.userId ? participants.initiator : participants.counterparty;

      if (!ensureSensitiveCategoryAllowed(targetTwin, safeResult.sensitive_topic_category)) {
        return completeRound(session, round, "paused_review", "sensitive_topic_not_authorized");
      }

      createSensitiveQuestionRequest({
        sessionId: session.id,
        roundId: round.id,
        requestingUserId: speaker.userId,
        targetUserId,
        questionText: safeResult.reply,
        topicCategory: safeResult.sensitive_topic_category || "unknown",
        metadata: { turnNumber: nextTurnNumber }
      });

      return completeRound(session, round, "pending_sensitive_approval", "pending_sensitive_approval");
    }

    if (safeResult.needs_human_input.required) {
      const targetUserId = resolveTargetUserId(
        safeResult.needs_human_input.target_user_for_input,
        speaker.userId,
        listener.userId
      );
      const targetParticipant =
        targetUserId === participants.initiator.userId ? participants.initiator : participants.counterparty;
      const fieldKey = safeResult.needs_human_input.field || "manual_review";
      const questionText = safeResult.needs_human_input.question || "请人工补充这一项信息。";

      createHumanInputRequest({
        sessionId: session.id,
        roundId: round.id,
        targetUserId,
        fieldKey,
        questionText,
        metadata: { turnNumber: nextTurnNumber }
      });

      addConversationTurn({
        sessionId: session.id,
        roundId: round.id,
        turnNumber: nextTurnNumber,
        actorUserId: null,
        actorRole: "system",
        content: buildPauseMessage(targetParticipant?.displayName || "对方", fieldKey, questionText),
        metadata: {
          pauseReason: "pending_human_input",
          targetUserId,
          fieldKey
        }
      });

      return completeRound(session, round, "pending_human_input", "pending_human_input");
    }

    const turn = addConversationTurn({
      sessionId: session.id,
      roundId: round.id,
      turnNumber: nextTurnNumber,
      actorUserId: speaker.userId,
      actorRole: `${participantRole(session, speaker.userId)}_twin`,
      content: safeResult.reply,
      metadata: safeResult
    });

    if (safeResult.confirmed_facts.length) {
      saveExtractedFacts(
        session.id,
        round.id,
        safeResult.confirmed_facts.map((fact) => ({
          ...fact,
          subjectUserId: resolveFactSubjectUserId(fact.subjectUserId, speaker.userId, listener.userId)
        })),
        turn.id
      );
    }

    if (isHighRisk(safeResult.risk_flags)) {
      return completeRound(session, round, "blocked_risk", "blocked_risk");
    }

    const progress = buildObjectiveProgress(objectives, listExtractedFacts(session.id));

    if (allObjectivesConfirmed(progress)) {
      return completeRound(session, round, "paused_review", "objectives_completed");
    }

    if (safeResult.recommendation === "handoff_ready") {
      return completeRound(session, round, "handoff_ready", "handoff_ready");
    }

    if (safeResult.recommendation === "pause_review") {
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
  rejectSiblingPendingInvitations(session.matchId, session.id);
  const acceptedSession = getPrechatSessionForUser(session.id, currentUserId);

  if (acceptedSession && isAutoModeEnabledForSession(acceptedSession)) {
    const firstResult = await runSessionRound(session.id, session.initiatorUserId);
    await autoAdvanceSessionIfNeeded(session.id, session.initiatorUserId, firstResult);
  }

  return getPrechatSessionForUser(session.id, currentUserId);
}

export async function rejectInvitation(sessionId, currentUserId) {
  const session = getPrechatSessionForUser(sessionId, currentUserId);

  if (!session || session.counterpartyUserId !== currentUserId) {
    throw new Error("未找到可拒绝的预沟通邀请。");
  }

  updatePrechatSession(session.id, { status: "rejected" });
  rejectSiblingPendingInvitations(session.matchId, session.id);
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

  if (["blocked_risk"].includes(session.status)) {
    throw new Error("当前会话已结束，无法继续。");
  }

  const topics = buildObjectives(
    getCurrentTwin(session.initiatorUserId),
    getCurrentTwin(session.counterpartyUserId),
    listExtractedFacts(session.id)
  );

  if (!topics.length) {
    updatePrechatSession(session.id, { status: "completed" });
    return { status: "completed", stopReason: "objectives_completed" };
  }

  const roundNumber = session.currentRound + 1;
  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber,
    objective: {
      topics
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

  const result = await executeConversationLoop({
    session,
    round,
    speakerUserId: currentUserId,
    startingTurnNumber: turnNumber + 1
  });
  return autoAdvanceSessionIfNeeded(session.id, session.initiatorUserId, result);
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

  const trimmedResponse = normalizeText(responseText);

  if (!trimmedResponse) {
    throw new Error("请先输入你希望发送的补充内容。");
  }

  resolveHumanInputRequest(requestId, trimmedResponse, { resolvedByUserId: currentUserId });

  const session = getPrechatSessionById(request.sessionId);
  const round = getPrechatRound(request.roundId);
  const baseTurnNumber = getLatestTurnNumber(round.id) + 1;

  addConversationTurn({
    sessionId: request.sessionId,
    roundId: request.roundId,
    turnNumber: baseTurnNumber,
    actorUserId: currentUserId,
    actorRole: `${participantRole(session, currentUserId)}_user`,
    content: trimmedResponse,
    metadata: {
      fromHumanInputRequestId: request.id,
      fieldKey: request.fieldKey,
      manualReview: request.fieldKey === "manual_review"
    }
  });

  const currentTwin = getCurrentTwin(currentUserId);
  const nextTwinProfile =
    request.fieldKey === "manual_review"
      ? { ...(currentTwin?.twinProfile || {}) }
      : {
          ...(currentTwin?.twinProfile || {}),
          [request.fieldKey]: trimmedResponse
        };

  if (!currentTwin?.twinProfile?.displayName) {
    nextTwinProfile.displayName = currentTwin?.displayName || "未命名用户";
  }

  saveCurrentTwin(currentUserId, nextTwinProfile);
  addConversationTurn({
    sessionId: request.sessionId,
    roundId: request.roundId,
    turnNumber: baseTurnNumber + 1,
    actorUserId: null,
    actorRole: "system",
    content: "系统已收到用户本人补充，这条会话现在可以继续下一轮预沟通。",
    metadata: {
      pauseResolved: true,
      requestId: request.id
    }
  });
  updatePrechatSession(request.sessionId, { status: "active" });
  const sessionView = getPrechatSessionForUser(request.sessionId, currentUserId);

  if (sessionView && isAutoModeEnabledForSession(sessionView)) {
    await autoAdvanceSessionIfNeeded(sessionView.id, sessionView.initiatorUserId, {
      status: "paused_review"
    });
  }

  return getPrechatSessionForUser(request.sessionId, currentUserId);
}

export async function sendManualMessage(sessionId, currentUserId, content) {
  const session = getPrechatSessionForUser(sessionId, currentUserId);

  if (!session) {
    throw new Error("未找到该预沟通会话。");
  }

  if (["awaiting_counterparty_acceptance", "pending_sensitive_approval"].includes(session.status)) {
    throw new Error("当前状态下不能直接发送真人消息。");
  }

  if (["blocked_risk", "rejected"].includes(session.status)) {
    throw new Error("当前会话已结束，无法继续发送消息。");
  }

  const trimmedContent = normalizeText(content);

  if (!trimmedContent) {
    throw new Error("请先输入要发送的内容。");
  }

  let round = null;
  const rounds = listPrechatRounds(session.id);

  if (session.status === "completed") {
    const roundNumber = session.currentRound + 1;
    round = createPrechatRound({
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
  } else if (rounds.length) {
    round = rounds[rounds.length - 1];
  } else {
    const roundNumber = 1;
    round = createPrechatRound({
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
  }

  const turnNumber = getLatestTurnNumber(round.id) + 1;
  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber,
    actorUserId: currentUserId,
    actorRole: `${participantRole(session, currentUserId)}_user`,
    content: trimmedContent,
    metadata: {
      manualMessage: true
    }
  });

  if (["paused_review", "handoff_ready", "completed"].includes(session.status)) {
    updatePrechatSession(session.id, { status: "active" });
  }

  return getPrechatSessionForUser(session.id, currentUserId);
}

export function getSessionView(sessionId, currentUserId) {
  const detail = getSessionDetailForUser(sessionId, currentUserId);

  if (!detail) {
    return null;
  }

  return toSessionResponse(detail, currentUserId);
}

export async function getSessionViewWithAutoRecovery(sessionId, currentUserId) {
  await autoRecoverManualReviewSession(sessionId, currentUserId);

  for (let attempt = 0; attempt < MAX_AUTO_ROUNDS; attempt += 1) {
    const advanced = await autoStartEligibleSession(sessionId, currentUserId);
    const detail = getSessionView(sessionId, currentUserId);

    if (!advanced || !detail || detail.session.status !== "active") {
      if (
        detail &&
        detail.session.status === "active" &&
        isAutoModeEnabledForSession(detail.session) &&
        !(detail.humanInputRequests || []).some((item) => item.status === "pending") &&
        !(detail.sensitiveRequests || []).some((item) => item.status === "pending")
      ) {
        const remainingTopics = buildObjectives(
          getCurrentTwin(detail.session.initiatorUserId),
          getCurrentTwin(detail.session.counterpartyUserId),
          listExtractedFacts(detail.session.id)
        );

        if (!remainingTopics.length) {
          updatePrechatSession(detail.session.id, { status: "completed" });
          return getSessionView(detail.session.id, currentUserId);
        }
      }

      return detail;
    }
  }

  return getSessionView(sessionId, currentUserId);
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
