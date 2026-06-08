import {
  addConversationTurn,
  createHumanInputRequest,
  createPrechatRound,
  createSensitiveQuestionRequest,
  createStageReport,
  finishPrechatRound,
  getConversationTurnById,
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
  listStageReports,
  resolveHumanInputRequest,
  rejectSiblingPendingInvitations,
  saveCurrentTwin,
  saveExtractedFacts,
  updateConversationTurn,
  updatePrechatRoundObjective,
  updateStageReport,
  updatePrechatSession,
  updateSensitiveQuestionRequest
} from "./database.js";
import {
  classifyManualQuestion,
  generatePrechatTurn,
  summarizeStage,
  TURN_PROMPT_VERSION,
  MANUAL_QUESTION_PROMPT_VERSION
} from "./llmAdapter.js";
import { writeLlmTelemetry } from "./llmTelemetry.js";
import { SENSITIVE_TOPIC_CATEGORIES } from "./constants.js";

const MAX_TURNS_PER_ROUND = 30;
const MAX_NO_PROGRESS_TURNS = 3;
const MAX_OBJECTIVES = 3;
const MAX_AUTO_ROUNDS = 12;
const MAX_AUTO_START_RETRIES = 1;
const MESSAGE_RECALL_WINDOW_MS = 2 * 60 * 1000;
const MESSAGE_REACTION_OPTIONS = ["👍", "❤️", "😂", "😮", "😢", "👀"];
const HIGH_RISK_TYPES = new Set(["money_request", "coercion", "harassment", "identity_conflict"]);
const AUTO_CONTINUE_STOP_REASONS = new Set(["outstanding_twin_question_unanswered"]);
const AUTOMATION_BLOCKING_STATUSES = new Set([
  "awaiting_counterparty_acceptance",
  "rejected",
  "blocked_risk",
  "pending_human_input",
  "pending_sensitive_approval"
]);
const automationLocks = new Map();
const automationQueues = new Map();
const deferredAutomationRetryTimers = new Map();

const AUTOMATION_RUN_STATES = new Set(["idle", "queued", "running", "failed"]);
const DEFERRED_RETRY_KINDS = new Set(["model_output_unstable"]);
const TOPIC_LEDGER_STATES = new Set([
  "not_started",
  "waiting_initiator",
  "waiting_counterparty",
  "closed",
  "reopened_by_human"
]);
const REVIEW_INBOX_KINDS = new Set(["objectives_completed", "pause_notice"]);
const SENSITIVE_APPROVAL_STATES = new Set(["not_requested", "pending", "approved", "rejected", "skipped"]);
const SENSITIVE_TOPIC_TO_OBJECTIVE_KEY = {
  finance_and_debt: "financialView",
  family_boundaries: "familyBoundary",
  marriage_and_housing_logistics: "marriageTimeline",
  fertility_and_children: "childrenPreference",
  physical_and_mental_health: null,
  relationship_history: null,
  lifestyle_and_risk_habits: null
};

function getSensitiveTopicLabel(topicCategory) {
  const normalizedTopicCategory = normalizeText(topicCategory);
  return (
    SENSITIVE_TOPIC_CATEGORIES.find((item) => item.key === normalizedTopicCategory)?.label ||
    normalizedTopicCategory ||
    "敏感议题"
  );
}

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

function nowIso() {
  return new Date().toISOString();
}

function getDeferredRetryMaxAttempts() {
  return Math.max(1, Number(process.env.PRECHAT_DEFERRED_RETRY_MAX_ATTEMPTS || 3));
}

function getDeferredRetryDelaysMs() {
  const values = String(process.env.PRECHAT_DEFERRED_RETRY_DELAYS_MS || "10000,20000,30000")
    .split(",")
    .map((item) => Math.max(0, Number(item) || 0))
    .filter((item) => Number.isFinite(item));
  return values.length ? values : [10_000, 20_000, 30_000];
}

function getDeferredRetryTotalWindowMs() {
  return Math.max(1000, Number(process.env.PRECHAT_DEFERRED_RETRY_TOTAL_WINDOW_MS || 60_000));
}

function getOpeningDeferredRetryTotalWindowMs() {
  return Math.max(1000, Number(process.env.PRECHAT_OPENING_DEFERRED_RETRY_TOTAL_WINDOW_MS || 180_000));
}

function getOpeningDeferredRetryDelaysMs() {
  const values = String(process.env.PRECHAT_OPENING_DEFERRED_RETRY_DELAYS_MS || "10000,20000,30000")
    .split(",")
    .map((item) => Math.max(0, Number(item) || 0))
    .filter((item) => Number.isFinite(item));
  return values.length ? values : [10_000, 20_000, 30_000];
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeTopicKey(value) {
  const key = normalizeText(value);
  return TOPIC_CONFIG.some((topic) => topic.key === key) ? key : null;
}

function normalizeTopicCoverage(coverage = {}) {
  return {
    initiator: Boolean(coverage?.initiator),
    counterparty: Boolean(coverage?.counterparty)
  };
}

function normalizeTopicLedgerEntry(topicKey, entry = {}) {
  const normalizedTopicKey = normalizeTopicKey(topicKey);
  if (!normalizedTopicKey) {
    return null;
  }

  const state = TOPIC_LEDGER_STATES.has(normalizeText(entry.state))
    ? normalizeText(entry.state)
    : "not_started";

  return {
    state,
    coverage: normalizeTopicCoverage(entry.coverage),
    pendingAnswerUserId: normalizeText(entry.pendingAnswerUserId) || null,
    lastQuestionTurnId: normalizeText(entry.lastQuestionTurnId) || null,
    lastQuestionFingerprint: normalizeText(entry.lastQuestionFingerprint) || null,
    lastQuestionAskedByUserId: normalizeText(entry.lastQuestionAskedByUserId) || null,
    lastAnsweredByUserId: normalizeText(entry.lastAnsweredByUserId) || null,
    lastResolvedTurnId: normalizeText(entry.lastResolvedTurnId) || null,
    closedAt: normalizeText(entry.closedAt) || null,
    reopenReason: normalizeText(entry.reopenReason) || null,
    reopenedAt: normalizeText(entry.reopenedAt) || null
  };
}

function normalizeTopicLedger(ledger = {}) {
  const next = {};

  for (const topic of TOPIC_CONFIG) {
    const entry = normalizeTopicLedgerEntry(topic.key, ledger?.[topic.key]);
    if (entry) {
      next[topic.key] = entry;
    }
  }

  return next;
}

function normalizeReviewInboxEntry(entry = {}) {
  return {
    roundId: normalizeText(entry.roundId) || null,
    roundNumber: Number.isFinite(Number(entry.roundNumber)) ? Math.max(0, Number(entry.roundNumber)) : 0,
    emittedAt: normalizeText(entry.emittedAt) || null,
    seenByRole: {
      initiator: normalizeText(entry?.seenByRole?.initiator) || null,
      counterparty: normalizeText(entry?.seenByRole?.counterparty) || null
    }
  };
}

function normalizeReviewInbox(reviewInbox = {}) {
  const objectivesCompleted = reviewInbox?.objectivesCompleted;
  const pauseNotice = reviewInbox?.pauseNotice;
  return {
    objectivesCompleted:
      objectivesCompleted && typeof objectivesCompleted === "object"
        ? normalizeReviewInboxEntry(objectivesCompleted)
        : null,
    pauseNotice:
      pauseNotice && typeof pauseNotice === "object"
        ? {
            ...normalizeReviewInboxEntry(pauseNotice),
            stopReason: normalizeText(pauseNotice.stopReason) || null,
            pauseKind: normalizeText(pauseNotice.pauseKind) || null
          }
        : null
  };
}

function normalizeSensitiveApprovalLedgerEntry(topicCategory, entry = {}) {
  const normalizedTopicCategory = normalizeText(topicCategory);
  if (!normalizedTopicCategory) {
    return null;
  }

  const state = SENSITIVE_APPROVAL_STATES.has(normalizeText(entry.state))
    ? normalizeText(entry.state)
    : "not_requested";

  return {
    topicCategory: normalizedTopicCategory,
    state,
    requestId: normalizeText(entry.requestId) || null,
    requestedAt: normalizeText(entry.requestedAt) || null,
    resolvedAt: normalizeText(entry.resolvedAt) || null,
    requestedByUserId: normalizeText(entry.requestedByUserId) || null,
    targetUserId: normalizeText(entry.targetUserId) || null,
    lastPromptText: normalizeText(entry.lastPromptText) || null,
    resolutionSource: normalizeText(entry.resolutionSource) || null,
    promptIntent: normalizeText(entry.promptIntent) || null,
    skippedReason: normalizeText(entry.skippedReason) || null
  };
}

function normalizeDeferredRetryState(state = {}) {
  if (!state || typeof state !== "object") {
    return null;
  }

  const kind = DEFERRED_RETRY_KINDS.has(normalizeText(state.kind)) ? normalizeText(state.kind) : null;
  if (!kind) {
    return null;
  }

  const maxAttempts = Math.max(
    1,
    Number.isFinite(Number(state.maxAttempts)) ? Number(state.maxAttempts) : getDeferredRetryMaxAttempts()
  );

  return {
    kind,
    reason: normalizeText(state.reason) || kind,
    profile: normalizeText(state.profile) || "default",
    attemptCount: Math.max(0, Number.isFinite(Number(state.attemptCount)) ? Number(state.attemptCount) : 0),
    maxAttempts,
    allowExhaustion: state.allowExhaustion !== false,
    windowMs: Math.max(
      1000,
      Number.isFinite(Number(state.windowMs))
        ? Number(state.windowMs)
        : getDeferredRetryTotalWindowMs()
    ),
    firstFailedAt: normalizeText(state.firstFailedAt) || null,
    nextRetryAt: normalizeText(state.nextRetryAt) || null,
    lastRetryAt: normalizeText(state.lastRetryAt) || null,
    sourceRoundId: normalizeText(state.sourceRoundId) || null,
    sourceTurnNumber: Number.isFinite(Number(state.sourceTurnNumber)) ? Math.max(0, Number(state.sourceTurnNumber)) : 0,
    sourceTrigger: normalizeText(state.sourceTrigger) || null,
    sourceIntent: normalizeText(state.sourceIntent) || null
  };
}

function normalizeSensitiveApprovalLedger(ledger = {}) {
  const next = {};
  for (const topicCategory of Object.keys(SENSITIVE_TOPIC_TO_OBJECTIVE_KEY)) {
    const entry = normalizeSensitiveApprovalLedgerEntry(topicCategory, ledger?.[topicCategory]);
    if (entry) {
      next[topicCategory] = entry;
    }
  }
  return next;
}

function getSensitiveApprovalEntry(session, topicCategory) {
  const normalizedTopicCategory = normalizeText(topicCategory);
  if (!normalizedTopicCategory) {
    return null;
  }

  const ledger = getSessionControl(session).sensitiveApprovalLedger;
  return ledger?.[normalizedTopicCategory] || normalizeSensitiveApprovalLedgerEntry(normalizedTopicCategory, {});
}

function buildSensitiveApprovalLedgerPatch(session, topicCategory, patch = {}) {
  const normalizedTopicCategory = normalizeText(topicCategory);
  if (!normalizedTopicCategory) {
    return getSessionControl(session).sensitiveApprovalLedger;
  }

  const currentEntry = getSensitiveApprovalEntry(session, normalizedTopicCategory);
  return {
    ...getSessionControl(session).sensitiveApprovalLedger,
    [normalizedTopicCategory]: normalizeSensitiveApprovalLedgerEntry(normalizedTopicCategory, {
      ...currentEntry,
      ...patch
    })
  };
}

function getSensitiveObjectiveKey(topicCategory) {
  return SENSITIVE_TOPIC_TO_OBJECTIVE_KEY[normalizeText(topicCategory)] || null;
}

function isSensitiveObjectiveBlocked(session, objectiveKey) {
  const normalizedObjectiveKey = normalizeTopicKey(objectiveKey);
  if (!normalizedObjectiveKey) {
    return false;
  }

  return Object.entries(getSessionControl(session).sensitiveApprovalLedger || {}).some(([topicCategory, entry]) => {
    const sensitiveObjectiveKey = getSensitiveObjectiveKey(topicCategory);
    return (
      sensitiveObjectiveKey === normalizedObjectiveKey &&
      ["rejected", "skipped"].includes(normalizeText(entry?.state))
    );
  });
}

function buildSensitiveApprovalSummaryText(topicCategory, promptText, promptIntent = null) {
  const label = getSensitiveTopicLabel(topicCategory);
  const intent = normalizeText(promptIntent);
  const prompt = normalizeText(promptText);

  if (intent === "manual_question") {
    return `对方想进入“${label}”这一敏感议题，需先由你授权。`;
  }

  if (intent === "carryover_twin_question") {
    return `系统准备继续确认“${label}”这一敏感议题，需先由你授权。`;
  }

  if (prompt) {
    return `系统准备进入“${label}”这一敏感议题，需先由你授权。`;
  }

  return `系统准备确认“${label}”这一敏感议题，需先由你授权。`;
}

function isSensitiveApprovalCandidate(result) {
  return Boolean(
    result &&
      (result.needs_sensitive_approval ||
        result.is_sensitive_question ||
        normalizeText(result.sensitive_topic_category))
  );
}

function hydrateSensitiveApprovalLedgerFromRequests(session, requests = []) {
  const currentLedger = getSessionControl(session).sensitiveApprovalLedger;
  let nextLedger = { ...currentLedger };
  let changed = false;

  for (const request of requests) {
    const topicCategory = normalizeText(request?.topicCategory);
    if (!topicCategory) {
      continue;
    }

    const currentEntry = nextLedger[topicCategory];
    if (currentEntry && normalizeText(currentEntry.requestId)) {
      continue;
    }

    nextLedger[topicCategory] = normalizeSensitiveApprovalLedgerEntry(topicCategory, {
      state:
        normalizeText(request?.status) === "approved"
          ? "approved"
          : normalizeText(request?.status) === "rejected"
            ? "rejected"
            : normalizeText(request?.status) === "pending"
              ? "pending"
              : "not_requested",
      requestId: request?.id || null,
      requestedAt: request?.createdAt || null,
      resolvedAt: request?.resolvedAt || null,
      requestedByUserId: request?.requestingUserId || null,
      targetUserId: request?.targetUserId || null,
      lastPromptText: request?.metadata?.lastPromptText || request?.questionText || null,
      resolutionSource: request?.metadata?.resolutionSource || null,
      promptIntent: request?.metadata?.promptIntent || null,
      skippedReason: null
    });
    changed = true;
  }

  if (changed) {
    updatePrechatSession(session.id, {
      control: buildSessionControlPatch(session, {
        sensitiveApprovalLedger: nextLedger
      })
    });
  }

  return getPrechatSessionById(session.id) || session;
}

function getReviewInboxRole(session, userId) {
  return participantRole(session, userId) === "initiator" ? "initiator" : "counterparty";
}

function buildObjectivesCompletedReviewInboxEntry(round, emittedAt = null) {
  return normalizeReviewInboxEntry({
    roundId: round?.id,
    roundNumber: round?.roundNumber,
    emittedAt: emittedAt || nowIso(),
    seenByRole: {
      initiator: null,
      counterparty: null
    }
  });
}

function buildPauseNoticeReviewInboxEntry(round, pauseKind, stopReason, emittedAt = null) {
  return {
    ...buildObjectivesCompletedReviewInboxEntry(round, emittedAt),
    stopReason: normalizeText(stopReason) || null,
    pauseKind: normalizeText(pauseKind) || null
  };
}

function getPauseKindForRoundState(session, round) {
  const stopReason = normalizeText(round?.stopReason);

  if (stopReason === "outstanding_twin_question_unanswered") {
    return "outstanding_twin_question";
  }

  if (stopReason === "max_turns_reached") {
    return "max_turns_reached";
  }

  if (stopReason === "paused_review") {
    return session?.status === "active" ? "automation_stuck_active_round_paused" : "generic_paused_review";
  }

  return null;
}

function shouldExposePauseNoticeReviewInbox(session, round, currentUserId) {
  if (!session || !round) {
    return false;
  }

  const stopReason = normalizeText(round.stopReason);
  if (!["outstanding_twin_question_unanswered", "paused_review", "max_turns_reached"].includes(stopReason)) {
    return false;
  }

  const reviewInbox = getSessionControl(session).reviewInbox;
  const entry = reviewInbox.pauseNotice;

  if (!entry || entry.roundId !== round.id || entry.roundNumber !== round.roundNumber) {
    return true;
  }

  const role = getReviewInboxRole(session, currentUserId);
  return !entry.seenByRole?.[role];
}

function buildPauseNoticeReviewInboxPatch(session, round, emittedAt = null) {
  return buildSessionControlPatch(session, {
    reviewInbox: {
      pauseNotice: buildPauseNoticeReviewInboxEntry(
        round,
        getPauseKindForRoundState(session, round),
        round?.stopReason,
        emittedAt
      )
    }
  });
}

function shouldExposeObjectivesCompletedReviewInbox(session, round, currentUserId) {
  if (!session || !round || session.status !== "paused_review" || round.stopReason !== "objectives_completed") {
    return false;
  }

  const reviewInbox = getSessionControl(session).reviewInbox;
  const entry = reviewInbox.objectivesCompleted;

  if (!entry || entry.roundId !== round.id || entry.roundNumber !== round.roundNumber) {
    return true;
  }

  const role = getReviewInboxRole(session, currentUserId);
  return !entry.seenByRole?.[role];
}

function buildObjectivesCompletedReviewInboxPatch(session, round, emittedAt = null) {
  return buildSessionControlPatch(session, {
    reviewInbox: {
      objectivesCompleted: buildObjectivesCompletedReviewInboxEntry(round, emittedAt)
    }
  });
}

function normalizeMessageMetadata(metadata = {}) {
  const reactions = Array.isArray(metadata.reactions)
    ? metadata.reactions
        .map((item) => ({
          userId: normalizeText(item?.userId),
          emoji: normalizeText(item?.emoji)
        }))
        .filter((item) => item.userId && MESSAGE_REACTION_OPTIONS.includes(item.emoji))
    : [];

  return {
    ...metadata,
    clientMessageId: normalizeText(metadata.clientMessageId) || null,
    quotedTurnId: normalizeText(metadata.quotedTurnId) || null,
    quotedPreview:
      metadata.quotedPreview && typeof metadata.quotedPreview === "object"
        ? {
            turnId: normalizeText(metadata.quotedPreview.turnId) || null,
            actorLabel: normalizeText(metadata.quotedPreview.actorLabel) || "",
            content: normalizeText(metadata.quotedPreview.content) || "",
            isRecalled: Boolean(metadata.quotedPreview.isRecalled)
          }
        : null,
    reactions,
    edited: Boolean(metadata.edited),
    editedAt: normalizeText(metadata.editedAt) || null,
    recalled: Boolean(metadata.recalled),
    recalledAt: normalizeText(metadata.recalledAt) || null,
    recalledByUserId: normalizeText(metadata.recalledByUserId) || null,
    deletedForUserIds: Array.isArray(metadata.deletedForUserIds)
      ? [...new Set(metadata.deletedForUserIds.map((item) => normalizeText(item)).filter(Boolean))]
      : []
  };
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTwinIntroPatterns(displayName) {
  const safeDisplayName = escapeRegex(normalizeText(displayName));
  const generic = [
    /^你好，我是[^。！？!?]{0,24}?的\s*Twin[。！？!?]*/u,
    /^我是[^。！？!?]{0,24}?的\s*Twin[。！？!?]*/u,
    /^这里是[^。！？!?]{0,24}?的\s*Twin[。！？!?]*/u
  ];

  if (!safeDisplayName) {
    return generic;
  }

  return [
    new RegExp(`^你好，我是\\s*${safeDisplayName}\\s*的\\s*Twin[。！？!?]*`, "u"),
    new RegExp(`^我是\\s*${safeDisplayName}\\s*的\\s*Twin[。！？!?]*`, "u"),
    new RegExp(`^这里是\\s*${safeDisplayName}\\s*的\\s*Twin[。！？!?]*`, "u"),
    ...generic
  ];
}

function detectForbiddenTwinIntro(reply, displayName) {
  const normalized = normalizeText(reply);
  if (!normalized) {
    return false;
  }

  return buildTwinIntroPatterns(displayName).some((pattern) => pattern.test(normalized));
}

function stripForbiddenTwinIntro(reply, displayName) {
  let normalized = normalizeText(reply);
  if (!normalized) {
    return "";
  }

  for (const pattern of buildTwinIntroPatterns(displayName)) {
    normalized = normalized.replace(pattern, "").trim();
  }

  return normalized.replace(/^[，。、；：:\- ]+/u, "").trim();
}

function buildRequiredTwinIntro(displayName) {
  const normalizedName = normalizeText(displayName);
  if (!normalizedName) {
    return "你好，我是你的 Twin。";
  }

  return `你好，我是${normalizedName}的 Twin。`;
}

function injectRequiredTwinIntro(reply, displayName) {
  const normalizedReply = normalizeText(reply);
  const intro = buildRequiredTwinIntro(displayName);

  if (!normalizedReply) {
    return intro;
  }

  if (detectForbiddenTwinIntro(normalizedReply, displayName)) {
    return normalizedReply;
  }

  return `${intro}${normalizedReply}`;
}

function sanitizeTwinReplyIdentityIntro(result, context = {}, source = "raw_model_output") {
  if (!result || typeof result !== "object") {
    return result;
  }

  const metadata = result && typeof result === "object" ? result : {};
  const isFirstTwinMessage = Boolean(context.isFirstTwinMessage);
  const speakerDisplayName = normalizeText(context.speakerDisplayName);
  const reply = normalizeText(result.reply);
  const introDetected = !isFirstTwinMessage && detectForbiddenTwinIntro(reply, speakerDisplayName);

  const nextMetadata = {
    is_first_twin_message: isFirstTwinMessage,
    forbidden_intro_detected: introDetected,
    intro_source: introDetected ? source : metadata.intro_source || null,
    intro_sanitized: false,
    intro_sanitization_result: introDetected ? "detected" : "not_detected"
  };

  if (!introDetected) {
    return {
      ...result,
      ...nextMetadata
    };
  }

  const strippedReply = stripForbiddenTwinIntro(reply, speakerDisplayName);
  const sanitized = Boolean(strippedReply);

  if (introDetected) {
    writeLlmTelemetry(
      buildQualityTelemetryPayload({
        request_type: "turn_intro_guard",
        reply_quality_issue: "forbidden_repeated_twin_intro",
        rewrite_applied: sanitized,
        rewrite_reason: source,
        rewrite_failed: !sanitized,
        forbidden_intro_detected: true,
        intro_source: source,
        intro_sanitized: sanitized,
        intro_sanitization_result: sanitized ? "stripped" : "empty_after_strip"
      })
    );
  }

  return {
    ...result,
    reply: strippedReply,
    forbidden_intro_detected: true,
    intro_source: source,
    intro_sanitized: sanitized,
    intro_sanitization_result: sanitized ? "stripped" : "empty_after_strip",
    is_first_twin_message: isFirstTwinMessage
  };
}

function sanitizeTwinTurnForDisplay(turn, session) {
  if (!turn || !String(turn.actorRole || "").endsWith("_twin")) {
    return turn;
  }

  const priorTwinTurnExists = listConversationTurns(session.id)
    .filter((candidate) => candidate.id !== turn.id)
    .some(
      (candidate) =>
        String(candidate.actorRole || "").endsWith("_twin") &&
        (new Date(candidate.createdAt).getTime() < new Date(turn.createdAt).getTime() ||
          (candidate.createdAt === turn.createdAt && Number(candidate.turnNumber || 0) < Number(turn.turnNumber || 0)))
    );

  if (!priorTwinTurnExists) {
    return turn;
  }

  const participants = getSessionParticipantProfiles(session);
  const speakerDisplayName =
    turn.actorUserId === session.initiatorUserId ? participants.initiator?.displayName : participants.counterparty?.displayName;
  const sanitized = sanitizeTwinReplyIdentityIntro(
    { reply: turn.content, ...(turn.metadata || {}) },
    {
      isFirstTwinMessage: false,
      speakerDisplayName
    },
    "display_sanitization"
  );

  if (normalizeText(sanitized.reply) === normalizeText(turn.content)) {
    return turn;
  }

  return {
    ...turn,
    content: sanitized.reply,
    metadata: normalizeMessageMetadata({
      ...(turn.metadata || {}),
      forbidden_intro_detected: Boolean(sanitized.forbidden_intro_detected),
      intro_source: sanitized.intro_source || "display_sanitization",
      intro_sanitized: Boolean(sanitized.intro_sanitized),
      intro_sanitization_result: sanitized.intro_sanitization_result || "stripped"
    })
  };
}

function shouldTreatLeadingAnswerSegmentAsSubstantive(answerText, context = {}) {
  const normalizedAnswerText = normalizeText(answerText);
  if (!normalizedAnswerText) {
    return false;
  }

  const strippedIntroOnly = stripForbiddenTwinIntro(
    normalizedAnswerText,
    normalizeText(context.speakerDisplayName)
  );
  if (!normalizeText(strippedIntroOnly)) {
    return false;
  }

  return true;
}

function getTwinTurnCanonicalQuestionText(turn) {
  const metadata = normalizeMessageMetadata(turn?.metadata || {});
  return normalizeText(
    metadata.canonical_question_text ||
      metadata.emitted_question_text ||
      extractTrailingQuestionText(turn?.content) ||
      ""
  );
}

function getTwinTurnCanonicalQuestionTopic(turn) {
  const metadata = normalizeMessageMetadata(turn?.metadata || {});
  return (
    normalizeTopicKey(metadata.canonical_question_topic_key) ||
    normalizeTopicKey(metadata.emitted_question_topic_key) ||
    normalizeTopicKey(metadata.question_topic_key) ||
    inferQuestionTopicFromQuestionText(getTwinTurnCanonicalQuestionText(turn))
  );
}

function isEquivalentTwinQuestionTurn(left, right) {
  if (!left || !right) {
    return false;
  }

  const leftQuestionText = getTwinTurnCanonicalQuestionText(left);
  const rightQuestionText = getTwinTurnCanonicalQuestionText(right);
  const leftQuestionTopic = getTwinTurnCanonicalQuestionTopic(left);
  const rightQuestionTopic = getTwinTurnCanonicalQuestionTopic(right);
  const leftFingerprint = getCanonicalQuestionFingerprintFromMetadata(left.metadata || {}, left.content);
  const rightFingerprint = getCanonicalQuestionFingerprintFromMetadata(right.metadata || {}, right.content);

  if (!leftQuestionText || !rightQuestionText) {
    return false;
  }

  if (normalizeText(left.content) === normalizeText(right.content)) {
    return true;
  }

  if (leftFingerprint && rightFingerprint && leftFingerprint === rightFingerprint) {
    return true;
  }

  return isNearDuplicateText(leftQuestionText, rightQuestionText);
}

function hasCanonicalQuestionFingerprintDrift(metadata = {}, fallbackContent = "") {
  const normalizedMetadata = normalizeMessageMetadata(metadata || {});
  const storedQuestionFingerprint = normalizeText(normalizedMetadata.question_fingerprint);
  const expectedQuestionFingerprint = getCanonicalQuestionFingerprintFromMetadata(normalizedMetadata, fallbackContent);

  if (storedQuestionFingerprint && !expectedQuestionFingerprint) {
    return true;
  }

  if (storedQuestionFingerprint && expectedQuestionFingerprint && storedQuestionFingerprint !== expectedQuestionFingerprint) {
    return true;
  }

  return false;
}

function hasCanonicalQuestionTruthMismatch(metadata = {}, fallbackContent = "") {
  const normalizedMetadata = normalizeMessageMetadata(metadata || {});
  const canonicalQuestionText = normalizeText(
    normalizedMetadata.canonical_question_text ||
      normalizedMetadata.emitted_question_text ||
      extractTrailingQuestionText(fallbackContent)
  );
  const canonicalQuestionTopicKey =
    normalizeTopicKey(normalizedMetadata.canonical_question_topic_key) ||
    normalizeTopicKey(normalizedMetadata.emitted_question_topic_key) ||
    normalizeTopicKey(normalizedMetadata.question_topic_key) ||
    inferQuestionTopicFromQuestionText(canonicalQuestionText);

  if (!canonicalQuestionText) {
    return Boolean(
      normalizeTopicKey(normalizedMetadata.canonical_question_topic_key) ||
        normalizeTopicKey(normalizedMetadata.emitted_question_topic_key) ||
        normalizeTopicKey(normalizedMetadata.question_topic_key) ||
        normalizeText(normalizedMetadata.question_fingerprint) ||
        (Array.isArray(normalizedMetadata.open_questions) && normalizedMetadata.open_questions.some((item) => normalizeText(item)))
    );
  }

  if (!canonicalQuestionTopicKey) {
    return true;
  }

  return hasCanonicalQuestionFingerprintDrift(normalizedMetadata, fallbackContent);
}

function shouldRuntimeRebuildHistoricalTwinTurn(metadata = {}, fallbackContent = "") {
  const normalizedMetadata = normalizeMessageMetadata(metadata || {});
  const alignmentIssues = getAlignmentIssueList(normalizedMetadata);

  if (
    alignmentIssues.some((issue) =>
      [
        "question_topic_mismatch",
        "reply_topic_mismatch",
        "stale_question_topic",
        "confirmed_facts_mismatch"
      ].includes(issue)
    )
  ) {
    return true;
  }

  if (hasCanonicalQuestionTruthMismatch(normalizedMetadata, fallbackContent)) {
    return true;
  }

  const repeatSource = normalizeText(normalizedMetadata.repeat_source);
  const repairNote = normalizeText(normalizedMetadata.repair_note);
  if (
    ["same_topic_broad_question_repeat", "close_after_current_result"].includes(repeatSource) ||
    repairNote === "closed_topic_guard_rewritten"
  ) {
    const canonicalQuestionText = normalizeText(normalizedMetadata.canonical_question_text);
    const canonicalQuestionTopicKey = normalizeTopicKey(normalizedMetadata.canonical_question_topic_key);
    if (!canonicalQuestionText && (canonicalQuestionTopicKey || normalizeText(normalizedMetadata.question_fingerprint))) {
      return true;
    }
  }

  return false;
}

function collapseAdjacentDuplicateTwinTurns(turns = []) {
  const collapsed = [];

  for (const turn of turns || []) {
    const latest = collapsed.length ? collapsed[collapsed.length - 1] : null;
    if (
      latest &&
      String(latest?.actorRole || "").endsWith("_twin") &&
      String(turn?.actorRole || "").endsWith("_twin") &&
      latest.actorUserId &&
      latest.actorUserId === turn?.actorUserId &&
      normalizeText(latest.content) === normalizeText(turn?.content)
    ) {
      continue;
    }

    collapsed.push(turn);
  }

  return collapsed;
}

function findLatestEquivalentTwinTurn(sessionId, candidate = {}, options = {}) {
  const candidateContent = normalizeText(candidate.content);
  const candidateActorUserId = normalizeText(candidate.actorUserId);
  const candidateActorRole = normalizeText(candidate.actorRole);
  if (!sessionId || !candidateContent || !candidateActorUserId || !candidateActorRole.endsWith("_twin")) {
    return null;
  }

  const turns = collapseAdjacentDuplicateTwinTurns(options.turns || listConversationTurns(sessionId));
  const candidateMetadata = normalizeMessageMetadata(candidate.metadata || {});
  const candidateQuestionText = normalizeText(
    candidateMetadata.canonical_question_text ||
      candidateMetadata.emitted_question_text ||
      extractTrailingQuestionText(candidateContent)
  );
  const candidateQuestionTopic =
    normalizeTopicKey(candidateMetadata.canonical_question_topic_key) ||
    normalizeTopicKey(candidateMetadata.emitted_question_topic_key) ||
    normalizeTopicKey(candidateMetadata.question_topic_key) ||
    inferQuestionTopicFromQuestionText(candidateQuestionText);
  const candidateFingerprint =
    getCanonicalQuestionFingerprintFromMetadata(candidateMetadata, candidateContent) ||
    buildQuestionFingerprint(candidateQuestionText, candidateQuestionTopic);

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn?.actorUserId) {
      continue;
    }

    if (!String(turn.actorRole || "").endsWith("_twin")) {
      if (turn.actorUserId !== candidateActorUserId) {
        break;
      }
      continue;
    }

    if (turn.actorUserId !== candidateActorUserId) {
      break;
    }

    const normalizedTurnContent = normalizeText(turn.content);
    if (!normalizedTurnContent) {
      continue;
    }

    if (normalizedTurnContent === candidateContent) {
      return turn;
    }

    const turnQuestionText = getTwinTurnCanonicalQuestionText(turn);
    const turnQuestionTopic = getTwinTurnCanonicalQuestionTopic(turn);
    const turnFingerprint =
      getCanonicalQuestionFingerprintFromMetadata(turn.metadata || {}, turn.content) ||
      buildQuestionFingerprint(turnQuestionText, turnQuestionTopic);

    if (
      candidateQuestionText &&
      turnQuestionText &&
      candidateQuestionTopic &&
      turnQuestionTopic &&
      candidateQuestionTopic === turnQuestionTopic &&
      candidateFingerprint &&
      turnFingerprint &&
      candidateFingerprint === turnFingerprint
    ) {
      return turn;
    }
  }

  return null;
}

function buildDuplicateTwinTurnMetadata(existingTurn, trigger = null, reason = "identical_recent_twin_turn") {
  const metadata = normalizeMessageMetadata(existingTurn?.metadata || {});
  return normalizeMessageMetadata({
    ...metadata,
    duplicate_guard_triggered: true,
    duplicate_guard_reason: normalizeText(reason) || "identical_recent_twin_turn",
    duplicate_of_turn_id: existingTurn?.id || null,
    duplicate_of_round_id: existingTurn?.roundId || null,
    duplicate_source_trigger: normalizeText(trigger) || null
  });
}

function shouldSkipDuplicateTwinTurn(sessionId, candidate = {}, options = {}) {
  const equivalentTurn = findLatestEquivalentTwinTurn(sessionId, candidate, options);
  if (!equivalentTurn) {
    return null;
  }

  return {
    duplicate: true,
    existingTurn: equivalentTurn,
    metadata: buildDuplicateTwinTurnMetadata(
      equivalentTurn,
      options.trigger || candidate?.metadata?.duplicate_source_trigger || null,
      options.reason || "identical_recent_twin_turn"
    )
  };
}

function finalizeTwinTurnResult(result, speaker, turns, source = "raw_model_output", options = {}) {
  let sanitized = sanitizeTwinReplyIdentityIntro(
    result,
    {
      isFirstTwinMessage: !turns.some((turn) => String(turn.actorRole || "").endsWith("_twin")),
      speakerDisplayName: speaker?.displayName || ""
    },
    source
  );

  if (sanitized?.forbidden_intro_detected && !normalizeText(sanitized.reply)) {
    return {
      ...sanitized,
      reply: "",
      open_questions: ["当前这一题需要人工确认后再继续。"],
      needs_human_input: {
        required: true,
        field: sanitized.needs_human_input?.field || "manual_review",
        question: sanitized.needs_human_input?.question || "当前回复只有重复自我介绍，缺少有效内容，请本人确认后再继续。",
        target_user_for_input: sanitized.needs_human_input?.target_user_for_input || "self"
      },
      recommendation: "pause_review",
      reply_quality_issue: sanitized.reply_quality_issue || "forbidden_repeated_twin_intro",
      rewrite_applied: true,
      rewrite_reason: source,
      rewrite_failed: true
    };
  }

  const shouldInjectRequiredIntro =
    Boolean(sanitized?.is_first_twin_message) &&
    !detectForbiddenTwinIntro(sanitized?.reply, speaker?.displayName || "");

  if (shouldInjectRequiredIntro) {
    sanitized = {
      ...sanitized,
      reply: injectRequiredTwinIntro(sanitized?.reply, speaker?.displayName || ""),
      intro_injected: true,
      intro_injection_source: source || "raw_model_output",
      intro_injection_result: "prepended_required_intro"
    };

    writeLlmTelemetry(
      buildQualityTelemetryPayload({
        request_type: "turn_intro_guard",
        reply_quality_issue: "missing_required_first_twin_intro",
        rewrite_applied: true,
        rewrite_reason: source,
        intro_injected: true,
        intro_injection_source: source || "raw_model_output",
        intro_injection_result: "prepended_required_intro"
      })
    );
  }

  return persistFinalCanonicalTurnMetadata(
    sanitized,
    options.turnFrame || {},
    {
      ...buildCanonicalContextFromFrame(options.turnFrame || {}, options.canonicalContext || {}),
      speakerDisplayName: speaker?.displayName || ""
    }
  );
}

function hasUnresolvedTopicBacklog(session) {
  const canonicalScopedTopicKeys = getCanonicalScopedTopicKeys(session);
  const activeTopicKey = getScopedActiveTopicKey(session, null, canonicalScopedTopicKeys.map((key) => ({ key })));
  if (activeTopicKey) {
    return true;
  }

  const scopedQueue = getScopedTopicQueueSnapshot(
    session,
    null,
    canonicalScopedTopicKeys.map((key) => ({ key }))
  );
  if (scopedQueue.length > 0) {
    return true;
  }

  return canonicalScopedTopicKeys.length > 0;
}

function areAllCanonicalTopicsClosed(session) {
  return getCanonicalScopedTopicKeys(session).length === 0;
}

function getAlignmentIssueList(metadata = {}) {
  return normalizeText(metadata?.alignment_issue)
    .split(",")
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function isSemanticallyMisalignedTwinTurn(turn) {
  if (!turn || !String(turn.actorRole || "").endsWith("_twin")) {
    return false;
  }

  const metadata = turn.metadata || {};
  const canonicalQuestionText = normalizeText(
    metadata.canonical_question_text ||
      metadata.emitted_question_text
  );
  const canonicalQuestionTopicKey =
    normalizeTopicKey(metadata.canonical_question_topic_key) ||
    normalizeTopicKey(metadata.emitted_question_topic_key) ||
    normalizeTopicKey(metadata.question_topic_key);
  const storedQuestionFingerprint = normalizeText(metadata.question_fingerprint);
  const expectedQuestionFingerprint =
    canonicalQuestionText && canonicalQuestionTopicKey
      ? buildQuestionFingerprint(canonicalQuestionText, canonicalQuestionTopicKey)
      : null;
  const derivedGuardQuestionTopicKey =
    normalizeTopicKey(metadata?.topic_guard_metadata?.derivedQuestionTopicKey) ||
    normalizeTopicKey(metadata?.topic_guard_metadata?.derived_question_topic_key) ||
    normalizeTopicKey(metadata?.topic_guard_metadata?.originalQuestionTopicKey) ||
    normalizeTopicKey(metadata?.topic_guard_metadata?.original_question_topic_key);
  const alignmentIssues = getAlignmentIssueList(metadata);
  if (
    alignmentIssues.some((issue) =>
      ["question_topic_mismatch", "reply_topic_mismatch", "stale_question_topic"].includes(issue)
    )
  ) {
    return true;
  }

  if (
    normalizeText(metadata.repair_note) === "closed_topic_guard_rewritten" &&
    normalizeText(metadata.recommendation) === "pause_review" &&
    !normalizeText(metadata.emitted_question_text)
  ) {
    return true;
  }

  const emittedQuestionText = normalizeText(metadata.emitted_question_text);
  const questionTopicKey = normalizeTopicKey(metadata.question_topic_key);
  const emittedQuestionTopicKey = normalizeTopicKey(metadata.emitted_question_topic_key);
  const replyTopicKey = normalizeTopicKey(metadata.reply_topic_key);
  const emittedReplyTopicKey = normalizeTopicKey(metadata.emitted_reply_topic_key);

  if (emittedQuestionText && questionTopicKey && emittedQuestionTopicKey && questionTopicKey !== emittedQuestionTopicKey) {
    return true;
  }

  if (replyTopicKey && emittedReplyTopicKey && replyTopicKey !== emittedReplyTopicKey) {
    return true;
  }

  if (storedQuestionFingerprint && !canonicalQuestionText) {
    return true;
  }

  if (storedQuestionFingerprint && expectedQuestionFingerprint && storedQuestionFingerprint !== expectedQuestionFingerprint) {
    return true;
  }

  if (
    normalizeText(metadata.repair_note) === "closed_topic_guard_rewritten" &&
    normalizeText(metadata.closed_topic_guard_resolution) === "rewritten_to_next_topic" &&
    canonicalQuestionTopicKey &&
    derivedGuardQuestionTopicKey &&
    canonicalQuestionTopicKey !== derivedGuardQuestionTopicKey
  ) {
    return true;
  }

  return false;
}

function isCarryoverSourceTurnValid(turn) {
  if (!turn || !String(turn.actorRole || "").endsWith("_twin")) {
    return false;
  }

  const metadata = normalizeMessageMetadata(turn.metadata || {});
  const alignmentIssues = getAlignmentIssueList(metadata);
  if (
    alignmentIssues.some((issue) =>
      [
        "question_topic_mismatch",
        "reply_topic_mismatch",
        "stale_question_topic",
        "confirmed_facts_mismatch"
      ].includes(issue)
    )
  ) {
    return false;
  }

  if (normalizeText(metadata.emitted_question_text) && !normalizeTopicKey(metadata.emitted_question_topic_key)) {
    return false;
  }

  if (!normalizeText(metadata.emitted_question_text) && normalizeTopicKey(metadata.question_topic_key)) {
    return false;
  }

  if (!normalizeText(metadata.reply) && !normalizeText(turn.content)) {
    return false;
  }

  if (metadata.canonical_outcome_trusted === false) {
    return false;
  }

  if (
    normalizeText(metadata.canonical_question_text) &&
    !normalizeTopicKey(metadata.canonical_question_topic_key)
  ) {
    return false;
  }

  if (
    normalizeText(metadata.canonical_answer_text) &&
    !normalizeTopicKey(metadata.canonical_reply_topic_key)
  ) {
    return false;
  }

  if (
    normalizeText(metadata.required_reply_text) &&
    normalizeText(metadata.did_answer_required_question) === "false"
  ) {
    return false;
  }

  const questionTopicKey =
    normalizeTopicKey(metadata.canonical_question_topic_key) ||
    normalizeTopicKey(metadata.emitted_question_topic_key) ||
    normalizeTopicKey(metadata.question_topic_key) ||
    inferQuestionTopicFromQuestionText(
      normalizeText(metadata.canonical_question_text || metadata.emitted_question_text || "")
    );
  if (
    questionTopicKey &&
    (
      normalizeText(metadata.repeat_source) === "same_topic_broad_question_repeat" ||
      normalizeText(metadata.repeat_source) === "close_after_current_result" ||
      normalizeText(metadata.repeat_guard_suppression_reason) === "topic_already_closed"
    ) &&
    !normalizeText(metadata.canonical_question_text)
  ) {
    return false;
  }

  return true;
}

function isTrustedCanonicalTwinTurn(turn) {
  if (!turn || !String(turn.actorRole || "").endsWith("_twin")) {
    return false;
  }

  const metadata = normalizeMessageMetadata(turn.metadata || {});
  if (metadata.canonical_outcome_trusted === false || metadata.carryover_source_valid === false) {
    return false;
  }

  if (shouldRuntimeRebuildHistoricalTwinTurn(metadata, turn.content)) {
    return false;
  }

  return !isSemanticallyMisalignedTwinTurn({
    ...turn,
    metadata
  });
}

const TURN_FRAME_VERSION = "turn_frame_v1_2026_06_03";

function getRequiredReplyTarget({
  speaker,
  listener,
  latestTurn = null,
  latestListenerQuestionTopic = null,
  manualQuestion = null,
  carryoverTwinQuestion = null
}) {
  if (manualQuestion?.enabled && normalizeText(manualQuestion.questionText)) {
    return {
      replyObligation: "manual_question",
      replyTarget: {
        text: normalizeText(manualQuestion.questionText),
        topicKey: normalizeTopicKey(manualQuestion.questionTopic),
        askedByUserId: manualQuestion.askedByUserId || listener?.userId || null,
        sourceTurnId: null
      }
    };
  }

  if (carryoverTwinQuestion?.enabled && normalizeText(carryoverTwinQuestion.questionText)) {
    return {
      replyObligation: "carryover_twin_question",
      replyTarget: {
        text: normalizeText(carryoverTwinQuestion.questionText),
        topicKey: normalizeTopicKey(carryoverTwinQuestion.questionTopic),
        askedByUserId: carryoverTwinQuestion.askedByUserId || listener?.userId || null,
        sourceTurnId: carryoverTwinQuestion.sourceTurnId || null
      }
    };
  }

  if (
    latestTurn?.actorUserId === listener?.userId &&
    textLooksLikeQuestion(latestTurn?.content)
  ) {
    return {
      replyObligation: "listener_question",
      replyTarget: {
        text: normalizeText(
          normalizeMessageMetadata(latestTurn.metadata || {}).canonical_question_text ||
            normalizeMessageMetadata(latestTurn.metadata || {}).emitted_question_text ||
            extractTrailingQuestionText(latestTurn.content) ||
            latestTurn.content
        ),
        topicKey: normalizeTopicKey(latestListenerQuestionTopic),
        askedByUserId: listener?.userId || null,
        sourceTurnId: latestTurn.id || null
      }
    };
  }

  return {
    replyObligation: "none",
    replyTarget: {
      text: null,
      topicKey: null,
      askedByUserId: null,
      sourceTurnId: null
    }
  };
}

function buildRecentContextSnapshot(turns = [], session, currentActiveTopicKey = null) {
  const recentTwinTurns = turns
    .filter((turn) => String(turn?.actorRole || "").endsWith("_twin"))
    .filter((turn) => isTrustedCanonicalTwinTurn(turn))
    .slice(-6);
  const recentQuestionFingerprints = recentTwinTurns
    .map((turn) => getCanonicalQuestionFingerprintFromMetadata(turn.metadata || {}, turn.content))
    .filter(Boolean);
  const recentlyConfirmedTopics = recentTwinTurns
    .map((turn) => normalizeTopicKey(normalizeMessageMetadata(turn.metadata || {}).canonical_reply_topic_key))
    .filter(Boolean)
    .slice(-4);
  const outstanding = detectOutstandingTwinQuestion(session, turns, null);

  return {
    recentQuestionFingerprints,
    recentlyConfirmedTopics,
    unresolvedTwinQuestion: outstanding
      ? {
          questionText: outstanding.questionText,
          questionTopic: outstanding.questionTopic,
          askedByUserId: outstanding.askedByUserId,
          sourceTurnId: outstanding.sourceTurn?.id || null
        }
      : null,
    latestResolvedTopic: normalizeTopicKey(currentActiveTopicKey) && recentlyConfirmedTopics.includes(normalizeTopicKey(currentActiveTopicKey))
      ? normalizeTopicKey(currentActiveTopicKey)
      : recentlyConfirmedTopics.at(-1) || null
  };
}

function buildCanonicalTurnFrame({
  session,
  speaker,
  listener,
  latestTurn,
  latestListenerQuestionTopic,
  manualQuestion,
  carryoverTwinQuestion,
  activeTopicKey,
  activeTopicState,
  nextCandidateTopicKey,
  closedTopicKeys,
  forbiddenTopicKeys,
  suggestedAnswerMaterial,
  turnsForPrompt,
  openingContext
}) {
  const { replyObligation, replyTarget } = getRequiredReplyTarget({
    speaker,
    listener,
    latestTurn,
    latestListenerQuestionTopic,
    manualQuestion,
    carryoverTwinQuestion
  });

  return {
    frame_version: TURN_FRAME_VERSION,
    reply_obligation: replyObligation,
    reply_target: replyTarget,
    topic_plan: {
      activeTopicKey: normalizeTopicKey(activeTopicKey),
      activeTopicState: activeTopicState || null,
      canSwitchOnlyAfterClose: true,
      nextCandidateTopicKey: normalizeTopicKey(nextCandidateTopicKey),
      closedTopicKeys: [...new Set((closedTopicKeys || []).map((item) => normalizeTopicKey(item)).filter(Boolean))],
      forbiddenTopicKeys: [...new Set((forbiddenTopicKeys || []).map((item) => normalizeTopicKey(item)).filter(Boolean))]
    },
    answer_material: suggestedAnswerMaterial
      ? {
          topicKey: normalizeTopicKey(suggestedAnswerMaterial.topicKey),
          source:
            replyObligation === "manual_question"
              ? "manual_question"
              : replyObligation === "carryover_twin_question"
                ? "carryover_twin_question"
                : replyObligation === "listener_question"
                  ? "listener_question"
                  : normalizeTopicKey(suggestedAnswerMaterial.topicKey) === normalizeTopicKey(activeTopicKey)
                    ? "active_topic"
                    : "explicit_card",
          normalizedSummary: normalizeText(suggestedAnswerMaterial.normalizedSummary || suggestedAnswerMaterial.rawValue || ""),
          naturalAnswerHint: normalizeText(suggestedAnswerMaterial.naturalAnswerHint || "")
        }
      : null,
    recent_context: buildRecentContextSnapshot(turnsForPrompt, session, activeTopicKey),
    conversation_rules: {
      isFirstTwinMessage: Boolean(openingContext?.effectiveFirstOpening),
      maxFollowupQuestions: 1,
      allowIdentityIntroOnce: true
    }
  };
}

function didCanonicalAnswerRequiredQuestion(result, frame = {}) {
  const requiredTopic = normalizeTopicKey(frame?.reply_target?.topicKey);
  const replyObligation = normalizeText(frame?.reply_obligation);
  const canonicalReplyTopic =
    normalizeTopicKey(result?.canonical_reply_topic_key) ||
    normalizeTopicKey(result?.emitted_reply_topic_key) ||
    normalizeTopicKey(result?.reply_topic_key);
  const canonicalAnswerText = normalizeText(result?.canonical_answer_text);

  if (!requiredTopic) {
    return replyObligation === "none" || !normalizeText(frame?.reply_target?.text);
  }

  if (!canonicalAnswerText || !canonicalReplyTopic) {
    return false;
  }

  return canonicalReplyTopic === requiredTopic;
}

function buildCanonicalTurnOutcome(result, frame = {}, context = {}) {
  if (!result || typeof result !== "object") {
    return result;
  }

  const canonicalized = canonicalizeFinalTurnOutcome(result, context);
  const normalizedReply = normalizeText(canonicalized.reply);
  const { answerText, questionText } = splitReplyIntoAnswerAndTrailingQuestion(normalizedReply);
  const substantiveAnswerText = shouldTreatLeadingAnswerSegmentAsSubstantive(answerText, context)
    ? normalizeText(answerText)
    : "";
  const canonicalReplyTopicKey =
    normalizeTopicKey(canonicalized.canonical_reply_topic_key) ||
    normalizeTopicKey(canonicalized.emitted_reply_topic_key) ||
    normalizeTopicKey(canonicalized.reply_topic_key);
  const canonicalQuestionTopicKey =
    normalizeTopicKey(canonicalized.canonical_question_topic_key) ||
    normalizeTopicKey(canonicalized.emitted_question_topic_key) ||
    normalizeTopicKey(canonicalized.question_topic_key);
  const didAnswerRequiredQuestion = didCanonicalAnswerRequiredQuestion(
    {
      ...canonicalized,
      canonical_answer_text: substantiveAnswerText || null
    },
    frame
  );
  const normalizedQuestionText = normalizeText(questionText);
  const questionFingerprint = normalizedQuestionText
    ? buildQuestionFingerprint(normalizedQuestionText, canonicalQuestionTopicKey)
    : null;
  const switchedTopicAfterClose =
    Boolean(frame?.topic_plan?.activeTopicKey) &&
    Boolean(canonicalQuestionTopicKey) &&
    normalizeTopicKey(frame.topic_plan.activeTopicKey) !== canonicalQuestionTopicKey;
  const canonicalOutcomeTrusted = !getAlignmentIssueList(canonicalized).some((issue) =>
    ["question_topic_mismatch", "reply_topic_mismatch", "stale_question_topic", "confirmed_facts_mismatch"].includes(issue)
  );

  return normalizeMessageMetadata({
    ...canonicalized,
    frame_version: frame?.frame_version || TURN_FRAME_VERSION,
    required_reply_source: normalizeText(frame?.reply_obligation) || "none",
    required_reply_topic: normalizeTopicKey(frame?.reply_target?.topicKey) || null,
    required_reply_text: normalizeText(frame?.reply_target?.text) || null,
    canonical_answer_text: substantiveAnswerText || null,
    canonical_reply_topic_key: substantiveAnswerText ? canonicalReplyTopicKey || null : null,
    canonical_question_text: normalizedQuestionText || null,
    canonical_question_topic_key: canonicalQuestionTopicKey || null,
    canonical_open_questions: normalizedQuestionText ? [normalizedQuestionText] : [],
    canonical_confirmed_facts: Array.isArray(canonicalized.confirmed_facts) ? canonicalized.confirmed_facts : [],
    did_answer_required_question: didAnswerRequiredQuestion,
    switched_topic_after_close: switchedTopicAfterClose,
    question_fingerprint: questionFingerprint || null,
    carryover_source_valid: canonicalOutcomeTrusted,
    canonical_outcome_trusted: canonicalOutcomeTrusted
  });
}

function persistFinalCanonicalTurnMetadata(result, frame = {}, context = {}, extraMetadata = {}) {
  const canonicalOutcome = buildCanonicalTurnOutcome(result, frame, context);
  return normalizeMessageMetadata({
    ...canonicalOutcome,
    ...extraMetadata,
    reply_topic_key: canonicalOutcome.canonical_reply_topic_key || null,
    emitted_reply_topic_key: canonicalOutcome.canonical_reply_topic_key || null,
    canonical_reply_topic_key: canonicalOutcome.canonical_reply_topic_key || null,
    question_topic_key: canonicalOutcome.canonical_question_topic_key || null,
    emitted_question_topic_key: canonicalOutcome.canonical_question_topic_key || null,
    canonical_question_topic_key: canonicalOutcome.canonical_question_topic_key || null,
    emitted_question_text: canonicalOutcome.canonical_question_text || null,
    canonical_question_text: canonicalOutcome.canonical_question_text || null,
    open_questions: Array.isArray(canonicalOutcome.canonical_open_questions)
      ? canonicalOutcome.canonical_open_questions
      : [],
    canonical_open_questions: Array.isArray(canonicalOutcome.canonical_open_questions)
      ? canonicalOutcome.canonical_open_questions
      : [],
    confirmed_facts: Array.isArray(canonicalOutcome.canonical_confirmed_facts)
      ? canonicalOutcome.canonical_confirmed_facts
      : [],
    canonical_confirmed_facts: Array.isArray(canonicalOutcome.canonical_confirmed_facts)
      ? canonicalOutcome.canonical_confirmed_facts
      : [],
    question_fingerprint: canonicalOutcome.canonical_question_text
      ? buildQuestionFingerprint(
          canonicalOutcome.canonical_question_text,
          canonicalOutcome.canonical_question_topic_key
        )
      : null,
    canonical_question_recomputed: true,
    stale_question_metadata_cleared: !normalizeText(canonicalOutcome.canonical_question_text)
  });
}

function buildCanonicalContextFromFrame(frame = {}, overrides = {}) {
  const activeTopicKey =
    normalizeTopicKey(overrides.activeTopicKey) ||
    normalizeTopicKey(frame?.topic_plan?.activeTopicKey) ||
    null;
  const latestListenerQuestionTopic =
    normalizeTopicKey(overrides.latestListenerQuestionTopic) ||
    normalizeTopicKey(frame?.reply_target?.topicKey) ||
    null;

  return {
    activeTopicKey,
    latestListenerQuestionTopic,
    speakerUserId: overrides.speakerUserId || null,
    listenerUserId: overrides.listenerUserId || null
  };
}

function shouldRejectAnswerTopicMismatch({ result, activeTopicKey = null, latestListenerQuestionTopic = null }) {
  const questionTopic =
    normalizeTopicKey(result?.canonical_question_topic_key) ||
    normalizeTopicKey(result?.emitted_question_topic_key) ||
    normalizeTopicKey(result?.question_topic_key);
  const replyTopic =
    normalizeTopicKey(result?.canonical_reply_topic_key) ||
    normalizeTopicKey(result?.emitted_reply_topic_key) ||
    normalizeTopicKey(result?.reply_topic_key);
  const answerText = normalizeText(result?.canonical_answer_text) || splitReplyIntoAnswerAndTrailingQuestion(result?.reply).answerText;
  const hasAnswer = Boolean(normalizeText(answerText));
  const expectedAnswerTopic = normalizeTopicKey(latestListenerQuestionTopic);
  const inferredAnswerTopic = inferAnswerTopicFromAnswerSegment(answerText, activeTopicKey, latestListenerQuestionTopic);
  const effectiveReplyTopic = replyTopic || inferredAnswerTopic;

  if (!hasAnswer || !expectedAnswerTopic || !effectiveReplyTopic) {
    return false;
  }

  if (getAlignmentIssueList(result).includes("confirmed_facts_mismatch")) {
    return false;
  }

  if (effectiveReplyTopic === expectedAnswerTopic) {
    return false;
  }

  if (questionTopic && questionTopic !== expectedAnswerTopic && effectiveReplyTopic !== expectedAnswerTopic) {
    return true;
  }

  return effectiveReplyTopic !== expectedAnswerTopic;
}

function shouldDeferJumpTopicGuardToAnswerMismatch({
  latestListenerQuestionTopic = null,
  activeTopicKey = null,
  replyTopicKey = null,
  questionTopicKey = null
}) {
  return false;
}

function isHumanUserTurn(turn) {
  return Boolean(turn?.actorUserId) && String(turn?.actorRole || "").endsWith("_user");
}

function isSystemTurn(turn) {
  return !turn?.actorUserId;
}

function buildReactionSummary(reactions = [], currentUserId) {
  const grouped = new Map();

  for (const reaction of reactions) {
    const key = reaction.emoji;
    const entry = grouped.get(key) || {
      emoji: key,
      count: 0,
      reactedByCurrentUser: false
    };
    entry.count += 1;
    if (reaction.userId === currentUserId) {
      entry.reactedByCurrentUser = true;
    }
    grouped.set(key, entry);
  }

  return [...grouped.values()];
}

function buildQuotedPreview(turn, session, currentUserId) {
  if (!turn) {
    return null;
  }

  const normalizedMetadata = normalizeMessageMetadata(turn.metadata);
  const currentUserRole = participantRole(session, currentUserId);
  const currentUserMessageRole = currentUserRole === "initiator" ? "initiator_user" : "counterparty_user";
  const actorLabel =
    turn.actorRole === currentUserMessageRole
      ? "你"
      : turn.actorUserId == null
        ? "系统"
        : turn.actorRole.endsWith("_twin")
          ? "Twin"
          : "对方";

  return {
    turnId: turn.id,
    actorLabel,
    content: normalizedMetadata.recalled ? "" : normalizeText(turn.content),
    isRecalled: normalizedMetadata.recalled
  };
}

function buildVisibleTurn(turn, session, currentUserId, allTurnsById) {
  const sanitizedTurn = sanitizeTwinTurnForDisplay(turn, session);
  const metadata = normalizeMessageMetadata(sanitizedTurn.metadata);

  if (metadata.deletedForUserIds.includes(currentUserId)) {
    return null;
  }

  const quotedTurn = metadata.quotedTurnId ? allTurnsById.get(metadata.quotedTurnId) || null : null;
  const quotedPreview = quotedTurn
    ? buildQuotedPreview(quotedTurn, session, currentUserId)
    : metadata.quotedPreview;
  const recalledByCurrentUser = metadata.recalled && metadata.recalledByUserId === currentUserId;
  const isMine = turn.actorUserId === currentUserId;
  const canDeleteMine = isMine && isHumanUserTurn(turn);
  const canMutateMine = canDeleteMine && !metadata.recalled;

  return {
    ...sanitizedTurn,
    metadata,
    content: metadata.recalled
      ? recalledByCurrentUser
        ? "你撤回了一条消息"
        : "对方撤回了一条消息"
      : sanitizedTurn.content,
    isRecalled: metadata.recalled,
    recalledByCurrentUser,
    isEdited: metadata.edited,
    editedAt: metadata.editedAt,
    quotedTurn: quotedPreview
      ? {
          ...quotedPreview,
          content: quotedPreview.isRecalled ? "该消息已撤回" : quotedPreview.content
        }
      : null,
    reactions: buildReactionSummary(metadata.reactions, currentUserId),
    canDelete: canDeleteMine,
    canRecall: canMutateMine && Date.now() - new Date(turn.createdAt).getTime() <= MESSAGE_RECALL_WINDOW_MS,
    canEdit: canMutateMine,
    canQuote: !isSystemTurn(turn),
    canReact: !isSystemTurn(turn)
  };
}

function participantRole(session, userId) {
  return session.initiatorUserId === userId ? "initiator" : "counterparty";
}

function getSessionControl(session) {
  const control = session?.control && typeof session.control === "object" ? session.control : {};
  const manualPause = control.manualPause && typeof control.manualPause === "object" ? control.manualPause : {};
  const automation = control.automation && typeof control.automation === "object" ? control.automation : {};
  const reviewInbox = control.reviewInbox && typeof control.reviewInbox === "object" ? control.reviewInbox : {};
  const sensitiveApprovalLedger =
    control.sensitiveApprovalLedger && typeof control.sensitiveApprovalLedger === "object"
      ? control.sensitiveApprovalLedger
      : {};
  const legacyActive = Boolean(manualPause.active);
  const legacyMessageCount = Number(manualPause.messageCount || 0);
  const messageCountByRole =
    manualPause.messageCountByRole && typeof manualPause.messageCountByRole === "object"
      ? manualPause.messageCountByRole
      : {};
  const preferredObjectiveKeys = Array.isArray(automation.preferredObjectiveKeys)
    ? [...new Set(automation.preferredObjectiveKeys.map((item) => normalizeText(item)).filter(Boolean))]
    : [];
  const topicQueueSnapshot = Array.isArray(automation.topicQueueSnapshot)
    ? [...new Set(automation.topicQueueSnapshot.map((item) => normalizeTopicKey(item)).filter(Boolean))]
    : [];
  const topicLedger = normalizeTopicLedger(automation.topicLedger);
  const activeTopicKey = normalizeTopicKey(automation.activeTopicKey);
  const lastClosedTopicKey = normalizeTopicKey(automation.lastClosedTopicKey);
  const deferredRetry = normalizeDeferredRetryState(automation.deferredRetry);

  return {
    ...control,
    manualPause: {
      initiatorEnded: Boolean(
        manualPause.initiatorEnded == null ? legacyActive : manualPause.initiatorEnded
      ),
      counterpartyEnded: Boolean(
        manualPause.counterpartyEnded == null ? legacyActive : manualPause.counterpartyEnded
      ),
      messageCountByRole: {
        initiator: Number(
          messageCountByRole.initiator == null ? legacyMessageCount : messageCountByRole.initiator
        ),
        counterparty: Number(
          messageCountByRole.counterparty == null ? legacyMessageCount : messageCountByRole.counterparty
        )
      }
    },
    reviewInbox: normalizeReviewInbox(reviewInbox),
    sensitiveApprovalLedger: normalizeSensitiveApprovalLedger(sensitiveApprovalLedger),
    automation: {
      enabled: automation.enabled == null ? true : Boolean(automation.enabled),
      source: normalizeText(automation.source) || "legacy",
      preferredObjectiveKeys,
      activeTopicKey,
      lastClosedTopicKey,
      topicQueueSnapshot,
      topicLedger,
      startAttempts: Number.isFinite(Number(automation.startAttempts))
        ? Math.max(0, Number(automation.startAttempts))
        : 0,
      lastTrigger: normalizeText(automation.lastTrigger) || null,
      lastFailureReason: normalizeText(automation.lastFailureReason) || null,
      lastFailureAt: normalizeText(automation.lastFailureAt) || null,
      lastStartedAt: normalizeText(automation.lastStartedAt) || null,
      runState: AUTOMATION_RUN_STATES.has(normalizeText(automation.runState))
        ? normalizeText(automation.runState)
        : "idle",
      queuedTrigger: normalizeText(automation.queuedTrigger) || null,
      activeTrigger: normalizeText(automation.activeTrigger) || null,
      lastCompletedAt: normalizeText(automation.lastCompletedAt) || null,
      deferredRetry
    }
  };
}

function buildSessionControlPatch(session, patch = {}) {
  const current = getSessionControl(session);
  const manualPausePatch =
    patch.manualPause && typeof patch.manualPause === "object" ? patch.manualPause : null;
  const reviewInboxPatch =
    patch.reviewInbox && typeof patch.reviewInbox === "object" ? patch.reviewInbox : null;
  const sensitiveApprovalLedgerPatch =
    patch.sensitiveApprovalLedger && typeof patch.sensitiveApprovalLedger === "object"
      ? patch.sensitiveApprovalLedger
      : null;
  const automationPatch =
    patch.automation && typeof patch.automation === "object" ? patch.automation : null;
  const messageCountPatch =
    manualPausePatch?.messageCountByRole && typeof manualPausePatch.messageCountByRole === "object"
      ? manualPausePatch.messageCountByRole
      : null;
  const nextManualPause =
    manualPausePatch == null
      ? current.manualPause
      : {
          initiatorEnded: Boolean(
            manualPausePatch.initiatorEnded == null
              ? current.manualPause.initiatorEnded
              : manualPausePatch.initiatorEnded
          ),
          counterpartyEnded: Boolean(
            manualPausePatch.counterpartyEnded == null
              ? current.manualPause.counterpartyEnded
              : manualPausePatch.counterpartyEnded
          ),
          messageCountByRole: {
            initiator: Number(
              messageCountPatch?.initiator == null
                ? current.manualPause.messageCountByRole.initiator
                : messageCountPatch.initiator
            ),
            counterparty: Number(
              messageCountPatch?.counterparty == null
                ? current.manualPause.messageCountByRole.counterparty
                : messageCountPatch.counterparty
              )
          }
        };
  const preferredObjectiveKeysPatch = Array.isArray(automationPatch?.preferredObjectiveKeys)
    ? [...new Set(automationPatch.preferredObjectiveKeys.map((item) => normalizeText(item)).filter(Boolean))]
    : null;
  const topicQueueSnapshotPatch = Array.isArray(automationPatch?.topicQueueSnapshot)
    ? [...new Set(automationPatch.topicQueueSnapshot.map((item) => normalizeTopicKey(item)).filter(Boolean))]
    : null;
  const topicLedgerPatch =
    automationPatch?.topicLedger && typeof automationPatch.topicLedger === "object"
      ? normalizeTopicLedger({
          ...current.automation.topicLedger,
          ...automationPatch.topicLedger
        })
      : null;
  const deferredRetryPatch =
    automationPatch && Object.prototype.hasOwnProperty.call(automationPatch, "deferredRetry")
      ? normalizeDeferredRetryState(automationPatch.deferredRetry)
      : undefined;
  const nextReviewInbox =
    reviewInboxPatch == null
      ? current.reviewInbox
      : normalizeReviewInbox({
          ...current.reviewInbox,
          ...reviewInboxPatch
        });
  const nextSensitiveApprovalLedger =
    sensitiveApprovalLedgerPatch == null
      ? current.sensitiveApprovalLedger
      : normalizeSensitiveApprovalLedger({
          ...current.sensitiveApprovalLedger,
          ...sensitiveApprovalLedgerPatch
        });
  const nextAutomation =
    automationPatch == null
      ? current.automation
      : {
          enabled: automationPatch.enabled == null ? current.automation.enabled : Boolean(automationPatch.enabled),
          source: normalizeText(automationPatch.source) || current.automation.source,
          preferredObjectiveKeys:
            preferredObjectiveKeysPatch == null ? current.automation.preferredObjectiveKeys : preferredObjectiveKeysPatch,
          activeTopicKey:
            automationPatch.activeTopicKey === undefined
              ? current.automation.activeTopicKey
              : normalizeTopicKey(automationPatch.activeTopicKey),
          lastClosedTopicKey:
            automationPatch.lastClosedTopicKey === undefined
              ? current.automation.lastClosedTopicKey
              : normalizeTopicKey(automationPatch.lastClosedTopicKey),
          topicQueueSnapshot:
            topicQueueSnapshotPatch == null ? current.automation.topicQueueSnapshot : topicQueueSnapshotPatch,
          topicLedger: topicLedgerPatch == null ? current.automation.topicLedger : topicLedgerPatch,
          startAttempts:
            automationPatch.startAttempts == null
              ? current.automation.startAttempts
              : Math.max(0, Number(automationPatch.startAttempts) || 0),
          lastTrigger:
            automationPatch.lastTrigger === undefined
              ? current.automation.lastTrigger
              : normalizeText(automationPatch.lastTrigger) || null,
          lastFailureReason:
            automationPatch.lastFailureReason === undefined
              ? current.automation.lastFailureReason
              : normalizeText(automationPatch.lastFailureReason) || null,
          lastFailureAt:
            automationPatch.lastFailureAt === undefined
              ? current.automation.lastFailureAt
              : normalizeText(automationPatch.lastFailureAt) || null,
          lastStartedAt:
            automationPatch.lastStartedAt === undefined
              ? current.automation.lastStartedAt
              : normalizeText(automationPatch.lastStartedAt) || null,
          runState:
            automationPatch.runState === undefined
              ? current.automation.runState
              : AUTOMATION_RUN_STATES.has(normalizeText(automationPatch.runState))
                ? normalizeText(automationPatch.runState)
                : current.automation.runState,
          queuedTrigger:
            automationPatch.queuedTrigger === undefined
              ? current.automation.queuedTrigger
              : normalizeText(automationPatch.queuedTrigger) || null,
          activeTrigger:
            automationPatch.activeTrigger === undefined
              ? current.automation.activeTrigger
              : normalizeText(automationPatch.activeTrigger) || null,
          lastCompletedAt:
            automationPatch.lastCompletedAt === undefined
              ? current.automation.lastCompletedAt
              : normalizeText(automationPatch.lastCompletedAt) || null,
          deferredRetry:
            deferredRetryPatch === undefined ? current.automation.deferredRetry : deferredRetryPatch
        };

  return {
    ...current,
    ...patch,
    manualPause: nextManualPause,
    reviewInbox: nextReviewInbox,
    sensitiveApprovalLedger: nextSensitiveApprovalLedger,
    automation: nextAutomation
  };
}

function isManualPauseActive(session) {
  const manualPause = getSessionControl(session).manualPause;
  return manualPause.initiatorEnded || manualPause.counterpartyEnded;
}

function getManualPauseRole(session, userId) {
  return participantRole(session, userId) === "initiator" ? "initiator" : "counterparty";
}

function isUserManualPauseActive(session, userId) {
  const role = getManualPauseRole(session, userId);
  const manualPause = getSessionControl(session).manualPause;
  return role === "initiator" ? manualPause.initiatorEnded : manualPause.counterpartyEnded;
}

function getManualMessageCount(session, userId) {
  const role = getManualPauseRole(session, userId);
  return Number(getSessionControl(session).manualPause.messageCountByRole[role] || 0);
}

function canSendManualMessage(session, userId) {
  if (!isManualPauseActive(session)) {
    return true;
  }

  return getManualMessageCount(session, userId) < 1;
}

function canSubmitHumanInput(session) {
  return !isManualPauseActive(session);
}

function buildPauseMessage(targetDisplayName, fieldKey, questionText) {
  if (fieldKey === "manual_review") {
    return "系统暂停：这一轮没有拿到稳定的模型输出，等待用户本人补充说明后再继续。";
  }

  return `系统暂停：需要 ${targetDisplayName} 本人补充信息后才能继续。待确认内容：${questionText}`;
}

function buildQualityPauseMetadata({
  result,
  source = "quality_guard",
  sourceTurnId = null,
  turnNumber = null,
  activeTopicKey = null
} = {}) {
  const metadata = {
    source,
    sourceTurnId: normalizeText(sourceTurnId) || null,
    turnNumber: Number.isFinite(Number(turnNumber)) ? Number(turnNumber) : null,
    replyQualityIssue: normalizeText(result?.reply_quality_issue) || null,
    qualityGuardReason:
      normalizeText(result?.quality_guard_reason) ||
      normalizeText(result?.reply_quality_issue) ||
      null,
    activeTopicKey: normalizeTopicKey(activeTopicKey) || null,
    canonicalReplyTopicKey:
      normalizeTopicKey(result?.canonical_reply_topic_key) ||
      normalizeTopicKey(result?.emitted_reply_topic_key) ||
      normalizeTopicKey(result?.reply_topic_key),
    canonicalQuestionTopicKey:
      normalizeTopicKey(result?.canonical_question_topic_key) ||
      normalizeTopicKey(result?.emitted_question_topic_key) ||
      normalizeTopicKey(result?.question_topic_key),
    questionFingerprint: getCanonicalQuestionFingerprintFromMetadata(result || {}, result?.reply || "") || null,
    didAnswerRequiredQuestion: result?.did_answer_required_question === true,
    mirrorQuestionRequiredForCoverage: result?.mirror_question_required_for_coverage === true,
    mirrorQuestionAllowed: result?.mirror_question_allowed === true,
    autoRecoveryCandidate:
      normalizeText(result?.reply_quality_issue) === "mirrored_latest_question" &&
      result?.did_answer_required_question === true &&
      result?.mirror_question_required_for_coverage === true &&
      result?.mirror_question_allowed === true
  };

  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
}

function buildManualQuestionClassificationContext({ session, sender, receiver, manualTurn, turns, facts }) {
  const topicKeys = [...new Set(TOPIC_CONFIG.map((item) => item.key))];
  return {
    session_id: session.id,
    trigger_turn_id: manualTurn.id,
    message_sender_role: participantRole(session, sender.userId),
    message_receiver_role: participantRole(session, receiver.userId),
    manual_message: {
      actorUserId: manualTurn.actorUserId,
      actorRole: manualTurn.actorRole,
      content: manualTurn.content
    },
    sender: {
      userId: sender.userId,
      displayName: sender.displayName
    },
    receiver: {
      userId: receiver.userId,
      displayName: receiver.displayName
    },
    receiver_fact_cards: buildFactCards(receiver, topicKeys),
    known_facts: facts.slice(-12).map((fact) => ({
      key: fact.key,
      value: fact.value,
      confidence: fact.confidence,
      subjectUserId: fact.subjectUserId
    })),
    recent_turns: turns.slice(-8).map((turn) => ({
      actorRole: turn.actorRole,
      actorUserId: turn.actorUserId,
      content: turn.content
    }))
  };
}

function buildManualQuestionHumanInputQuestion(classification, receiver, manualTurn) {
  return (
    normalizeText(classification?.human_input_question) ||
    normalizeText(classification?.question_text) ||
    `${receiver?.displayName || "你"}需要先本人补充这条真人问题的答案：${normalizeText(manualTurn?.content)}`
  );
}

function createPendingHumanInputFromManualQuestion({
  session,
  round,
  targetUserId,
  targetParticipant,
  turnNumber,
  questionText,
  triggeringTurn,
  classification
}) {
  createHumanInputRequest({
    sessionId: session.id,
    roundId: round.id,
    targetUserId,
    fieldKey: "manual_question_answer",
    questionText,
    metadata: {
      source: "manual_question",
      triggeringTurnId: triggeringTurn.id,
      questionTopic: classification.question_topic || "unknown",
      classifiedAsQuestion: true,
      classificationPromptVersion: MANUAL_QUESTION_PROMPT_VERSION
    }
  });

  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber,
    actorUserId: null,
    actorRole: "system",
    content: buildPauseMessage(targetParticipant?.displayName || "对方", "manual_question_answer", questionText),
    metadata: {
      pauseReason: "pending_human_input",
      targetUserId,
      fieldKey: "manual_question_answer",
      source: "manual_question",
      triggeringTurnId: triggeringTurn.id
    }
  });
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

function skipSensitiveTopicForSession(session, topicCategory, resolutionSource = "sensitive_topic_skipped") {
  const objectiveKey = getSensitiveObjectiveKey(topicCategory);
  const nextSensitiveApprovalLedger = buildSensitiveApprovalLedgerPatch(session, topicCategory, {
    state: "skipped",
    resolvedAt: nowIso(),
    resolutionSource,
    skippedReason: resolutionSource
  });
  const automationPatch = { topicLedger: {} };

  if (objectiveKey) {
    automationPatch.topicLedger = {
      [objectiveKey]: {
        state: "closed",
        pendingAnswerUserId: null,
        closedAt: nowIso(),
        reopenReason: null
      }
    };

    if (normalizeTopicKey(getSessionControl(session).automation.activeTopicKey) === objectiveKey) {
      automationPatch.activeTopicKey = null;
      automationPatch.lastClosedTopicKey = objectiveKey;
      automationPatch.topicQueueSnapshot = (getSessionControl(session).automation.topicQueueSnapshot || []).filter(
        (item) => normalizeTopicKey(item) !== objectiveKey
      );
    }
  }

  updatePrechatSession(session.id, {
    control: buildSessionControlPatch(session, {
      sensitiveApprovalLedger: nextSensitiveApprovalLedger,
      automation: automationPatch
    })
  });

  return getPrechatSessionById(session.id) || session;
}

function buildSensitiveApprovalRequestMetadata({
  source,
  turnNumber = null,
  promptIntent = null,
  topicCategory = null,
  promptText = null,
  extra = {}
}) {
  return {
    turnNumber,
    source,
    approvalKind: "topic",
    topicCategory: normalizeText(topicCategory) || null,
    promptIntent: normalizeText(promptIntent) || null,
    lastPromptText: normalizeText(promptText) || null,
    summaryText: buildSensitiveApprovalSummaryText(topicCategory, promptText, promptIntent),
    ...extra
  };
}

function requestSensitiveTopicApproval({
  session,
  round,
  requestingUserId,
  targetUserId,
  topicCategory,
  promptText,
  promptIntent,
  source,
  turnNumber = null,
  extraMetadata = {}
}) {
  const normalizedTopicCategory = normalizeText(topicCategory);
  if (!normalizedTopicCategory) {
    return { kind: "invalid_topic_category" };
  }

  const liveSession = getPrechatSessionById(session.id) || session;
  const participants = getSessionParticipantProfiles(liveSession);
  const targetTwin =
    targetUserId === participants.initiator.userId ? participants.initiator : participants.counterparty;

  if (!ensureSensitiveCategoryAllowed(targetTwin, normalizedTopicCategory)) {
    const skippedSession = skipSensitiveTopicForSession(liveSession, normalizedTopicCategory, "skipped_by_profile");
    return {
      kind: "skipped_by_profile",
      session: skippedSession,
      summaryText: buildSensitiveApprovalSummaryText(normalizedTopicCategory, promptText, promptIntent)
    };
  }

  const entry = getSensitiveApprovalEntry(liveSession, normalizedTopicCategory);
  if (entry?.state === "approved") {
    return { kind: "already_approved", session: liveSession, entry };
  }

  if (["rejected", "skipped"].includes(normalizeText(entry?.state))) {
    const skippedSession = skipSensitiveTopicForSession(
      liveSession,
      normalizedTopicCategory,
      normalizeText(entry?.state) === "rejected" ? "already_rejected" : "already_skipped"
    );
    return { kind: "already_blocked", session: skippedSession, entry };
  }

  if (entry?.state === "pending" && entry?.requestId) {
    updatePrechatSession(liveSession.id, {
      status: "pending_sensitive_approval",
      control: buildSessionControlPatch(liveSession, {
        sensitiveApprovalLedger: buildSensitiveApprovalLedgerPatch(liveSession, normalizedTopicCategory, {
          lastPromptText: normalizeText(promptText) || entry.lastPromptText || null,
          promptIntent: normalizeText(promptIntent) || entry.promptIntent || null
        })
      })
    });
    return { kind: "already_pending", session: getPrechatSessionById(liveSession.id) || liveSession, entry };
  }

  const metadata = buildSensitiveApprovalRequestMetadata({
    source,
    turnNumber,
    promptIntent,
    topicCategory: normalizedTopicCategory,
    promptText,
    extra: extraMetadata
  });
  const request = createSensitiveQuestionRequest({
    sessionId: liveSession.id,
    roundId: round.id,
    requestingUserId,
    targetUserId,
    questionText: normalizeText(promptText) || metadata.summaryText,
    topicCategory: normalizedTopicCategory,
    metadata
  });

  updatePrechatSession(liveSession.id, {
    status: "pending_sensitive_approval",
    control: buildSessionControlPatch(liveSession, {
      sensitiveApprovalLedger: buildSensitiveApprovalLedgerPatch(liveSession, normalizedTopicCategory, {
        state: "pending",
        requestId: request.id,
        requestedAt: request.createdAt,
        resolvedAt: null,
        requestedByUserId: requestingUserId,
        targetUserId,
        lastPromptText: normalizeText(promptText) || null,
        resolutionSource: null,
        promptIntent: normalizeText(promptIntent) || null,
        skippedReason: null
      })
    })
  });

  return { kind: "created", request };
}

function buildAutomationControl(source = "legacy", preferredObjectiveKeys = []) {
  return {
    enabled: true,
    source: normalizeText(source) || "legacy",
    preferredObjectiveKeys: [...new Set((preferredObjectiveKeys || []).map((item) => normalizeText(item)).filter(Boolean))],
    activeTopicKey: null,
    lastClosedTopicKey: null,
    topicQueueSnapshot: [],
    topicLedger: normalizeTopicLedger(),
    startAttempts: 0,
    lastTrigger: null,
    lastFailureReason: null,
    lastFailureAt: null,
    lastStartedAt: null,
    runState: "idle",
    queuedTrigger: null,
    activeTrigger: null,
    lastCompletedAt: null,
    deferredRetry: null
  };
}

function buildInitialSessionControl({ source = "legacy", preferredObjectiveKeys = [] } = {}) {
  return {
    manualPause: {
      initiatorEnded: false,
      counterpartyEnded: false,
      messageCountByRole: {
        initiator: 0,
        counterparty: 0
      }
    },
    automation: buildAutomationControl(source, preferredObjectiveKeys)
  };
}

function mergeAutomationControl(session, { source = "legacy", preferredObjectiveKeys = [] } = {}) {
  const control = getSessionControl(session);
  const current = control.automation;
  const nextSource =
    normalizeText(source) === "report_plan" || current.source === "report_plan"
      ? "report_plan"
      : normalizeText(source) || current.source || "legacy";

  return buildSessionControlPatch(session, {
    automation: {
      enabled: true,
      source: nextSource,
      preferredObjectiveKeys: [
        ...new Set([
          ...current.preferredObjectiveKeys,
          ...(preferredObjectiveKeys || []).map((item) => normalizeText(item)).filter(Boolean)
        ])
      ]
    }
  });
}

function getPreferredObjectiveKeysForSession(session) {
  return getSessionControl(session).automation.preferredObjectiveKeys;
}

function getScopedObjectiveKeys(session, round = null) {
  const preferredKeys = getPreferredObjectiveKeysForSession(session)
    .map((item) => normalizeTopicKey(item))
    .filter(Boolean);
  if (preferredKeys.length) {
    return [...new Set(preferredKeys)];
  }

  const roundTopicKeys = Array.isArray(round?.objective?.topics)
    ? round.objective.topics.map((item) => normalizeTopicKey(item?.key)).filter(Boolean)
    : [];
  if (roundTopicKeys.length) {
    return [...new Set(roundTopicKeys)];
  }

  return [];
}

function getEffectiveScopedObjectiveKeys(session, round = null, objectives = []) {
  return [
    ...new Set([
      ...getScopedObjectiveKeys(session, round),
      ...((objectives || []).map((item) => normalizeTopicKey(item?.key)).filter(Boolean))
    ])
  ];
}

function getScopedActiveTopicKey(session, round = null, objectives = []) {
  const activeTopicKey = normalizeTopicKey(getSessionControl(session).automation.activeTopicKey);
  if (!activeTopicKey) {
    return null;
  }

  const scopedKeys = getEffectiveScopedObjectiveKeys(session, round, objectives);
  if (scopedKeys.length && !scopedKeys.includes(activeTopicKey)) {
    return null;
  }

  return activeTopicKey;
}

function getScopedTopicQueueSnapshot(session, round = null, objectives = []) {
  const rawQueue = Array.isArray(getSessionControl(session).automation.topicQueueSnapshot)
    ? getSessionControl(session).automation.topicQueueSnapshot
    : [];
  const queue = [...new Set(rawQueue.map((item) => normalizeTopicKey(item)).filter(Boolean))];
  const scopedKeys = getEffectiveScopedObjectiveKeys(session, round, objectives);
  if (!scopedKeys.length) {
    return queue;
  }

  return queue.filter((topicKey) => scopedKeys.includes(topicKey));
}

function getCanonicalScopedTopicKeys(session, round = null, objectives = [], ledger = null) {
  const resolvedLedger = normalizeTopicLedger(ledger || getSessionControl(session).automation.topicLedger);
  const scopedKeys = getEffectiveScopedObjectiveKeys(session, round, objectives);
  const orderedKeys = scopedKeys.length ? scopedKeys : TOPIC_CONFIG.map((topic) => topic.key);
  return orderedKeys.filter((topicKey) => getTopicEntry(resolvedLedger, topicKey)?.state !== "closed");
}

function getScopedObjectiveTopicDefinitions(session, round = null, objectives = []) {
  return getEffectiveScopedObjectiveKeys(session, round, objectives)
    .map((topicKey) => resolveObjectiveForTopic(objectives, topicKey))
    .filter(Boolean);
}

function ensureSessionPreferredObjectiveScope(session, round = null, fallbackObjectives = []) {
  if (!session?.id) {
    return session;
  }

  const currentPreferredKeys = getPreferredObjectiveKeysForSession(session)
    .map((item) => normalizeTopicKey(item))
    .filter(Boolean);
  if (currentPreferredKeys.length) {
    return session;
  }

  const scopedKeys = [
    ...getScopedObjectiveKeys(session, round),
    ...((fallbackObjectives || []).map((item) => normalizeTopicKey(item?.key)).filter(Boolean))
  ];
  if (!scopedKeys.length) {
    return session;
  }

  updatePrechatSession(session.id, {
    control: buildSessionControlPatch(session, {
      automation: {
        preferredObjectiveKeys: [...new Set(scopedKeys)]
      }
    })
  });
  return getPrechatSessionById(session.id) || session;
}

function getAutomationModeSource(session) {
  return getSessionControl(session).automation.source || "legacy";
}

function isAutomationEnabledForSession(session) {
  return Boolean(getSessionControl(session).automation.enabled);
}

function hasPendingHumanInput(detail) {
  return Boolean((detail?.humanInputRequests || []).some((item) => item.status === "pending"));
}

function hasPendingSensitiveApproval(detail) {
  return Boolean((detail?.sensitiveRequests || []).some((item) => item.status === "pending"));
}

function shouldBlockAutomation(detail) {
  if (!detail?.session) {
    return true;
  }

  if (!isAutomationEnabledForSession(detail.session)) {
    return true;
  }

  if (AUTOMATION_BLOCKING_STATUSES.has(detail.session.status)) {
    return true;
  }

  if (isManualPauseActive(detail.session)) {
    return true;
  }

  return hasPendingHumanInput(detail) || hasPendingSensitiveApproval(detail);
}

function hasVisibleConversationContent(detail) {
  return Boolean((detail?.turns || []).length > 0);
}

function sessionNeedsAutomationBootstrap(detail) {
  return Boolean(detail?.session) && !detail.session.currentRound && !hasVisibleConversationContent(detail);
}

function deriveAutomationIntent(detail, trigger) {
  const normalizedTrigger = normalizeText(trigger) || "unknown";
  if (!detail?.session) {
    return {
      intent: "no_op",
      reason: "session_missing"
    };
  }

  const turns = detail.turns || [];
  const latestRound = getLatestRoundFromDetail(detail);
  const hasTwinTurns = hasAnyTwinTurn(detail.session, turns);
  const deferredRetry = getSessionControl(detail.session).automation.deferredRetry;
  const hasActiveRound =
    latestRound?.status === "active" &&
    ["active", "paused_review"].includes(detail.session.status);

  if (hasActiveRound) {
    return {
      intent: "resume_active_round",
      reason: normalizedTrigger === "deferred_model_retry" ? "deferred_model_retry_active_round" : "active_round_exists",
      round: latestRound
    };
  }

  const outstandingRecovery =
    getOutstandingTwinQuestionRecovery(detail) ||
    (normalizedTrigger === "stuck_unanswered_twin_question"
      ? getSessionWideOutstandingTwinQuestionRecovery(detail)
      : null);

  if (outstandingRecovery) {
    return {
      intent: "answer_outstanding_question",
      reason: "outstanding_twin_question",
      outstandingRecovery
    };
  }

  if (
    normalizedTrigger === "deferred_model_retry" &&
    deferredRetry?.kind === "model_output_unstable" &&
    ["active", "paused_review"].includes(detail.session.status)
  ) {
    if (latestRound?.status === "active") {
      return {
        intent: "resume_active_round",
        reason: "deferred_model_retry_active_round",
        round: latestRound
      };
    }

    if (!hasTwinTurns && sessionNeedsAutomationBootstrap(detail)) {
      return {
        intent: "bootstrap_opening",
        reason: "deferred_model_retry_bootstrap"
      };
    }

    return {
      intent: "resume_active_round",
      reason: "deferred_model_retry_resume"
    };
  }

  if (!hasTwinTurns && sessionNeedsAutomationBootstrap(detail)) {
    return {
      intent: "bootstrap_opening",
      reason: normalizedTrigger === "accept_invitation" ? "accept_invitation_bootstrap" : "fresh_opening"
    };
  }

  if (
    [
      "submit_human_input",
      "manual_message",
      "resume_manual_pause",
      "manual_message_question",
      "approve_sensitive",
      "reject_sensitive"
    ].includes(normalizedTrigger) &&
    ["active", "paused_review"].includes(detail.session.status)
  ) {
    return {
      intent: "resume_active_round",
      reason: normalizedTrigger
    };
  }

  return {
    intent: "no_op",
    reason: "no_automation_path"
  };
}

function shouldSuppressRoundStart(detail, automationIntent = null) {
  const intent = normalizeText(automationIntent?.intent);
  if (!intent) {
    return {
      suppress: false,
      reason: null
    };
  }

  if (!detail?.session) {
    return {
      suppress: true,
      reason: "session_missing"
    };
  }

  const latestRound = getLatestRoundFromDetail(detail);
  if (latestRound?.status === "active") {
    return {
      suppress: false,
      reason: null
    };
  }

  const turns = collapseAdjacentDuplicateTwinTurns(detail.turns || []);
  const latestTwinTurn = [...turns].reverse().find((turn) => String(turn?.actorRole || "").endsWith("_twin")) || null;
  if (
    intent === "bootstrap_opening" &&
    latestTwinTurn &&
    normalizeText(latestTwinTurn.content)
  ) {
    return {
      suppress: true,
      reason: "opening_already_emitted"
    };
  }

  if (
    intent === "answer_outstanding_question" &&
    automationIntent.outstandingRecovery?.sourceTurn &&
    latestTwinTurn &&
    isEquivalentTwinQuestionTurn(latestTwinTurn, automationIntent.outstandingRecovery.sourceTurn)
  ) {
    return {
      suppress: true,
      reason: "outstanding_question_already_latest"
    };
  }

  return {
    suppress: false,
    reason: null
  };
}

function getLatestRoundFromDetail(detail) {
  return Array.isArray(detail?.rounds) && detail.rounds.length ? detail.rounds[detail.rounds.length - 1] : null;
}

function isSessionStatusDriftedFromLatestRound(detail) {
  const session = detail?.session;
  const latestRound = getLatestRoundFromDetail(detail);

  if (!session || !latestRound) {
    return false;
  }

  return (
    session.status === "active" &&
    latestRound.status === "completed" &&
    ["paused_review", "outstanding_twin_question_unanswered", "max_turns_reached", "objectives_completed"].includes(
      normalizeText(latestRound.stopReason)
    )
  );
}

function reconcileSessionStatusFromLatestRound(sessionId, currentUserId) {
  const detail = getSessionDetailForUser(sessionId, currentUserId);

  if (!detail || !isSessionStatusDriftedFromLatestRound(detail)) {
    return false;
  }

  updatePrechatSession(sessionId, { status: "paused_review" });
  return true;
}

function markAutomationState(sessionId, patch = {}) {
  const session = getPrechatSessionById(sessionId);

  if (!session) {
    return null;
  }

  const nextControl = buildSessionControlPatch(session, {
    automation: patch
  });
  updatePrechatSession(sessionId, { control: nextControl });
  return getPrechatSessionById(sessionId);
}

function getDeferredRetryDelayMs(attemptCount = 0) {
  const delays = getDeferredRetryDelaysMs();
  const index = Math.min(Math.max(0, attemptCount), delays.length - 1);
  return delays[index];
}

function getDeferredRetryDelayMsForProfile(profile, attemptCount = 0) {
  if (normalizeText(profile) === "opening_bootstrap") {
    const delays = getOpeningDeferredRetryDelaysMs();
    const index = Math.min(Math.max(0, attemptCount), delays.length - 1);
    return delays[index];
  }
  return getDeferredRetryDelayMs(attemptCount);
}

function buildDeferredRetryTimerKey(sessionId, kind) {
  return `${sessionId}:${normalizeText(kind) || "unknown"}`;
}

function cancelDeferredAutomationRetry(sessionId, kind = null) {
  const normalizedKind = normalizeText(kind);
  for (const [key, timer] of deferredAutomationRetryTimers.entries()) {
    if (!key.startsWith(`${sessionId}:`)) {
      continue;
    }
    if (normalizedKind && key !== buildDeferredRetryTimerKey(sessionId, normalizedKind)) {
      continue;
    }
    clearTimeout(timer.timeoutId);
    deferredAutomationRetryTimers.delete(key);
  }
}

export function clearInMemoryPrechatAutomationState() {
  for (const timer of deferredAutomationRetryTimers.values()) {
    clearTimeout(timer.timeoutId);
  }
  deferredAutomationRetryTimers.clear();
  automationQueues.clear();
  automationLocks.clear();
}

function isPureModelOutputFailureResult(result) {
  if (!result || typeof result !== "object") {
    return false;
  }

  const failureKind = normalizeText(result.model_output_failure?.kind);
  const failureReason = normalizeText(result.model_output_failure?.reason);
  return Boolean(
    failureKind === "turn_fallback" ||
      failureReason === "model_output_unstable"
  );
}

function isDeferredRetryEligibleStopReason(stopReason) {
  return ["empty_reply_with_continue", "auto_start_failed", "deferred_model_retry"].includes(normalizeText(stopReason));
}

function shouldUseDeferredRetryForGuardFailure(stopReason, result = null) {
  const normalizedStopReason = normalizeText(stopReason);
  if (normalizedStopReason === "empty_reply_with_continue") {
    return true;
  }
  return normalizedStopReason === "auto_start_failed" && isPureModelOutputFailureResult(result);
}

function shouldUseDeferredRetryForTurnResult(result) {
  return isPureModelOutputFailureResult(result);
}

function isDeferredRetrySuppressedByTrigger(trigger) {
  return ["run_round"].includes(normalizeText(trigger));
}

function buildModelOutputDeferredRetryOptions({
  trigger = null,
  automationIntent = null,
  sourceRoundId = null,
  sourceTurnNumber = 0
} = {}) {
  return {
    reason: "model_output_unstable",
    sourceRoundId,
    sourceTurnNumber,
    sourceTrigger: trigger || null,
    sourceIntent: automationIntent?.intent || null,
    profile: "opening_bootstrap",
    allowExhaustion: false,
    windowMs: getOpeningDeferredRetryTotalWindowMs()
  };
}

function isRecoverablePureModelFailurePause(detail) {
  const session = detail?.session;
  if (!session || session.status !== "paused_review") {
    return false;
  }

  if (isManualPauseActive(session) || hasPendingHumanInput(detail) || hasPendingSensitiveApproval(detail)) {
    return false;
  }

  const latestRound = getLatestRoundFromDetail(detail);
  const latestStopReason = normalizeText(latestRound?.stopReason);
  const lastFailureReason = normalizeText(getSessionControl(session).automation.lastFailureReason);
  const deferredRetry = getDeferredRetryState(session);

  if (deferredRetry?.kind) {
    return false;
  }

  const pureModelPauseByRound = isDeferredRetryEligibleStopReason(latestStopReason);
  const pureModelPauseByFailure =
    lastFailureReason === "model_output_unstable" || lastFailureReason === "auto_start_failed";

  return pureModelPauseByRound || pureModelPauseByFailure;
}

async function autoRecoverPureModelFailurePausedSession(sessionId, currentUserId) {
  const detail = getSessionDetailForUser(sessionId, currentUserId);
  if (!detail || !isRecoverablePureModelFailurePause(detail)) {
    return false;
  }

  const latestRound = getLatestRoundFromDetail(detail);
  const automationIntent = deriveAutomationIntent(detail, "deferred_model_retry");
  const sourceRoundId = latestRound?.id || null;
  const sourceTurnNumber = getLatestTurnNumber(sourceRoundId) || 0;
  const deferredRetry = buildDeferredRetryState(detail.session, {
    ...buildModelOutputDeferredRetryOptions({
      trigger: "deferred_model_retry",
      automationIntent,
      sourceRoundId,
      sourceTurnNumber
    })
  });

  updatePrechatSession(sessionId, {
    status: "active",
    control: buildSessionControlPatch(detail.session, {
      automation: {
        lastTrigger: "deferred_model_retry",
        lastFailureReason: "model_output_unstable",
        lastFailureAt: nowIso(),
        deferredRetry
      }
    })
  });

  scheduleDeferredAutomationRetry(sessionId, currentUserId, deferredRetry);
  return true;
}

async function scheduleSilentModelRetry({
  session,
  currentUserId,
  trigger,
  automationIntent = null,
  sourceRoundId = null,
  sourceTurnNumber = 0,
  profile = null,
  allowExhaustion = undefined,
  windowMs = undefined
} = {}) {
  if (!session?.id) {
    return null;
  }

  const deferredRetry = buildDeferredRetryState(session, {
    ...buildModelOutputDeferredRetryOptions({
      trigger: trigger || getSessionControl(session).automation.lastTrigger || null,
      automationIntent,
      sourceRoundId,
      sourceTurnNumber
    }),
    ...(profile ? { profile } : {}),
    ...(typeof allowExhaustion === "boolean" ? { allowExhaustion } : {}),
    ...(windowMs !== undefined ? { windowMs } : {})
  });

  if (shouldExhaustDeferredRetry(deferredRetry)) {
    return null;
  }

  await scheduleDeferredModelRetry({
    sessionId: session.id,
    currentUserId,
    trigger,
    automationIntent,
    reason: "model_output_unstable",
    sourceRoundId,
    sourceTurnNumber,
    profile,
    allowExhaustion,
    windowMs
  });

  return deferredRetry;
}

async function scheduleDeferredModelRetry({
  sessionId,
  currentUserId,
  trigger,
  automationIntent = null,
  reason = "model_output_unstable",
  sourceRoundId = null,
  sourceTurnNumber = 0,
  profile = null,
  allowExhaustion = undefined,
  windowMs = undefined
} = {}) {
  const session = getPrechatSessionById(sessionId);
  if (!session) {
    return null;
  }

  const deferredRetry = buildDeferredRetryState(session, {
    ...buildModelOutputDeferredRetryOptions({
      trigger: trigger || getSessionControl(session).automation.lastTrigger || null,
      automationIntent,
      sourceRoundId,
      sourceTurnNumber
    }),
    reason,
    ...(profile ? { profile } : {}),
    ...(typeof allowExhaustion === "boolean" ? { allowExhaustion } : {}),
    ...(windowMs !== undefined ? { windowMs } : {})
  });

  updatePrechatSession(sessionId, {
    status: "active",
    control: buildSessionControlPatch(session, {
      automation: {
        lastTrigger: trigger || getSessionControl(session).automation.lastTrigger || null,
        lastFailureReason: normalizeText(reason) || "model_output_unstable",
        lastFailureAt: nowIso(),
        deferredRetry
      }
    })
  });

  scheduleDeferredAutomationRetry(sessionId, currentUserId, deferredRetry);
  return deferredRetry;
}

function getDeferredRetryState(session) {
  return getSessionControl(session).automation.deferredRetry;
}

function shouldCancelDeferredRetryForDetail(detail) {
  if (!detail?.session) {
    return true;
  }

  if (isManualPauseActive(detail.session)) {
    return true;
  }

  if (hasPendingHumanInput(detail) || hasPendingSensitiveApproval(detail)) {
    return true;
  }

  return ["awaiting_counterparty_acceptance", "rejected", "blocked_risk", "pending_human_input", "pending_sensitive_approval"].includes(
    detail.session.status
  );
}

function clearDeferredRetryState(sessionId) {
  const session = getPrechatSessionById(sessionId);
  if (!session) {
    cancelDeferredAutomationRetry(sessionId);
    return null;
  }

  const deferredRetry = getDeferredRetryState(session);
  if (deferredRetry?.kind) {
    cancelDeferredAutomationRetry(sessionId, deferredRetry.kind);
  } else {
    cancelDeferredAutomationRetry(sessionId);
  }

  updatePrechatSession(sessionId, {
    control: buildSessionControlPatch(session, {
      automation: {
        deferredRetry: null
      }
    })
  });
  return getPrechatSessionById(sessionId);
}

function scheduleDeferredAutomationRetry(sessionId, currentUserId, deferredRetry) {
  const normalized = normalizeDeferredRetryState(deferredRetry);
  if (!normalized?.kind) {
    return;
  }

  const key = buildDeferredRetryTimerKey(sessionId, normalized.kind);
  const existing = deferredAutomationRetryTimers.get(key);
  const nextRetryAtMs = Date.parse(normalized.nextRetryAt || "");
  const delayMs = Number.isFinite(nextRetryAtMs) ? Math.max(0, nextRetryAtMs - Date.now()) : 0;

  if (existing) {
    clearTimeout(existing.timeoutId);
    deferredAutomationRetryTimers.delete(key);
  }

  const timeoutId = setTimeout(() => {
    deferredAutomationRetryTimers.delete(key);

    try {
      const detail = getSessionDetailForUser(sessionId, currentUserId);
      if (!detail || shouldCancelDeferredRetryForDetail(detail)) {
        clearDeferredRetryState(sessionId);
        return;
      }

      const liveSession = getPrechatSessionById(sessionId);
      if (!liveSession) {
        return;
      }

      const liveRetry = getDeferredRetryState(liveSession);
      if (!liveRetry || liveRetry.kind !== normalized.kind) {
        return;
      }

      if (shouldExhaustDeferredRetry(liveRetry)) {
        clearDeferredRetryState(sessionId);
        handleAutomationStartFailure(
          sessionId,
          currentUserId,
          normalizeText(liveRetry.sourceTrigger) || "deferred_model_retry",
          "auto_start_failed"
        ).catch(() => {});
        return;
      }

      updatePrechatSession(sessionId, {
        control: buildSessionControlPatch(liveSession, {
          automation: {
            deferredRetry: {
              ...liveRetry,
              lastRetryAt: nowIso()
            }
          }
        })
      });
      scheduleSessionAutomation(sessionId, currentUserId, "deferred_model_retry");
    } catch (error) {
      const errorText = normalizeText(error?.message || error?.errstr || "");
      const isSqliteLockedError =
        normalizeText(error?.code) === "err_sqlite_error" &&
        (Number(error?.errcode) === 5 || errorText.includes("database is locked"));

      if (!isSqliteLockedError) {
        console.error("[prechat] deferred retry timer failed", error);
        return;
      }

      scheduleDeferredAutomationRetry(sessionId, currentUserId, {
        ...normalized,
        nextRetryAt: new Date(Date.now() + 2000).toISOString()
      });
    }
  }, delayMs);

  deferredAutomationRetryTimers.set(key, {
    sessionId,
    kind: normalized.kind,
    currentUserId,
    timeoutId,
    nextRetryAt: normalized.nextRetryAt || null
  });
}

function buildDeferredRetryState(session, options = {}) {
  const current = getDeferredRetryState(session);
  const now = Date.now();
  const firstFailedAt = normalizeText(current?.firstFailedAt) || nowIso();
  const sourceIntent = normalizeText(options.sourceIntent) || normalizeText(current?.sourceIntent) || null;
  const inferredProfileFromIntent = sourceIntent === "bootstrap_opening" ? "opening_bootstrap" : null;
  const currentProfile = normalizeText(current?.profile) || "default";
  const profile =
    normalizeText(options.profile) ||
    inferredProfileFromIntent ||
    currentProfile ||
    "default";
  const attemptCount = Math.max(1, Number(current?.attemptCount || 0) + 1);
  const maxAttempts = Math.max(1, Number(options.maxAttempts || current?.maxAttempts || getDeferredRetryMaxAttempts()));
  const profileChanged = currentProfile && currentProfile !== profile;
  const allowExhaustion =
    typeof options.allowExhaustion === "boolean"
      ? options.allowExhaustion
      : !profileChanged && typeof current?.allowExhaustion === "boolean"
        ? current.allowExhaustion
        : profile !== "opening_bootstrap";
  const windowMs = Math.max(
    1000,
    Number(
      options.windowMs ??
      (!profileChanged ? current?.windowMs : null) ??
      (profile === "opening_bootstrap" ? getOpeningDeferredRetryTotalWindowMs() : getDeferredRetryTotalWindowMs())
    ) || 0
  );
  const delayMs = getDeferredRetryDelayMsForProfile(profile, attemptCount - 1);
  const nextRetryAt = new Date(now + delayMs).toISOString();

  return normalizeDeferredRetryState({
    kind: "model_output_unstable",
    reason: normalizeText(options.reason) || "model_output_unstable",
    profile,
    attemptCount,
    maxAttempts,
    allowExhaustion,
    windowMs,
    firstFailedAt,
    nextRetryAt,
    lastRetryAt: normalizeText(current?.lastRetryAt) || null,
    sourceRoundId: options.sourceRoundId || current?.sourceRoundId || null,
    sourceTurnNumber: options.sourceTurnNumber ?? current?.sourceTurnNumber ?? 0,
    sourceTrigger: options.sourceTrigger || current?.sourceTrigger || null,
    sourceIntent
  });
}

function shouldExhaustDeferredRetry(deferredRetry) {
  if (!deferredRetry) {
    return false;
  }

  if (deferredRetry.allowExhaustion === false) {
    return false;
  }

  if (Number(deferredRetry.attemptCount || 0) >= Number(deferredRetry.maxAttempts || getDeferredRetryMaxAttempts())) {
    return true;
  }

  const firstFailedAtMs = Date.parse(deferredRetry.firstFailedAt || "");
  if (!Number.isFinite(firstFailedAtMs)) {
    return false;
  }

  return Date.now() - firstFailedAtMs >= Math.max(1000, Number(deferredRetry.windowMs || getDeferredRetryTotalWindowMs()));
}

function maybeTriggerDeferredRetryOnSessionView(sessionId, currentUserId) {
  const session = getPrechatSessionById(sessionId);
  if (!session) {
    return;
  }

  const deferredRetry = getDeferredRetryState(session);
  if (!deferredRetry?.kind) {
    return;
  }

  const nextRetryAtMs = Date.parse(deferredRetry.nextRetryAt || "");
  if (!Number.isFinite(nextRetryAtMs) || nextRetryAtMs > Date.now()) {
    scheduleDeferredAutomationRetry(sessionId, currentUserId, deferredRetry);
    return;
  }

  const detail = getSessionDetailForUser(sessionId, currentUserId);
  if (!detail || shouldCancelDeferredRetryForDetail(detail)) {
    clearDeferredRetryState(sessionId);
    return;
  }

  updatePrechatSession(sessionId, {
    control: buildSessionControlPatch(session, {
      automation: {
        deferredRetry: {
          ...deferredRetry,
          lastRetryAt: nowIso()
        }
      }
    })
  });
  scheduleSessionAutomation(sessionId, currentUserId, "deferred_model_retry");
}

function getAutomationRunState(session) {
  return getSessionControl(session).automation.runState || "idle";
}

function createAutomationLock(sessionId) {
  const existing = automationLocks.get(sessionId);

  if (existing) {
    return existing;
  }

  let release = null;
  const promise = new Promise((resolve) => {
    release = () => {
      automationLocks.delete(sessionId);
      resolve();
    };
  });

  const lock = { promise, release };
  automationLocks.set(sessionId, lock);
  return lock;
}

async function withSessionAutomationLock(sessionId, work) {
  while (automationLocks.has(sessionId)) {
    await automationLocks.get(sessionId).promise;
  }

  const lock = createAutomationLock(sessionId);

  try {
    return await work();
  } finally {
    lock.release();
  }
}

function queueSessionAutomation(sessionId, currentUserId, trigger) {
  const normalizedTrigger = normalizeText(trigger) || "unknown";
  const existing = automationQueues.get(sessionId);

  if (existing) {
    existing.needsRerun = true;
    existing.currentUserId = currentUserId;
    existing.trigger = normalizedTrigger;
    markAutomationState(sessionId, {
      runState: "queued",
      queuedTrigger: normalizedTrigger
    });
    return existing.promise;
  }

  markAutomationState(sessionId, {
    runState: "queued",
    queuedTrigger: normalizedTrigger,
    activeTrigger: null,
    lastTrigger: normalizedTrigger,
    lastFailureReason: null,
    lastFailureAt: null
  });

  const task = {
    currentUserId,
    trigger: normalizedTrigger,
    needsRerun: false,
    promise: null
  };

  task.promise = (async () => {
    try {
      do {
        const triggerToRun = task.trigger;
        const userIdToRun = task.currentUserId;
        task.needsRerun = false;

        markAutomationState(sessionId, {
          runState: "running",
          queuedTrigger: null,
          activeTrigger: triggerToRun,
          lastTrigger: triggerToRun,
          lastStartedAt: new Date().toISOString()
        });

        try {
          await ensureSessionAutomationProgress(sessionId, userIdToRun, triggerToRun);
          markAutomationState(sessionId, {
            runState: task.needsRerun ? "queued" : "idle",
            queuedTrigger: task.needsRerun ? task.trigger : null,
            activeTrigger: null,
            lastCompletedAt: task.needsRerun ? null : new Date().toISOString()
          });
        } catch (error) {
          markAutomationState(sessionId, {
            runState: "failed",
            queuedTrigger: null,
            activeTrigger: null,
            lastFailureReason: normalizeText(error?.message) || "automation_failed",
            lastFailureAt: new Date().toISOString()
          });
          throw error;
        }
      } while (task.needsRerun);
    } finally {
      automationQueues.delete(sessionId);
      const liveSession = getPrechatSessionById(sessionId);
      if (liveSession && getAutomationRunState(liveSession) === "queued") {
        markAutomationState(sessionId, {
          runState: "idle",
          queuedTrigger: null,
          activeTrigger: null,
          lastCompletedAt: new Date().toISOString()
        });
      }
    }
  })();

  automationQueues.set(sessionId, task);
  return task.promise;
}

function scheduleSessionAutomation(sessionId, currentUserId, trigger) {
  queueSessionAutomation(sessionId, currentUserId, trigger).catch(() => {});
}

function getLatestRoundForSession(sessionId) {
  const rounds = listPrechatRounds(sessionId);
  return rounds.length ? rounds[rounds.length - 1] : null;
}

function findPendingManualMessageTurn(sessionId) {
  return (
    listConversationTurns(sessionId).find((turn) => {
      const metadata = turn?.metadata && typeof turn.metadata === "object" ? turn.metadata : {};
      return isHumanUserTurn(turn) && Boolean(metadata.manualMessage) && Boolean(metadata.automationPending);
    }) || null
  );
}

function hasPendingManualMessageTurn(sessionId) {
  return Boolean(findPendingManualMessageTurn(sessionId));
}

function markManualMessageTurnProcessed(turnId, patch = {}) {
  const turn = getConversationTurnById(turnId);

  if (!turn) {
    return null;
  }

  const metadata = {
    ...(turn.metadata && typeof turn.metadata === "object" ? turn.metadata : {}),
    automationPending: false,
    automationProcessedAt: new Date().toISOString(),
    ...patch
  };

  return updateConversationTurn(turnId, { metadata });
}

function addAutomationSystemTurn(session, content, metadata = {}) {
  const round =
    getLatestRoundForSession(session.id) ||
    createPrechatRound({
      sessionId: session.id,
      roundNumber: session.currentRound > 0 ? session.currentRound : 1,
      objective: {
        topics: []
      }
    });

  const turnNumber = getLatestTurnNumber(round.id) + 1;

  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber,
    actorUserId: null,
    actorRole: "system",
    content,
    metadata
  });

  if (!session.currentRound) {
    updatePrechatSession(session.id, { currentRound: round.roundNumber });
  }

  return round;
}

function ensureTurnBelongsToSession(turn, sessionId) {
  if (!turn || turn.sessionId !== sessionId) {
    throw new Error("未找到该消息。");
  }
}

function getQuotedTurnPayload(sessionId, quotedTurnId, currentUserId) {
  if (!quotedTurnId) {
    return null;
  }

  const turn = getConversationTurnById(quotedTurnId);
  ensureTurnBelongsToSession(turn, sessionId);
  const session = getPrechatSessionById(sessionId);
  const visibleTurn = buildVisibleTurn(turn, session, currentUserId, new Map([[turn.id, turn]]));

  if (!visibleTurn || !visibleTurn.canQuote) {
    throw new Error("这条消息当前不能被引用。");
  }

  return buildQuotedPreview(turn, session, currentUserId);
}

function assertSessionParticipant(session, currentUserId) {
  if (!session || ![session.initiatorUserId, session.counterpartyUserId].includes(currentUserId)) {
    throw new Error("未找到该预沟通会话。");
  }
}

function assertOwnHumanTurn(turn, currentUserId) {
  if (!turn || !isHumanUserTurn(turn) || turn.actorUserId !== currentUserId) {
    throw new Error("只能操作自己发送的真人消息。");
  }
}

function assertTurnVisibleToUser(turn, currentUserId) {
  const metadata = normalizeMessageMetadata(turn?.metadata);

  if (metadata.deletedForUserIds.includes(currentUserId)) {
    throw new Error("这条消息已从你的会话中删除。");
  }

  return metadata;
}

function toggleTurnReaction(turn, currentUserId, emoji) {
  if (!MESSAGE_REACTION_OPTIONS.includes(emoji)) {
    throw new Error("只支持固定的消息反应。");
  }

  const metadata = normalizeMessageMetadata(turn.metadata);
  const nextReactions = metadata.reactions.filter((item) => item.userId !== currentUserId);
  const existing = metadata.reactions.find((item) => item.userId === currentUserId);

  if (!existing || existing.emoji !== emoji) {
    nextReactions.push({ userId: currentUserId, emoji });
  }

  return updateConversationTurn(turn.id, {
    metadata: {
      ...metadata,
      reactions: nextReactions
    }
  });
}

function buildDefaultTopicLedger() {
  return normalizeTopicLedger();
}

function getTopicEntry(ledger, topicKey) {
  const normalizedTopicKey = normalizeTopicKey(topicKey);
  if (!normalizedTopicKey) {
    return null;
  }

  return normalizeTopicLedgerEntry(normalizedTopicKey, ledger?.[normalizedTopicKey]) || null;
}

function patchTopicLedger(ledger, topicKey, patch = {}) {
  const normalizedTopicKey = normalizeTopicKey(topicKey);
  if (!normalizedTopicKey) {
    return normalizeTopicLedger(ledger);
  }

  return normalizeTopicLedger({
    ...normalizeTopicLedger(ledger),
    [normalizedTopicKey]: {
      ...getTopicEntry(ledger, normalizedTopicKey),
      ...patch
    }
  });
}

function getTopicLabel(topicKey) {
  return TOPIC_CONFIG.find((item) => item.key === topicKey)?.label || topicKey;
}

function getContradictionPatterns(topicKey) {
  switch (topicKey) {
    case "childrenPreference":
      return [
        [/不要孩子|不想要孩子|丁克/u, "negative"],
        [/要孩子|想要孩子|希望.*孩子/u, "positive"]
      ];
    case "cities":
      return [];
    case "relationshipGoal":
      return [
        [/认真长期|结婚/u, "serious"],
        [/先了解|随缘|不着急/u, "exploratory"]
      ];
    case "marriageTimeline":
      return [
        [/1\s*(?:到|-|至)\s*2年|两年内|2年内/u, "fast"],
        [/3\s*(?:到|-|至)\s*5年|三到五年|慢慢来/u, "slow"]
      ];
    default:
      return [];
  }
}

function classifyFactSemanticBucket(topicKey, value) {
  const text = normalizeText(value);
  if (!text) {
    return null;
  }

  const patterns = getContradictionPatterns(topicKey);
  for (const [pattern, bucket] of patterns) {
    if (pattern.test(text)) {
      return bucket;
    }
  }

  return text;
}

function latestConfirmedFactForTopic(session, facts = [], topicKey, subjectUserId) {
  const normalizedTopicKey = normalizeTopicKey(topicKey);
  if (!normalizedTopicKey) {
    return null;
  }

  const filtered = facts.filter(
    (fact) =>
      fact.key === normalizedTopicKey &&
      String(fact.status || "confirmed") === "confirmed" &&
      normalizeObjectiveSubjectRole(session, fact.subjectUserId) === normalizeObjectiveSubjectRole(session, subjectUserId)
  );

  return filtered.length ? filtered[filtered.length - 1] : null;
}

function humanTurnSignalsTopicReopen(session, topicKey, turn, facts = []) {
  if (!isHumanUserTurn(turn)) {
    return false;
  }

  const normalizedTopicKey = normalizeTopicKey(topicKey);
  if (!normalizedTopicKey) {
    return false;
  }

  const hintedTopic =
    normalizeTopicKey(turn?.metadata?.fieldKey) ||
    normalizeTopicKey(turn?.metadata?.questionTopic) ||
    inferTopicKeyFromText(turn?.content);

  if (hintedTopic !== normalizedTopicKey) {
    return false;
  }

  const latestFact = latestConfirmedFactForTopic(session, facts, normalizedTopicKey, turn.actorUserId);
  if (!latestFact) {
    return false;
  }

  const previousBucket = classifyFactSemanticBucket(normalizedTopicKey, latestFact.value);
  const currentBucket = classifyFactSemanticBucket(normalizedTopicKey, turn.content);

  return Boolean(previousBucket && currentBucket && previousBucket !== currentBucket);
}

function rebuildTopicLedgerFromSession(session, turns = [], facts = [], objectives = []) {
  const currentLedger = normalizeTopicLedger(getSessionControl(session).automation.topicLedger);
  const ledger = {
    ...buildDefaultTopicLedger(),
    ...currentLedger
  };
  const topicScope = [...new Set([...TOPIC_CONFIG.map((item) => item.key), ...(objectives || []).map((item) => item.key)])];
  const resolvedTurns = collapseAdjacentDuplicateTwinTurns(turns || [])
    .map((turn) => canonicalizeHistoricalTwinTurn(turn, session, turns || []));

  for (const topicKey of topicScope) {
    const coverage = getObjectiveCoverage(session, facts, topicKey);
    ledger[topicKey] = {
      ...ledger[topicKey],
      coverage
    };

    if (coverage.initiator && coverage.counterparty) {
      ledger[topicKey] = {
        ...ledger[topicKey],
        state: "closed",
        pendingAnswerUserId: null,
        closedAt:
          ledger[topicKey].closedAt ||
          [...facts]
            .reverse()
            .find((fact) => fact.key === topicKey && String(fact.status || "confirmed") === "confirmed")?.createdAt ||
          null
      };
    } else if (currentLedger[topicKey]?.state === "closed") {
      ledger[topicKey] = {
        ...ledger[topicKey],
        state: "closed",
        pendingAnswerUserId: null,
        closedAt: currentLedger[topicKey]?.closedAt || ledger[topicKey]?.closedAt || null
      };
    }
  }

  for (const turn of resolvedTurns) {
    if (!turn?.actorUserId) {
      continue;
    }

    const normalizedMetadata = normalizeMessageMetadata(turn.metadata || {});
    if (String(turn.actorRole || "").endsWith("_twin") && !isTrustedCanonicalTwinTurn(turn)) {
      continue;
    }
    const inferredQuestionTopic =
      normalizeTopicKey(normalizedMetadata.canonical_question_topic_key) ||
      normalizeTopicKey(normalizedMetadata.emitted_question_topic_key) ||
      normalizeTopicKey(normalizedMetadata.question_topic_key) ||
      normalizeTopicKey(turn?.metadata?.questionTopic) ||
      inferTopicKeyFromText(turn.content);
    const inferredReplyTopic =
      normalizeTopicKey(normalizedMetadata.canonical_reply_topic_key) ||
      normalizeTopicKey(normalizedMetadata.emitted_reply_topic_key) ||
      normalizeTopicKey(normalizedMetadata.reply_topic_key) ||
      normalizeTopicKey(turn?.metadata?.replyTopic) ||
      normalizeTopicKey(turn?.metadata?.fieldKey) ||
      inferTopicKeyFromText(turn.content);

    if (isHumanUserTurn(turn) && inferredReplyTopic && humanTurnSignalsTopicReopen(session, inferredReplyTopic, turn, facts)) {
      ledger[inferredReplyTopic] = {
        ...ledger[inferredReplyTopic],
        state: "reopened_by_human",
        pendingAnswerUserId: null,
        closedAt: null,
        reopenReason: "human_contradiction",
        reopenedAt: turn.createdAt
      };
    }

    if (String(turn.actorRole || "").endsWith("_twin") && textLooksLikeQuestion(turn.content) && inferredQuestionTopic) {
      const targetUserId =
        turn.actorUserId === session.initiatorUserId ? session.counterpartyUserId : session.initiatorUserId;
      if (ledger[inferredQuestionTopic]?.state !== "closed") {
        ledger[inferredQuestionTopic] = {
          ...ledger[inferredQuestionTopic],
          state: targetUserId === session.initiatorUserId ? "waiting_initiator" : "waiting_counterparty",
          pendingAnswerUserId: targetUserId,
          lastQuestionTurnId: turn.id,
          lastQuestionFingerprint: getCanonicalQuestionFingerprintFromMetadata(normalizedMetadata, turn.content)
        };
      }
    }

    if (inferredReplyTopic && ledger[inferredReplyTopic]?.state !== "closed") {
      const role = normalizeObjectiveSubjectRole(session, turn.actorUserId);
      const currentEntry = ledger[inferredReplyTopic];
      if (role) {
        ledger[inferredReplyTopic] = {
          ...currentEntry,
          coverage: {
            ...currentEntry.coverage,
            [role]: currentEntry.coverage[role] || Boolean(
              latestConfirmedFactForTopic(session, facts, inferredReplyTopic, turn.actorUserId)
            )
          },
          pendingAnswerUserId:
            currentEntry.pendingAnswerUserId === turn.actorUserId
              ? role === "initiator"
                ? session.counterpartyUserId
                : session.initiatorUserId
              : currentEntry.pendingAnswerUserId || null,
          state:
            currentEntry.pendingAnswerUserId === turn.actorUserId
              ? role === "initiator"
                ? "waiting_counterparty"
                : "waiting_initiator"
              : currentEntry.state
        };
      }
    }
  }

  for (const topicKey of topicScope) {
    const entry = ledger[topicKey];
    if (entry.coverage.initiator && entry.coverage.counterparty) {
      ledger[topicKey] = {
        ...entry,
        state: "closed",
        pendingAnswerUserId: null,
        closedAt: entry.closedAt || new Date().toISOString()
      };
    }
  }

  return normalizeTopicLedger(ledger);
}

function getTopicQueueSnapshot(session, objectives = [], ledger = {}) {
  return getCanonicalScopedTopicKeys(session, null, objectives, ledger);
}

function chooseNextActiveTopicFromLedger(session, objectives = [], ledger = {}) {
  const queue = getTopicQueueSnapshot(session, objectives, ledger);
  return queue.length ? queue[0] : null;
}

function getTopicLedgerStateLabel(session, topicKey, ledger = {}) {
  const entry = getTopicEntry(ledger, topicKey);
  if (!entry) {
    return "unresolved";
  }

  if (entry.state === "closed") {
    return "confirmed";
  }

  if (entry.state === "waiting_initiator" || entry.state === "waiting_counterparty" || entry.state === "reopened_by_human") {
    return "pending";
  }

  if (entry.coverage.initiator || entry.coverage.counterparty) {
    return "pending";
  }

  return "unresolved";
}

function setAutomationTopicState(session, patch = {}) {
  return buildSessionControlPatch(session, {
    automation: patch
  });
}

function syncSessionTopicLedger(session, objectives = [], turns = null, facts = null) {
  const current = getSessionControl(session).automation;
  const resolvedTurns = turns || listConversationTurns(session.id);
  const resolvedFacts = facts || listExtractedFacts(session.id);
  const rebuiltLedger = rebuildTopicLedgerFromSession(session, resolvedTurns, resolvedFacts, objectives);
  const nextQueue = getTopicQueueSnapshot(session, objectives, rebuiltLedger);
  let nextActiveTopicKey = normalizeTopicKey(current.activeTopicKey);
  const scopedKeys = getEffectiveScopedObjectiveKeys(session, null, objectives);

  if (scopedKeys.length && nextActiveTopicKey && !scopedKeys.includes(nextActiveTopicKey)) {
    nextActiveTopicKey = null;
  }

  if (!nextActiveTopicKey || getTopicEntry(rebuiltLedger, nextActiveTopicKey)?.state === "closed") {
    nextActiveTopicKey = chooseNextActiveTopicFromLedger(session, objectives, rebuiltLedger);
  }

  return setAutomationTopicState(session, {
    topicLedger: rebuiltLedger,
    topicQueueSnapshot: nextQueue,
    activeTopicKey: nextActiveTopicKey,
    lastClosedTopicKey:
      current.lastClosedTopicKey && getTopicEntry(rebuiltLedger, current.lastClosedTopicKey)?.state === "closed"
        ? current.lastClosedTopicKey
        : normalizeTopicKey(current.lastClosedTopicKey)
  });
}

function persistSessionTopicLedger(session, objectives = [], turns = null, facts = null, overrides = {}) {
  const nextControl = syncSessionTopicLedger(session, objectives, turns, facts);
  const mergedControl = buildSessionControlPatch(
    {
      ...session,
      control: nextControl
    },
    {
      automation: overrides
    }
  );
  updatePrechatSession(session.id, { control: mergedControl });
  return getPrechatSessionById(session.id);
}

function syncRoundObjectiveSnapshot(round, session, objectives = []) {
  if (!round?.id || !session?.id) {
    return round;
  }

  const liveSession = getPrechatSessionById(session.id) || session;
  const automation = getSessionControl(liveSession).automation;
  const liveObjectiveTopics = getScopedObjectiveTopicDefinitions(liveSession, round, objectives);
  const nextObjective = {
    ...(round.objective || {}),
    topics: liveObjectiveTopics.length
      ? liveObjectiveTopics
      : Array.isArray(round.objective?.topics)
        ? round.objective.topics
        : [],
    activeTopicKey: normalizeTopicKey(automation.activeTopicKey),
    topicQueueSnapshot: Array.isArray(automation.topicQueueSnapshot) ? automation.topicQueueSnapshot : []
  };
  updatePrechatRoundObjective(round.id, nextObjective);
  return {
    ...(getPrechatRound(round.id) || round),
    objective: nextObjective
  };
}

function syncSessionTopicLedgerIfNeeded(sessionId) {
  const session = getPrechatSessionById(sessionId);

  if (!session) {
    return null;
  }

  const turns = listConversationTurns(sessionId);
  const facts = listExtractedFacts(sessionId);
  const objectives = buildObjectives(
    session,
    getCurrentTwin(session.initiatorUserId),
    getCurrentTwin(session.counterpartyUserId),
    facts
  );
  const currentControl = getSessionControl(session);
  const nextControl = syncSessionTopicLedger(session, objectives, turns, facts);

  if (JSON.stringify(currentControl.automation) === JSON.stringify(nextControl.automation)) {
    return session;
  }

  updatePrechatSession(sessionId, { control: nextControl });
  return getPrechatSessionById(sessionId);
}

function buildTopicInferenceSources({
  result,
  turns = [],
  activeTopicKey = null,
  replyTextTopic = null,
  openQuestionTopic = null,
  effectiveFirstOpening = false
}) {
  const latestTurn = turns.length ? turns[turns.length - 1] : null;
  const normalizedQuestionTopicKey = normalizeTopicKey(result?.question_topic_key);
  const normalizedReplyTopicKey = normalizeTopicKey(result?.reply_topic_key);
  const normalizedActiveTopicKey = normalizeTopicKey(activeTopicKey);
  const latestTurnTopic = inferTopicKeyFromText(latestTurn?.content);
  const isFirstTurn = !turns.length || effectiveFirstOpening;
  const emittedQuestionText = normalizeText(result?.emitted_question_text || extractTrailingQuestionText(result?.reply));
  const textQuestionTopic = emittedQuestionText ? inferQuestionTopicFromQuestionText(emittedQuestionText) : null;
  const strongQuestionTextOverride =
    Boolean(textQuestionTopic) &&
    textQuestionTopic !== normalizedActiveTopicKey &&
    textQuestionTopic === openQuestionTopic;

  let replyTopicKey = null;
  let replyTopicSource = null;

  if (normalizedReplyTopicKey) {
    replyTopicKey = normalizedReplyTopicKey;
    replyTopicSource = "model_reply_topic_key";
  } else if (normalizedQuestionTopicKey) {
    replyTopicKey = normalizedQuestionTopicKey;
    replyTopicSource = "model_question_topic_key";
  } else if (normalizedActiveTopicKey) {
    replyTopicKey = normalizedActiveTopicKey;
    replyTopicSource = "active_topic_key";
  } else if (replyTextTopic) {
    replyTopicKey = replyTextTopic;
    replyTopicSource = "reply_text_inference";
  } else if (latestTurnTopic) {
    replyTopicKey = latestTurnTopic;
    replyTopicSource = "latest_turn_inference";
  }

  let questionTopicKey = null;
  let questionTopicSource = null;

  if (textQuestionTopic) {
    questionTopicKey = textQuestionTopic;
    questionTopicSource = "question_text_inference";
  } else if (openQuestionTopic) {
    questionTopicKey = openQuestionTopic;
    questionTopicSource = "open_questions_inference";
  } else if (normalizedQuestionTopicKey) {
    questionTopicKey = normalizedQuestionTopicKey;
    questionTopicSource = "model_question_topic_key";
  } else if (normalizedReplyTopicKey && textLooksLikeQuestion(result?.reply)) {
    questionTopicKey = normalizedReplyTopicKey;
    questionTopicSource = "model_reply_topic_key";
  } else if (isFirstTurn && normalizedActiveTopicKey) {
    questionTopicKey = normalizedActiveTopicKey;
    questionTopicSource = "active_topic_key";
  }

  if (isFirstTurn && normalizedActiveTopicKey && strongQuestionTextOverride) {
    questionTopicKey = textQuestionTopic;
    questionTopicSource = "first_turn_strong_text_override";
  }

  return {
    replyTopicKey: replyTopicKey || null,
    questionTopicKey: questionTopicKey || null,
    topicInferenceSource: {
      reply: replyTopicSource,
      question: questionTopicSource
    }
  };
}

function deriveTurnTopicKeys(result, turns = [], activeTopicKey = null) {
  const openingContext = buildOpeningRecoveryTurnContext(null, turns);
  const turnsForInference = openingContext.effectiveFirstOpening ? openingContext.filteredTurns : turns;
  const emittedQuestionText = normalizeText(result?.emitted_question_text || extractTrailingQuestionText(result?.reply));
  const answerText = splitReplyIntoAnswerAndTrailingQuestion(result?.reply).answerText;
  const replyTextTopic =
    normalizeTopicKey(result?.emitted_reply_topic_key) ||
    inferAnswerTopicFromAnswerSegment(answerText, activeTopicKey, null);
  const openQuestionTopic =
    normalizeTopicKey(result?.emitted_question_topic_key) ||
    inferQuestionTopicFromQuestionText(emittedQuestionText) ||
    (Array.isArray(result?.open_questions) && result.open_questions.length
      ? inferQuestionTopicFromQuestionText(result.open_questions[0])
      : null);

  return buildTopicInferenceSources({
    result,
    turns: turnsForInference,
    activeTopicKey,
    replyTextTopic,
    openQuestionTopic,
    effectiveFirstOpening: openingContext.effectiveFirstOpening
  });
}

function buildTopicGuardMetadata({
  session,
  roundId = null,
  trigger = null,
  activeTopicKey = null,
  replyTopicKey = null,
  questionTopicKey = null,
  topicInferenceSource = {},
  result,
  turns = [],
  source = "topic_guard_blocked",
  firstTurnGuardBlock = false
}) {
  return {
    source,
    firstTurnGuardBlock,
    sessionId: session?.id || null,
    roundId: roundId || null,
    trigger: normalizeText(trigger) || null,
    activeTopicKey: normalizeTopicKey(activeTopicKey),
    objectiveKeys: Array.isArray(session?.control?.automation?.topicQueueSnapshot)
      ? session.control.automation.topicQueueSnapshot
      : [],
    derivedReplyTopicKey: normalizeTopicKey(replyTopicKey),
    derivedQuestionTopicKey: normalizeTopicKey(questionTopicKey),
    topicInferenceSource,
    rawReply: normalizeText(result?.reply),
    rawOpenQuestions: Array.isArray(result?.open_questions)
      ? result.open_questions.map((item) => normalizeText(item)).filter(Boolean)
      : [],
    isFirstTurn: !turns.length,
    isReportPlan: getSessionControl(session).automation.source === "report_plan",
    closedTopicKeys: TOPIC_CONFIG.map((item) => item.key).filter(
      (topicKey) => getTopicEntry(getSessionControl(session).automation.topicLedger, topicKey)?.state === "closed"
    )
  };
}

function emitTopicGuardTelemetry(metadata = {}, extra = {}) {
  writeLlmTelemetry(
    buildQualityTelemetryPayload({
      request_type: "topic_guard",
      source: metadata.source || "topic_guard",
      topic_guard_event:
        extra.topic_guard_event ||
        (metadata.firstTurnGuardBlock ? "topic_guard_blocked_first_turn" : "topic_guard_blocked"),
      topic_guard_blocked_first_turn: Boolean(metadata.firstTurnGuardBlock),
      topic_guard_normalized_first_turn: Boolean(extra.topic_guard_normalized_first_turn),
      topic_guard_recovered_session: Boolean(extra.topic_guard_recovered_session),
      pending_human_input_emitted: Boolean(extra.pending_human_input_emitted),
      trigger: metadata.trigger || null,
      session_id: metadata.sessionId || null,
      round_id: metadata.roundId || null,
      active_topic_key: metadata.activeTopicKey || null,
      derived_reply_topic_key: metadata.derivedReplyTopicKey || null,
      derived_question_topic_key: metadata.derivedQuestionTopicKey || null,
      topic_inference_source: metadata.topicInferenceSource || {},
      raw_reply: metadata.rawReply || "",
      raw_open_questions: metadata.rawOpenQuestions || [],
      is_first_turn: Boolean(metadata.isFirstTurn),
      is_report_plan: Boolean(metadata.isReportPlan),
      ...extra
    })
  );
}

function isTopicQuestionRepeatWithoutNewHumanInput(session, topicKey, turns = []) {
  const normalizedTopicKey = normalizeTopicKey(topicKey);
  if (!normalizedTopicKey) {
    return false;
  }

  const relevantTurns = turns.filter((turn) => inferTopicKeyFromText(turn.content) === normalizedTopicKey);
  if (relevantTurns.length < 2) {
    return false;
  }

  const latestTwinQuestionIndex = [...relevantTurns]
    .reverse()
    .findIndex((turn) => String(turn.actorRole || "").endsWith("_twin") && textLooksLikeQuestion(turn.content));

  if (latestTwinQuestionIndex < 0) {
    return false;
  }

  const latestTwinQuestion = relevantTurns[relevantTurns.length - 1 - latestTwinQuestionIndex];
  const latestHumanTurnAfterQuestion = relevantTurns
    .slice(relevantTurns.indexOf(latestTwinQuestion) + 1)
    .some((turn) => isHumanUserTurn(turn));

  return !latestHumanTurnAfterQuestion;
}

function validateTopicAwareTurnResult({
  session,
  result,
  turns,
  activeTopicKey,
  objectives,
  speaker,
  listener,
  roundId = null,
  trigger = null,
  turnFrame = null
}) {
  const factsForValidation = listExtractedFacts(session.id);
  const control = syncSessionTopicLedger(session, objectives, turns, factsForValidation);
  const openingContext = buildOpeningRecoveryTurnContext(session, turns);
  const latestTurn = turns.length ? turns[turns.length - 1] : null;
  const latestListenerQuestionTopic = latestTurn?.actorUserId === listener?.userId ? getTurnQuestionTopic(latestTurn) : null;
  const canonicalContext = buildCanonicalContextFromFrame(turnFrame || {}, {
    activeTopicKey,
    latestListenerQuestionTopic,
    speakerUserId: speaker?.userId || null,
    listenerUserId: listener?.userId || null
  });
  const canonicalizedResult = buildCanonicalTurnOutcome(result, turnFrame || {}, canonicalContext);
  const closedTopicKeys = TOPIC_CONFIG.map((item) => item.key).filter(
    (topicKey) =>
      getTopicEntry(control.automation.topicLedger, topicKey)?.state === "closed" ||
      hasBothSidesConfirmedTopic(session, factsForValidation, topicKey)
  );
  const { replyTopicKey, questionTopicKey, topicInferenceSource } = deriveTurnTopicKeys(
    canonicalizedResult,
    turns,
    activeTopicKey
  );
  const normalizedActiveTopicKey = normalizeTopicKey(activeTopicKey);
  const isFirstTurn = openingContext.effectiveFirstOpening;
  const resolvedCurrentFacts = Array.isArray(canonicalizedResult?.confirmed_facts)
    ? canonicalizedResult.confirmed_facts
        .map((fact) => ({
          ...fact,
          subjectUserId: resolveFactSubjectUserId(fact?.subjectUserId, speaker.userId, listener.userId)
        }))
        .filter((fact) => normalizeTopicKey(fact?.key))
    : [];
  const closeDecision = resolveTopicCloseDecision({
    session,
    factsForValidation,
    resultFacts: resolvedCurrentFacts,
    topicKey: normalizedActiveTopicKey,
    speaker,
    canonicalReplyTopicKey:
      normalizeTopicKey(canonicalizedResult?.canonical_reply_topic_key) ||
      normalizeTopicKey(canonicalizedResult?.emitted_reply_topic_key) ||
      replyTopicKey,
    didAnswerRequiredQuestion: canonicalizedResult?.did_answer_required_question === true,
    latestListenerQuestionTopic
  });
  const activeTopicCanCloseAfterCurrentResult = Boolean(normalizedActiveTopicKey) && closeDecision.canClose;
  const emittedQuestionText = normalizeText(
    canonicalizedResult?.canonical_question_text ||
      canonicalizedResult?.emitted_question_text ||
      extractTrailingQuestionText(canonicalizedResult?.reply)
  );
  const nextQuestionFingerprint = buildQuestionFingerprint(emittedQuestionText, questionTopicKey);
  const isDirectAnswerToOutstandingTopic =
    Boolean(latestTurn?.actorUserId) &&
    String(latestTurn.actorRole || "").endsWith("_twin") &&
    textLooksLikeQuestion(latestTurn.content) &&
    normalizedActiveTopicKey &&
    replyTopicKey === normalizedActiveTopicKey &&
    !questionTopicKey;
  const latestListenerAnswerCard = latestListenerQuestionTopic ? buildFactCard(speaker, latestListenerQuestionTopic) : null;
  const latestListenerAnswerHint = latestListenerAnswerCard?.naturalAnswerHint || null;
  const mirrorQuestionDecision = shouldAllowMirrorQuestionForCoverage({
    session,
    turns,
    topicKey: questionTopicKey,
    questionText: emittedQuestionText,
    speakerUserId: speaker.userId,
    listenerUserId: listener.userId,
    latestListenerQuestionTopic,
    resultFacts: resolvedCurrentFacts,
    didAnswerRequiredQuestion: Boolean(canonicalizedResult?.did_answer_required_question)
  });
  const commonTelemetry = {
    switch_after_topic_close_candidate:
      Boolean(normalizedActiveTopicKey) &&
      Boolean(questionTopicKey) &&
      questionTopicKey !== normalizedActiveTopicKey &&
      normalizeTopicKey(replyTopicKey) === normalizedActiveTopicKey,
    switch_after_topic_close_allowed: false,
    active_topic_can_close_after_current_result: activeTopicCanCloseAfterCurrentResult,
    active_topic_coverage_before: closeDecision.coverageBefore || null,
    active_topic_coverage_after: closeDecision.coverageAfter || null,
    active_topic_close_decision_source: closeDecision.source || null
  };
  const questionTopicClosed =
    Boolean(questionTopicKey) &&
    (
      closedTopicKeys.includes(questionTopicKey) ||
      isTopicClosedInLedger(session, questionTopicKey) ||
      hasBothSidesConfirmedTopic(session, factsForValidation, questionTopicKey)
    );
  const finalizeValidatedResult = (candidate, contextOverrides = {}) =>
    persistFinalCanonicalTurnMetadata(
      alignFinalTurnSemantics(candidate, {
        activeTopicKey: normalizeTopicKey(contextOverrides.activeTopicKey) || normalizedActiveTopicKey,
        latestListenerQuestionTopic:
          normalizeTopicKey(contextOverrides.latestListenerQuestionTopic) || latestListenerQuestionTopic,
        speakerUserId: speaker?.userId || null,
        listenerUserId: listener?.userId || null,
        speakerDisplayName: speaker?.displayName || ""
      }),
      turnFrame || {},
      {
        activeTopicKey: normalizeTopicKey(contextOverrides.activeTopicKey) || normalizedActiveTopicKey,
        latestListenerQuestionTopic:
          normalizeTopicKey(contextOverrides.latestListenerQuestionTopic) || latestListenerQuestionTopic,
        speakerUserId: speaker?.userId || null,
        listenerUserId: listener?.userId || null,
        speakerDisplayName: speaker?.displayName || ""
      }
    );

  if (isDirectAnswerToOutstandingTopic) {
    return finalizeValidatedResult({
      ...canonicalizedResult,
      ...commonTelemetry,
      reply_topic_key: replyTopicKey,
      question_topic_key: null
    });
  }

  if (
    latestListenerQuestionTopic &&
    latestTurn?.actorUserId === listener?.userId &&
    textLooksLikeQuestion(latestTurn?.content) &&
    !canonicalizedResult?.needs_human_input?.required &&
    !isSensitiveApprovalCandidate(canonicalizedResult) &&
    latestListenerAnswerHint &&
    replyTopicKey !== latestListenerQuestionTopic
  ) {
    const listenerAnswerFact = latestListenerAnswerCard
      ? [
          {
            subjectUserId: "self",
            key: latestListenerQuestionTopic,
            value: latestListenerAnswerCard.normalizedSummary,
            confidence: 0.92,
            status: "confirmed"
          }
        ]
      : [];
    const canCloseAnsweredListenerTopic = canTopicCloseAfterCurrentResult(
      session,
      factsForValidation,
      listenerAnswerFact.map((fact) => ({
        ...fact,
        subjectUserId: resolveFactSubjectUserId(fact.subjectUserId, speaker.userId, listener.userId)
      })),
      latestListenerQuestionTopic
    );
    const normalizedLatestListenerQuestionTopic = normalizeTopicKey(latestListenerQuestionTopic);
    const normalizedActiveTopicKey = normalizeTopicKey(activeTopicKey);
    const activeTopicStillNeedsProgress =
      normalizedActiveTopicKey &&
      getTopicEntry(control.automation.topicLedger, normalizedActiveTopicKey)?.state !== "closed" &&
      (
        normalizedActiveTopicKey !== normalizedLatestListenerQuestionTopic ||
        !canCloseAnsweredListenerTopic
      );
    const followupObjective = activeTopicStillNeedsProgress
      ? TOPIC_CONFIG.find((item) => item.key === normalizedActiveTopicKey) || null
      : normalizedActiveTopicKey === normalizedLatestListenerQuestionTopic
        ? canCloseAnsweredListenerTopic
          ? chooseCanonicalNextObjective(session, objectives, turns, {
              excludedTopicKey: latestListenerQuestionTopic,
              listenerUserId: listener?.userId || null
            })
          : null
        : TOPIC_CONFIG.find((item) => item.key === normalizedActiveTopicKey) || null;
    const followupQuestion = buildObjectiveQuestionV2(followupObjective);
    const rewritten = alignFinalTurnSemantics(
      {
        ...canonicalizedResult,
        reply: [latestListenerAnswerHint, followupQuestion].filter(Boolean).join(" "),
        confirmed_facts: listenerAnswerFact,
        open_questions: followupQuestion ? [followupQuestion] : [],
        recommendation: followupQuestion ? "continue" : "pause_review",
        rewrite_source: "answer_priority_rewrite",
        rewrite_target_topic: normalizeTopicKey(followupObjective?.key) || null,
        rewrite_preserved_answer_topic: latestListenerQuestionTopic
      },
      {
        activeTopicKey: normalizeTopicKey(followupObjective?.key) || normalizeTopicKey(activeTopicKey),
        latestListenerQuestionTopic,
        speakerUserId: speaker.userId,
        listenerUserId: listener.userId
      }
    );
    if (activeTopicStillNeedsProgress && followupQuestion) {
      return finalizeValidatedResult({
        ...rewritten,
        ...commonTelemetry,
        topic_guard_metadata: {
          ...(rewritten.topic_guard_metadata || {}),
          source: isFirstTurn ? "topic_guard_rewritten_first_turn" : "topic_guard_rewritten_active_topic",
          firstTurnGuardBlock: false,
          sessionId: session?.id || null,
          roundId: roundId || null,
          trigger: normalizeText(trigger) || null,
          activeTopicKey: normalizedActiveTopicKey,
          objectiveKeys: Array.isArray(session?.control?.automation?.topicQueueSnapshot)
            ? session.control.automation.topicQueueSnapshot
            : [],
          derivedReplyTopicKey: normalizedLatestListenerQuestionTopic,
          derivedQuestionTopicKey: normalizedActiveTopicKey,
          topicInferenceSource,
          rawReply: normalizeText(canonicalizedResult?.reply),
          rawOpenQuestions: Array.isArray(canonicalizedResult?.open_questions)
            ? canonicalizedResult.open_questions.map((item) => normalizeText(item)).filter(Boolean)
            : [],
          isFirstTurn,
          isReportPlan: getSessionControl(session).automation.source === "report_plan",
          closedTopicKeys,
          effectiveFirstOpening: isFirstTurn,
          hasAnyTwinTurn: openingContext.hasAnyTwinTurn,
          openingContextFilteredTurnCount: openingContext.filteredTurnCount,
          openingRewriteApplied: isFirstTurn,
          openingRewriteSource: activeTopicStillNeedsProgress ? "answer_priority_to_active_topic" : null,
          originalQuestionTopicKey: normalizeTopicKey(questionTopicKey) || normalizedLatestListenerQuestionTopic,
          rewrittenQuestionTopicKey: normalizedActiveTopicKey
        }
      }, {
        activeTopicKey: normalizedActiveTopicKey,
        latestListenerQuestionTopic
      });
    }
    return finalizeValidatedResult(rewritten, {
      activeTopicKey:
        normalizeTopicKey(rewritten?.canonical_question_topic_key) ||
        normalizeTopicKey(rewritten?.question_topic_key) ||
        normalizedActiveTopicKey,
      latestListenerQuestionTopic
    });
  }

  if (
    normalizedActiveTopicKey &&
    questionTopicKey === normalizedActiveTopicKey &&
    activeTopicCanCloseAfterCurrentResult
  ) {
    const nextObjective = chooseCanonicalNextObjective(session, objectives, turns, {
      excludedTopicKey: normalizedActiveTopicKey,
      listenerUserId: listener?.userId || null
    });
    const nextQuestion = buildObjectiveQuestionV2(nextObjective);
    const rewritten = alignFinalTurnSemantics(
      {
        ...canonicalizedResult,
        reply: [splitReplyIntoAnswerAndTrailingQuestion(canonicalizedResult?.reply).answerText, nextQuestion].filter(Boolean).join(" "),
        question_topic_key: nextObjective?.key || null,
        open_questions: nextQuestion ? [nextQuestion] : [],
        recommendation: nextQuestion ? "continue" : "objectives_completed",
        repeat_topic_guard_triggered: true,
        repeat_source: "close_after_current_result",
        repeat_topic_resolution: nextQuestion ? "switched_to_next_topic" : "objectives_completed",
        active_topic_can_close_after_current_result: true,
        next_topic_selector_source: "canonical_session_ledger"
      },
      {
        activeTopicKey: nextObjective?.key || null,
        latestListenerQuestionTopic
      }
    );
    return finalizeValidatedResult(rewritten, {
      activeTopicKey: nextObjective?.key || null,
      latestListenerQuestionTopic
    });
  }

  if (
    normalizedActiveTopicKey &&
    questionTopicKey &&
    questionTopicKey !== normalizedActiveTopicKey &&
    activeTopicCanCloseAfterCurrentResult &&
    normalizeTopicKey(replyTopicKey) === normalizedActiveTopicKey &&
    canonicalizedResult?.did_answer_required_question === true
  ) {
    const nextObjective = questionTopicClosed
      ? chooseCanonicalNextObjective(session, objectives, turns, {
          excludedTopicKeys: [questionTopicKey, normalizedActiveTopicKey],
          listenerUserId: listener?.userId || null
        })
      : null;
    const nextQuestion = questionTopicClosed ? buildObjectiveQuestionV2(nextObjective) : null;
    const nextQuestionTopicKey = questionTopicClosed
      ? normalizeTopicKey(nextObjective?.key) || null
      : questionTopicKey;
    const nextQuestionFingerprintForCloseSwitch = nextQuestion
      ? buildQuestionFingerprint(nextQuestion, nextQuestionTopicKey)
      : nextQuestionFingerprint;
    const answerOnly = normalizeText(
      canonicalizedResult?.canonical_answer_text ||
      splitReplyIntoAnswerAndTrailingQuestion(canonicalizedResult?.reply).answerText
    );
    const rewrittenReply = questionTopicClosed
      ? [answerOnly, nextQuestion].filter(Boolean).join(" ")
      : canonicalizedResult?.reply;
    return finalizeValidatedResult({
      ...canonicalizedResult,
      ...commonTelemetry,
      reply: rewrittenReply,
      switch_after_topic_close_allowed: true,
      reply_topic_key: replyTopicKey,
      question_topic_key: nextQuestionTopicKey,
      open_questions: nextQuestion ? [nextQuestion] : (questionTopicClosed ? [] : canonicalizedResult?.open_questions),
      question_fingerprint: nextQuestionFingerprintForCloseSwitch,
      mirror_question_required_for_coverage: false,
      mirror_question_allowed: false,
      repeat_guard_suppressed: true,
      repeat_guard_suppression_reason: questionTopicClosed ? "topic_already_closed" : "switch_after_topic_close",
      coverage_before_current_turn: mirrorQuestionDecision.coverageBefore || closeDecision.coverageBefore || null,
      coverage_after_current_turn: mirrorQuestionDecision.coverageAfter || closeDecision.coverageAfter || null,
      closed_topic_rewrite_suppressed: questionTopicClosed,
      next_topic_selector_source: questionTopicClosed ? "canonical_session_ledger" : null
    }, {
      activeTopicKey: nextQuestionTopicKey || normalizedActiveTopicKey,
      latestListenerQuestionTopic
    });
  }

  if (
    questionTopicKey &&
    emittedQuestionText &&
    !mirrorQuestionDecision.allowed &&
    isSameTopicBroadQuestionRepeat({
      session,
      turns,
      topicKey: questionTopicKey,
      questionText: emittedQuestionText,
      speakerUserId: speaker.userId
    })
  ) {
    const repeatedTopicClosed =
      closedTopicKeys.includes(questionTopicKey) ||
      mirrorQuestionDecision.reason === "topic_already_closed";
    const nextObjective = chooseCanonicalNextObjective(session, objectives, turns, {
      excludedTopicKeys: [questionTopicKey, normalizedActiveTopicKey],
      listenerUserId: listener?.userId || null
    });
    const nextQuestion = buildObjectiveQuestionV2(nextObjective);
    const answerOnly = normalizeText(
      canonicalizedResult?.canonical_answer_text ||
      splitReplyIntoAnswerAndTrailingQuestion(canonicalizedResult?.reply).answerText
    );
    const nextQuestionFingerprint = nextQuestion
      ? buildQuestionFingerprint(nextQuestion, normalizeTopicKey(nextObjective?.key) || null)
      : null;
    const rewrittenReply = [answerOnly, nextQuestion].filter(Boolean).join(" ");
    return finalizeValidatedResult(
      {
        ...canonicalizedResult,
        reply: rewrittenReply,
        question_topic_key: nextObjective?.key || null,
        open_questions: nextQuestion ? [nextQuestion] : [],
        recommendation: nextQuestion ? "continue" : "pause_review",
        repeat_topic_guard_triggered: true,
        repeat_source: "same_topic_broad_question_repeat",
        question_fingerprint: nextQuestionFingerprint,
        repeat_topic_resolution: nextQuestion ? "switched_to_next_topic" : "answered_only",
        active_topic_can_close_after_current_result: activeTopicCanCloseAfterCurrentResult,
        mirror_question_required_for_coverage: mirrorQuestionDecision.required,
        mirror_question_allowed: false,
        repeat_guard_suppressed: false,
        repeat_guard_suppression_reason: mirrorQuestionDecision.reason || null,
        coverage_before_current_turn: mirrorQuestionDecision.coverageBefore || null,
        coverage_after_current_turn: mirrorQuestionDecision.coverageAfter || null,
        next_topic_selector_source: "canonical_session_ledger",
        closed_topic_rewrite_suppressed: repeatedTopicClosed
      },
      {
        activeTopicKey: nextObjective?.key || normalizedActiveTopicKey,
        latestListenerQuestionTopic
      }
    );
  }

  if (mirrorQuestionDecision.allowed) {
    return finalizeValidatedResult({
      ...canonicalizedResult,
      ...commonTelemetry,
      question_fingerprint: nextQuestionFingerprint,
      reply_topic_key: replyTopicKey,
      question_topic_key: questionTopicKey,
      mirror_question_required_for_coverage: true,
      mirror_question_allowed: true,
      repeat_guard_suppressed: true,
      repeat_guard_suppression_reason: mirrorQuestionDecision.reason || null,
      coverage_before_current_turn: mirrorQuestionDecision.coverageBefore || null,
      coverage_after_current_turn: mirrorQuestionDecision.coverageAfter || null
    }, {
      activeTopicKey: questionTopicKey,
      latestListenerQuestionTopic
    });
  }

  if (questionTopicKey && closedTopicKeys.includes(questionTopicKey)) {
    const activeTopicStillOpen =
      Boolean(normalizedActiveTopicKey) &&
      getTopicEntry(control.automation.topicLedger, normalizedActiveTopicKey)?.state !== "closed" &&
      !closedTopicKeys.includes(normalizedActiveTopicKey);
    const topicGuardMetadata = buildTopicGuardMetadata({
      session,
      roundId,
      trigger,
      activeTopicKey: normalizedActiveTopicKey,
      replyTopicKey: replyTopicKey || normalizedActiveTopicKey,
      questionTopicKey,
      topicInferenceSource,
      result: canonicalizedResult,
      turns,
      source: "closed_topic_guard",
      firstTurnGuardBlock: false
    });
    const rewritten = buildSafeFollowupReply({
      baseResult: {
        ...canonicalizedResult,
        question_topic_key: null
      },
      session,
      speaker,
      listener,
      repeatedTopicKey: questionTopicKey,
      objectives,
      recentTurns: turns.slice(-6),
      failureQuestion: `当前议题“${getTopicLabel(questionTopicKey)}”已经确认完成，请不要重复确认。`,
      options: {
        mode: "closed_topic_guard",
        closedTopicKeys,
        preferredRewriteTopicKey: activeTopicStillOpen ? normalizedActiveTopicKey : null
      }
    });

    const rewriteFoundSafeResult =
      Boolean(normalizeText(rewritten.reply)) ||
      rewritten.recommendation === "pause_review" ||
      rewritten.closed_topic_guard_resolution === "pause_without_pending_request";
    const nextMetadata = {
      ...topicGuardMetadata,
      rewriteFoundSafeResult,
      closedTopicGuardResolution: normalizeText(rewritten.closed_topic_guard_resolution) || null,
      fellBackToHumanInput: Boolean(rewritten.needs_human_input?.required)
    };

    emitTopicGuardTelemetry(nextMetadata, {
      topic_guard_event: "closed_topic_guard_rewritten",
      closed_topic_guard_rewritten: true,
      rewrite_found_safe_result: rewriteFoundSafeResult,
      closed_topic_guard_resolution: nextMetadata.closedTopicGuardResolution,
      fell_back_to_human_input: nextMetadata.fellBackToHumanInput
    });

    return finalizeValidatedResult({
      ...rewritten,
      ...commonTelemetry,
      needs_human_input: {
        required: false,
        field: null,
        question: null,
        target_user_for_input: null
      },
      reply_topic_key: normalizeTopicKey(rewritten.reply_topic_key) || replyTopicKey || activeTopicKey || null,
      question_topic_key: normalizeTopicKey(rewritten.question_topic_key) || null,
      topic_guard_metadata: nextMetadata
    }, {
      activeTopicKey:
        normalizeTopicKey(rewritten?.canonical_question_topic_key) ||
        normalizeTopicKey(rewritten?.question_topic_key) ||
        normalizedActiveTopicKey,
      latestListenerQuestionTopic
    });
  }

  if (
    normalizedActiveTopicKey &&
    questionTopicKey &&
    questionTopicKey !== normalizedActiveTopicKey &&
    !activeTopicCanCloseAfterCurrentResult &&
    getTopicEntry(control.automation.topicLedger, activeTopicKey)?.state !== "closed" &&
    !shouldDeferJumpTopicGuardToAnswerMismatch({
      latestListenerQuestionTopic,
      activeTopicKey: normalizedActiveTopicKey,
      replyTopicKey,
      questionTopicKey
    })
  ) {
    const canonicalActiveQuestion = buildObjectiveQuestionV2(
      TOPIC_CONFIG.find((item) => item.key === normalizedActiveTopicKey) || { key: normalizedActiveTopicKey }
    );
    const sensitiveApprovalCandidate = isSensitiveApprovalCandidate(canonicalizedResult);

    if (
      canonicalActiveQuestion &&
      !canonicalizedResult?.needs_human_input?.required &&
      !sensitiveApprovalCandidate
    ) {
      const answerText = splitReplyIntoAnswerAndTrailingQuestion(canonicalizedResult?.reply).answerText;
      const preserveAnswerSegment = shouldPreserveAnswerSegmentForTopicRewrite({
        answerText,
        latestListenerQuestionTopic
      });
      const preservedAnswerText = preserveAnswerSegment ? normalizeText(answerText) : "";
      const rewrittenReply = [preservedAnswerText, canonicalActiveQuestion].filter(Boolean).join(" ");
      const rewriteSource = isFirstTurn ? "active_topic_canonical_question" : "active_topic_canonical_followup";
      const rewriteEvent = isFirstTurn ? "topic_guard_rewritten_first_turn" : "topic_guard_rewritten_active_topic";
      const normalizedResult = {
        ...alignFinalTurnSemantics(
          {
            ...canonicalizedResult,
            reply: rewrittenReply || canonicalActiveQuestion || canonicalizedResult.reply,
            confirmed_facts: preserveAnswerSegment
              ? (Array.isArray(canonicalizedResult.confirmed_facts) ? canonicalizedResult.confirmed_facts : [])
              : [],
            open_questions: canonicalActiveQuestion ? [canonicalActiveQuestion] : [],
            recommendation: "continue",
            answer_segment_dropped_by_rewrite: Boolean(normalizeText(answerText)) && !preserveAnswerSegment,
            rewrite_preserved_answer_topic: preserveAnswerSegment
              ? inferAnswerTopicFromAnswerSegment(answerText, null, latestListenerQuestionTopic)
              : null,
            rewrite_target_topic: normalizedActiveTopicKey
          },
          {
            activeTopicKey: normalizedActiveTopicKey,
            latestListenerQuestionTopic
          }
        ),
        topic_guard_metadata: buildTopicGuardMetadata({
          session,
          roundId,
          trigger,
          activeTopicKey: normalizedActiveTopicKey,
          replyTopicKey: replyTopicKey || normalizedActiveTopicKey,
          questionTopicKey,
          topicInferenceSource,
          result: canonicalizedResult,
          turns,
          source: isFirstTurn ? "topic_guard_rewritten_first_turn" : "topic_guard_rewritten_active_topic",
          firstTurnGuardBlock: false
        })
      };
      normalizedResult.topic_guard_metadata = {
        ...(normalizedResult.topic_guard_metadata || {}),
        effectiveFirstOpening: isFirstTurn,
        hasAnyTwinTurn: openingContext.hasAnyTwinTurn,
        openingContextFilteredTurnCount: openingContext.filteredTurnCount,
        openingRewriteApplied: true,
        openingRewriteSource: rewriteSource,
        originalQuestionTopicKey: questionTopicKey,
        rewrittenQuestionTopicKey: normalizedActiveTopicKey
      };
      emitTopicGuardTelemetry(normalizedResult.topic_guard_metadata, {
        topic_guard_event: rewriteEvent,
        topic_guard_normalized_first_turn: isFirstTurn,
        opening_rewrite_applied: true,
        blocked_question_topic_key: questionTopicKey,
        original_question_topic_key: questionTopicKey,
        rewritten_question_topic_key: normalizedActiveTopicKey
      });
      return finalizeValidatedResult(normalizedResult, {
        activeTopicKey: normalizedActiveTopicKey,
        latestListenerQuestionTopic
      });
    }

    if (sensitiveApprovalCandidate) {
      const passthroughMetadata = buildTopicGuardMetadata({
        session,
        roundId,
        trigger,
        activeTopicKey: normalizedActiveTopicKey,
        replyTopicKey: replyTopicKey || normalizedActiveTopicKey,
        questionTopicKey,
        topicInferenceSource,
        result: canonicalizedResult,
        turns,
        source: isFirstTurn ? "topic_guard_deferred_to_sensitive_approval_first_turn" : "topic_guard_deferred_to_sensitive_approval",
        firstTurnGuardBlock: false
      });
      passthroughMetadata.effectiveFirstOpening = isFirstTurn;
      passthroughMetadata.hasAnyTwinTurn = openingContext.hasAnyTwinTurn;
      passthroughMetadata.openingContextFilteredTurnCount = openingContext.filteredTurnCount;
      passthroughMetadata.deferredToSensitiveApproval = true;
      passthroughMetadata.originalQuestionTopicKey = questionTopicKey;
      passthroughMetadata.activeTopicKey = normalizedActiveTopicKey;
      emitTopicGuardTelemetry(passthroughMetadata, {
        topic_guard_event: isFirstTurn
          ? "topic_guard_deferred_to_sensitive_approval_first_turn"
          : "topic_guard_deferred_to_sensitive_approval",
        topic_guard_deferred_to_sensitive_approval: true,
        opening_rewrite_applied: false,
        blocked_question_topic_key: questionTopicKey,
        original_question_topic_key: questionTopicKey
      });
      return finalizeValidatedResult({
        ...canonicalizedResult,
        ...commonTelemetry,
        topic_guard_metadata: passthroughMetadata,
        reply_topic_key: replyTopicKey || normalizedActiveTopicKey,
        question_topic_key: questionTopicKey
      }, {
        activeTopicKey: normalizedActiveTopicKey,
        latestListenerQuestionTopic
      });
    }

    const topicGuardMetadata = buildTopicGuardMetadata({
      session,
      roundId,
      trigger,
      activeTopicKey: normalizedActiveTopicKey,
      replyTopicKey: replyTopicKey || normalizedActiveTopicKey,
      questionTopicKey,
      topicInferenceSource,
      result: canonicalizedResult,
      turns,
      source: isFirstTurn ? "topic_guard_blocked_first_turn" : "topic_guard_blocked",
      firstTurnGuardBlock: isFirstTurn
    });
    topicGuardMetadata.effectiveFirstOpening = isFirstTurn;
    topicGuardMetadata.hasAnyTwinTurn = openingContext.hasAnyTwinTurn;
    topicGuardMetadata.openingContextFilteredTurnCount = openingContext.filteredTurnCount;
    return finalizeValidatedResult({
      ...canonicalizedResult,
      ...commonTelemetry,
      reply: "",
      open_questions: [`请先完成当前议题“${getTopicLabel(activeTopicKey)}”的确认。`],
      needs_human_input: {
        required: true,
        field: activeTopicKey,
        question: `当前议题“${getTopicLabel(activeTopicKey)}”尚未完成，系统已阻止跳题，请本人确认这一题后再继续。`,
        target_user_for_input: "self"
      },
      recommendation: "pause_review",
      reply_topic_key: replyTopicKey || normalizedActiveTopicKey,
      question_topic_key: questionTopicKey,
      topic_guard_block_reason: "active_topic_not_closed_before_switch",
      topic_guard_metadata: topicGuardMetadata
    }, {
      activeTopicKey: normalizedActiveTopicKey,
      latestListenerQuestionTopic
    });
  }

  if (questionTopicKey && isTopicQuestionRepeatWithoutNewHumanInput(session, questionTopicKey, turns)) {
    const rewritten = buildSafeFollowupReply({
      baseResult: result,
      speaker,
      listener,
      repeatedTopicKey: questionTopicKey,
      objectives,
      recentTurns: turns.slice(-6),
      failureQuestion: `这一题已经问过一次了，请本人直接补充“${getTopicLabel(questionTopicKey)}”相关真实答案。`
    });

    return finalizeValidatedResult({
      ...rewritten,
      ...commonTelemetry,
      repeat_topic_guard_triggered: true,
      repeat_source: "topic_question_repeat_without_new_human_input",
      reply_topic_key: normalizeTopicKey(rewritten.reply_topic_key) || replyTopicKey || questionTopicKey,
      question_topic_key: normalizeTopicKey(rewritten.question_topic_key) || null
    }, {
      activeTopicKey:
        normalizeTopicKey(rewritten?.canonical_question_topic_key) ||
        normalizeTopicKey(rewritten?.question_topic_key) ||
        normalizedActiveTopicKey,
      latestListenerQuestionTopic
    });
  }

  return finalizeValidatedResult({
    ...canonicalizedResult,
    ...commonTelemetry,
    question_fingerprint: nextQuestionFingerprint,
    reply_topic_key: replyTopicKey,
    question_topic_key: questionTopicKey,
    mirror_question_required_for_coverage: mirrorQuestionDecision.required,
    mirror_question_allowed: false,
    repeat_guard_suppressed: false,
    repeat_guard_suppression_reason: mirrorQuestionDecision.reason || null,
    coverage_before_current_turn: mirrorQuestionDecision.coverageBefore || null,
    coverage_after_current_turn: mirrorQuestionDecision.coverageAfter || null
  }, {
    activeTopicKey: questionTopicKey || normalizedActiveTopicKey,
    latestListenerQuestionTopic
  });
}

function advanceTopicLedgerAfterTwinTurn(session, objectives, turn, facts = []) {
  const liveSession = getPrechatSessionById(session.id) || session;
  const control = getSessionControl(liveSession).automation;
  const canonicalTurn = String(turn?.actorRole || "").endsWith("_twin")
    ? canonicalizeHistoricalTwinTurn(turn, liveSession, listConversationTurns(liveSession.id))
    : turn;
  const metadata = canonicalTurn?.metadata && typeof canonicalTurn.metadata === "object" ? canonicalTurn.metadata : {};

  if (String(canonicalTurn?.actorRole || "").endsWith("_twin") && !isTrustedCanonicalTwinTurn(canonicalTurn)) {
    return persistSessionTopicLedger(
      liveSession,
      objectives,
      listConversationTurns(liveSession.id),
      listExtractedFacts(liveSession.id)
    );
  }

  const replyTopicKey =
    normalizeTopicKey(metadata.canonical_reply_topic_key) ||
    normalizeTopicKey(metadata.emitted_reply_topic_key) ||
    deriveTurnTopicKeys(metadata, [canonicalTurn], control.activeTopicKey).replyTopicKey;
  const questionTopicKey =
    normalizeTopicKey(metadata.canonical_question_topic_key) ||
    normalizeTopicKey(metadata.emitted_question_topic_key) ||
    deriveTurnTopicKeys(metadata, [canonicalTurn], control.activeTopicKey).questionTopicKey;
  const questionFingerprint =
    getCanonicalQuestionFingerprintFromMetadata(canonicalTurn?.metadata || {}, canonicalTurn?.content) ||
    buildQuestionFingerprint(
      normalizeText(
        canonicalTurn?.metadata?.canonical_question_text ||
          canonicalTurn?.metadata?.emitted_question_text ||
          extractTrailingQuestionText(canonicalTurn?.content)
      ),
      questionTopicKey
    );
  let nextLedger = normalizeTopicLedger(control.topicLedger);
  let nextActiveTopicKey = normalizeTopicKey(control.activeTopicKey);
  let lastClosedTopicKey = normalizeTopicKey(control.lastClosedTopicKey);
  const currentActorRole = normalizeObjectiveSubjectRole(liveSession, canonicalTurn.actorUserId);

  if (replyTopicKey) {
    const coverage = getObjectiveCoverage(liveSession, facts, replyTopicKey);
    const currentEntry = getTopicEntry(nextLedger, replyTopicKey);
    const patchedCoverage =
      currentActorRole && currentEntry
        ? {
            ...coverage,
            [currentActorRole]: coverage[currentActorRole] || currentEntry.coverage[currentActorRole]
          }
        : coverage;
    nextLedger = patchTopicLedger(nextLedger, replyTopicKey, {
      coverage: patchedCoverage,
      lastAnsweredByUserId: canonicalTurn.actorUserId || null,
      pendingAnswerUserId:
        currentEntry?.pendingAnswerUserId === canonicalTurn.actorUserId
          ? currentActorRole === "initiator"
            ? liveSession.counterpartyUserId
            : liveSession.initiatorUserId
          : currentEntry?.pendingAnswerUserId || null,
      state:
        currentEntry?.pendingAnswerUserId === canonicalTurn.actorUserId && currentActorRole
          ? currentActorRole === "initiator"
            ? "waiting_counterparty"
            : "waiting_initiator"
          : currentEntry?.state || "not_started"
    });
    if (patchedCoverage.initiator && patchedCoverage.counterparty) {
      nextLedger = patchTopicLedger(nextLedger, replyTopicKey, {
        state: "closed",
        pendingAnswerUserId: null,
        lastResolvedTurnId: canonicalTurn.id,
        closedAt: new Date().toISOString()
      });
      nextActiveTopicKey = null;
      lastClosedTopicKey = replyTopicKey;
    }
  }

  if (questionTopicKey && questionTopicKey !== "unknown" && getTopicEntry(nextLedger, questionTopicKey)?.state !== "closed") {
    const targetUserId =
      canonicalTurn.actorUserId === liveSession.initiatorUserId ? liveSession.counterpartyUserId : liveSession.initiatorUserId;
    nextLedger = patchTopicLedger(nextLedger, questionTopicKey, {
      state: targetUserId === liveSession.initiatorUserId ? "waiting_initiator" : "waiting_counterparty",
      pendingAnswerUserId: targetUserId,
      lastQuestionTurnId: canonicalTurn.id,
      lastQuestionFingerprint: questionFingerprint,
      lastQuestionAskedByUserId: canonicalTurn.actorUserId || null
    });
    nextActiveTopicKey = questionTopicKey;
  }

  const nextQueue = getTopicQueueSnapshot(liveSession, objectives, nextLedger);
  if (!nextActiveTopicKey || getTopicEntry(nextLedger, nextActiveTopicKey)?.state === "closed") {
    nextActiveTopicKey = chooseNextActiveTopicFromLedger(liveSession, objectives, nextLedger);
  }

  const patchedControl = buildSessionControlPatch(liveSession, {
    automation: {
      topicLedger: nextLedger,
      topicQueueSnapshot: nextQueue,
      activeTopicKey: nextActiveTopicKey,
      lastClosedTopicKey
    }
  });
  updatePrechatSession(liveSession.id, { control: patchedControl });
  const patchedSession = getPrechatSessionById(liveSession.id) || liveSession;
  return persistSessionTopicLedger(
    patchedSession,
    objectives,
    listConversationTurns(liveSession.id),
    listExtractedFacts(liveSession.id),
    {
      activeTopicKey: nextActiveTopicKey,
      topicQueueSnapshot: nextQueue,
      lastClosedTopicKey
    }
  );
}

function maybeReopenTopicFromHumanTurn(session, turn, objectives = [], facts = []) {
  const hintedTopic =
    normalizeTopicKey(turn?.metadata?.fieldKey) ||
    normalizeTopicKey(turn?.metadata?.questionTopic) ||
    inferTopicKeyFromText(turn?.content);
  if (!hintedTopic) {
    return getPrechatSessionById(session.id) || session;
  }

  const currentSession = getPrechatSessionById(session.id) || session;
  const currentControl = getSessionControl(currentSession).automation;
  const currentEntry = getTopicEntry(currentControl.topicLedger, hintedTopic);
  if (!currentEntry || currentEntry.state !== "closed") {
    return currentSession;
  }

  if (!humanTurnSignalsTopicReopen(currentSession, hintedTopic, turn, facts)) {
    return currentSession;
  }

  const nextControl = buildSessionControlPatch(currentSession, {
    automation: {
      topicLedger: patchTopicLedger(currentControl.topicLedger, hintedTopic, {
        state: "reopened_by_human",
        pendingAnswerUserId: null,
        closedAt: null,
        reopenReason: "human_contradiction",
        reopenedAt: turn.createdAt
      }),
      activeTopicKey: hintedTopic,
      lastClosedTopicKey: currentControl.lastClosedTopicKey === hintedTopic ? null : currentControl.lastClosedTopicKey,
      topicQueueSnapshot: [hintedTopic, ...currentControl.topicQueueSnapshot.filter((item) => item !== hintedTopic)]
    }
  });

  updatePrechatSession(currentSession.id, { control: nextControl });
  return persistSessionTopicLedger(getPrechatSessionById(currentSession.id) || currentSession, objectives, listConversationTurns(currentSession.id), facts, {
    activeTopicKey: hintedTopic
  });
}

function normalizeObjectiveSubjectRole(session, subjectUserId) {
  if (!subjectUserId) {
    return null;
  }

  if (subjectUserId === "self" || subjectUserId === session.initiatorUserId) {
    return "initiator";
  }

  if (subjectUserId === "listener" || subjectUserId === session.counterpartyUserId) {
    return "counterparty";
  }

  return subjectUserId === session.initiatorUserId
    ? "initiator"
    : subjectUserId === session.counterpartyUserId
      ? "counterparty"
      : null;
}

function getObjectiveCoverage(session, facts = [], topicKey) {
  const coverage = {
    initiator: false,
    counterparty: false
  };

  for (const fact of facts) {
    if (fact.key !== topicKey || String(fact.status || "confirmed") !== "confirmed") {
      continue;
    }

    const role = normalizeObjectiveSubjectRole(session, fact.subjectUserId);
    if (role) {
      coverage[role] = true;
    }
  }

  return coverage;
}

function isTopicClosedInLedger(session, topicKey) {
  return getTopicEntry(getSessionControl(session).automation.topicLedger, topicKey)?.state === "closed";
}

function hasBothSidesConfirmedTopic(session, facts = [], topicKey) {
  if (isTopicClosedInLedger(session, topicKey)) {
    return true;
  }
  const coverage = getObjectiveCoverage(session, facts, topicKey);
  return coverage.initiator && coverage.counterparty;
}

function isObjectiveSatisfied(session, facts = [], topicKey) {
  return hasBothSidesConfirmedTopic(session, facts, topicKey);
}

function buildObjectives(session, initiatorTwin, counterpartyTwin, facts = []) {
  const selectedKeys = getPreferredObjectiveKeysForSession(session)
    .map((item) => normalizeTopicKey(item))
    .filter(Boolean);
  const selectedPool = TOPIC_CONFIG.filter((topic) => selectedKeys.includes(topic.key));
  const objectives = [];
  const ledger = getSessionControl(session).automation.topicLedger;

  if (selectedKeys.length) {
    for (const topic of selectedPool) {
      if (
        getTopicEntry(ledger, topic.key)?.state === "closed" ||
        isObjectiveSatisfied(session, facts, topic.key) ||
        isSensitiveObjectiveBlocked(session, topic.key)
      ) {
        continue;
      }

      objectives.push(topic);

      if (objectives.length >= MAX_OBJECTIVES) {
        break;
      }
    }

    return objectives;
  }

  for (const topic of TOPIC_CONFIG) {
    if (selectedKeys.includes(topic.key)) {
      continue;
    }

    if (
      getTopicEntry(ledger, topic.key)?.state === "closed" ||
      isObjectiveSatisfied(session, facts, topic.key) ||
      isSensitiveObjectiveBlocked(session, topic.key)
    ) {
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

  return objectives;
}

function buildObjectiveProgress(session, objectives, facts = [], openQuestions = []) {
  const questionText = openQuestions.map((item) => normalizeText(item)).join(" ");
  const ledger = getSessionControl(session).automation.topicLedger;

  return objectives.map((objective) => {
    const ledgerStatus = getTopicLedgerStateLabel(session, objective.key, ledger);

    if (ledgerStatus === "confirmed" || hasBothSidesConfirmedTopic(session, facts, objective.key)) {
      return {
        key: objective.key,
        label: objective.label,
        status: "confirmed"
      };
    }

    const coverage = getObjectiveCoverage(session, facts, objective.key);
    if (
      ledgerStatus === "pending" ||
      coverage.initiator ||
      coverage.counterparty ||
      (questionText && (questionText.includes(objective.label) || questionText.includes(objective.key)))
    ) {
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

function allObjectivesConfirmed(objectiveProgress = [], options = {}) {
  const scopedObjectiveKeys = Array.isArray(options.scopedObjectiveKeys)
    ? options.scopedObjectiveKeys.map((item) => normalizeTopicKey(item)).filter(Boolean)
    : [];
  const normalizedActiveTopicKey = normalizeTopicKey(options.activeTopicKey);
  const effectiveActiveTopicKey =
    scopedObjectiveKeys.length && normalizedActiveTopicKey && !scopedObjectiveKeys.includes(normalizedActiveTopicKey)
      ? null
      : normalizedActiveTopicKey;

  if (options.allCanonicalTopicsClosed && !effectiveActiveTopicKey && !options.hasOutstandingTwinQuestion) {
    return true;
  }

  return (
    objectiveProgress.length > 0 &&
    objectiveProgress.every((item) => item.status === "confirmed") &&
    !effectiveActiveTopicKey &&
    !options.hasOutstandingTwinQuestion
  );
}

function hasTrustedOutstandingTwinQuestion(session, turns = [], round = null) {
  return Boolean(detectOutstandingTwinQuestion(session, turns, round));
}

function isTwinQuestionTurn(turn) {
  return Boolean(turn?.actorUserId) && String(turn.actorRole || "").endsWith("_twin") && textLooksLikeQuestion(turn?.content);
}

function hasAnyTwinTurn(session, turns = []) {
  const resolvedTurns =
    Array.isArray(turns) && (turns.length > 0 || session == null)
      ? turns
      : session?.id
        ? listConversationTurns(session.id)
        : [];
  return resolvedTurns.some((turn) => String(turn?.actorRole || "").endsWith("_twin"));
}

function isEffectiveFirstTwinOpening(session, turns = []) {
  return !hasAnyTwinTurn(session, turns);
}

function buildOpeningRecoveryTurnContext(session, turns = []) {
  const resolvedTurns = Array.isArray(turns) ? turns : [];
  const filteredTurns = resolvedTurns.filter((turn) => String(turn?.actorRole || "").endsWith("_twin"));
  return {
    effectiveFirstOpening: isEffectiveFirstTwinOpening(session, resolvedTurns),
    hasAnyTwinTurn: hasAnyTwinTurn(session, resolvedTurns),
    filteredTurns,
    filteredTurnCount: resolvedTurns.length - filteredTurns.length
  };
}

function getOutstandingTwinQuestionSourceTurn(session, turns = [], round = null) {
  const scopeTurns = round ? turns.filter((turn) => turn.roundId === round.id) : turns;
  const facts = session?.id ? listExtractedFacts(session.id) : [];

  for (let index = scopeTurns.length - 1; index >= 0; index -= 1) {
    const turn = canonicalizeHistoricalTwinTurn(scopeTurns[index], session, scopeTurns);

    if (!isTwinQuestionTurn(turn)) {
      continue;
    }

    if (!isTrustedCanonicalTwinTurn(turn)) {
      continue;
    }

    const metadata = normalizeMessageMetadata(turn.metadata || {});
    const questionTopicKey =
      normalizeTopicKey(metadata.canonical_question_topic_key) ||
      normalizeTopicKey(metadata.emitted_question_topic_key) ||
      normalizeTopicKey(metadata.question_topic_key) ||
      getTurnQuestionTopic(turn);

    if (
      questionTopicKey &&
      (
        isTopicClosedInLedger(session, questionTopicKey) ||
        hasBothSidesConfirmedTopic(session, facts, questionTopicKey)
      )
    ) {
      continue;
    }

    if (
      normalizeText(metadata.repeat_source) === "same_topic_broad_question_repeat" &&
      !normalizeText(metadata.canonical_question_text)
    ) {
      continue;
    }

    const askerUserId = turn.actorUserId;
    const expectedResponderUserId =
      askerUserId === session.initiatorUserId ? session.counterpartyUserId : session.initiatorUserId;
    const answered = scopeTurns
      .slice(index + 1)
      .some((candidate) => {
        if (!String(candidate.actorRole || "").endsWith("_twin") || candidate.actorUserId !== expectedResponderUserId) {
          return false;
        }

        if (!questionTopicKey) {
          return true;
        }

        const candidateMetadata = normalizeMessageMetadata(candidate.metadata || {});
        const candidateReplyTopic =
          normalizeTopicKey(candidateMetadata.canonical_reply_topic_key) ||
          normalizeTopicKey(candidateMetadata.emitted_reply_topic_key) ||
          normalizeTopicKey(candidateMetadata.reply_topic_key);
        const candidateAnsweredRequired =
          candidateMetadata.did_answer_required_question === true ||
          normalizeTopicKey(candidateMetadata.required_reply_topic) === questionTopicKey ||
          normalizeText(candidateMetadata.carryoverTwinQuestionTurnId) === normalizeText(turn.id);

        return candidateReplyTopic === questionTopicKey && candidateAnsweredRequired;
      });

    if (!answered) {
      return turn;
    }
  }

  return null;
}

function detectOutstandingTwinQuestion(session, turns = [], round = null) {
  const resolvedTurns = collapseAdjacentDuplicateTwinTurns(turns || []);
  const sourceTurn = canonicalizeHistoricalTwinTurn(
    getOutstandingTwinQuestionSourceTurn(session, resolvedTurns, round),
    session,
    resolvedTurns
  );

  if (!sourceTurn) {
    return null;
  }

  if (!isCarryoverSourceTurnValid(sourceTurn)) {
    return null;
  }

  const metadata = normalizeMessageMetadata(sourceTurn.metadata || {});
  const askedByUserId = sourceTurn.actorUserId;
  const targetUserId = askedByUserId === session.initiatorUserId ? session.counterpartyUserId : session.initiatorUserId;
  const questionTopic =
    normalizeTopicKey(metadata.canonical_question_topic_key) ||
    normalizeTopicKey(metadata.emitted_question_topic_key) ||
    metadata.carryoverTwinQuestionTopic ||
    inferQuestionTopicFromQuestionText(metadata.canonical_question_text || metadata.emitted_question_text || "") ||
    inferQuestionTopicFromQuestionText(extractTrailingQuestionText(sourceTurn.content));

  return {
    sourceTurn,
    askedByUserId,
    targetUserId,
    questionText: normalizeText(
      metadata.canonical_question_text ||
        metadata.emitted_question_text ||
        extractTrailingQuestionText(sourceTurn.content) ||
        sourceTurn.content
    ),
    questionTopic,
    carryover_source_valid: metadata.carryover_source_valid !== false
  };
}

function canonicalizeHistoricalTwinTurn(turn, session, turns = []) {
  if (!turn || !String(turn.actorRole || "").endsWith("_twin")) {
    return turn;
  }

  const metadata = normalizeMessageMetadata(turn.metadata || {});
  const needsRuntimeRebuild =
    metadata.canonical_outcome_trusted === false ||
    shouldRuntimeRebuildHistoricalTwinTurn(metadata, turn.content) ||
    !metadata.frame_version ||
    (!metadata.canonical_question_text && !metadata.canonical_reply_topic_key);

  if (!needsRuntimeRebuild) {
    return {
      ...turn,
      metadata
    };
  }

  const previousTurns = turns.filter((candidate) => candidate && candidate.id !== turn.id);
  const liveSession = session?.id ? getPrechatSessionById(session.id) || session : session;
  const speakerUserId = turn.actorUserId || null;
  const listenerUserId =
    liveSession && speakerUserId
      ? liveSession.initiatorUserId === speakerUserId
        ? liveSession.counterpartyUserId
        : liveSession.initiatorUserId
      : null;
  const canonicalizedMetadata = buildCanonicalTurnOutcome(
    {
      reply: normalizeText(metadata.reply || turn.content),
      reply_topic_key: metadata.reply_topic_key || null,
      question_topic_key: metadata.question_topic_key || null,
      confirmed_facts: Array.isArray(metadata.confirmed_facts) ? metadata.confirmed_facts : [],
      open_questions: Array.isArray(metadata.open_questions) ? metadata.open_questions : [],
      emitted_reply_topic_key: metadata.emitted_reply_topic_key || null,
      emitted_question_topic_key: metadata.emitted_question_topic_key || null,
      emitted_question_text: metadata.emitted_question_text || null,
      answer_segment_dropped_by_rewrite: metadata.answer_segment_dropped_by_rewrite,
      rewrite_preserved_answer_topic: metadata.rewrite_preserved_answer_topic || null,
      rewrite_target_topic: metadata.rewrite_target_topic || null,
      alignment_issue: metadata.alignment_issue || null
    },
    {
      frame_version: metadata.frame_version || "historical_runtime_v1",
      reply_obligation: "none",
      reply_target: {
        text: metadata.required_reply_text || null,
        topicKey: metadata.required_reply_topic || null,
        askedByUserId: null,
        sourceTurnId: null
      },
      topic_plan: {
        activeTopicKey:
          normalizeTopicKey(metadata.rewrite_target_topic) ||
          normalizeTopicKey(metadata.canonical_question_topic_key) ||
          normalizeTopicKey(metadata.question_topic_key) ||
          null
      }
    },
    {
      activeTopicKey:
        normalizeTopicKey(metadata.rewrite_target_topic) ||
        normalizeTopicKey(metadata.canonical_question_topic_key) ||
        normalizeTopicKey(metadata.question_topic_key) ||
        null,
      latestListenerQuestionTopic:
        normalizeTopicKey(metadata.required_reply_topic) ||
        normalizeTopicKey(metadata.canonical_question_topic_key) ||
        normalizeTopicKey(metadata.question_topic_key) ||
        null,
      speakerUserId,
      listenerUserId
    }
  );
  const historicalTurnDowngraded =
    metadata.canonical_outcome_trusted === false ||
    shouldRuntimeRebuildHistoricalTwinTurn(metadata, turn.content);

  return {
    ...turn,
    metadata: normalizeMessageMetadata({
      ...metadata,
      ...persistFinalCanonicalTurnMetadata(
        canonicalizedMetadata,
        {
          frame_version: metadata.frame_version || "historical_runtime_v1",
          reply_obligation: "none",
          reply_target: {
            text: metadata.required_reply_text || null,
            topicKey: metadata.required_reply_topic || null,
            askedByUserId: null,
            sourceTurnId: null
          },
          topic_plan: {
            activeTopicKey:
              normalizeTopicKey(metadata.rewrite_target_topic) ||
              normalizeTopicKey(metadata.canonical_question_topic_key) ||
              normalizeTopicKey(metadata.question_topic_key) ||
              null
          }
        },
        {
          activeTopicKey:
            normalizeTopicKey(metadata.rewrite_target_topic) ||
            normalizeTopicKey(metadata.canonical_question_topic_key) ||
            normalizeTopicKey(metadata.question_topic_key) ||
            null,
          latestListenerQuestionTopic:
            normalizeTopicKey(metadata.required_reply_topic) ||
            normalizeTopicKey(metadata.canonical_question_topic_key) ||
            normalizeTopicKey(metadata.question_topic_key) ||
            null,
          speakerUserId,
          listenerUserId
        }
      ),
      historical_turn_downgraded: historicalTurnDowngraded,
      carryover_source_valid: isCarryoverSourceTurnValid({
        ...turn,
        metadata: canonicalizedMetadata
      }),
      canonical_outcome_trusted: !historicalTurnDowngraded &&
        isCarryoverSourceTurnValid({
          ...turn,
          metadata: canonicalizedMetadata
        })
    })
  };
}

function getOutstandingTwinQuestionRecovery(detail) {
  if (!detail?.session) {
    return null;
  }

  const latestRound = Array.isArray(detail.rounds) && detail.rounds.length ? detail.rounds[detail.rounds.length - 1] : null;
  const outstanding = detectOutstandingTwinQuestion(detail.session, detail.turns || [], latestRound);

  if (!outstanding) {
    return null;
  }

  return {
    ...outstanding,
    latestRound
  };
}

function getSessionWideOutstandingTwinQuestionRecovery(detail) {
  if (!detail?.session) {
    return null;
  }

  const outstanding = detectOutstandingTwinQuestion(detail.session, detail.turns || [], null);
  if (!outstanding) {
    return null;
  }

  return {
    ...outstanding,
    latestRound: getLatestRoundFromDetail(detail)
  };
}

function getLatestOutstandingTwinQuestionRecoveryForSession(sessionId, actorUserId) {
  const detail = getSessionDetailForUser(sessionId, actorUserId);
  if (!detail?.session) {
    return null;
  }

  return getOutstandingTwinQuestionRecovery(detail);
}

function getLatestResolvedManualReview(detail) {
  const requests = Array.isArray(detail?.humanInputRequests) ? detail.humanInputRequests : [];
  return (
    requests
      .filter((request) => request.status === "resolved" && request.fieldKey === "manual_review")
      .sort((left, right) => String(right.resolvedAt || right.createdAt || "").localeCompare(String(left.resolvedAt || left.createdAt || "")))[0] ||
    null
  );
}

function isResolvedManualReviewRecovery(detail) {
  if (!detail?.session || detail.session.status !== "paused_review") {
    return false;
  }

  if (isManualPauseActive(detail.session) || hasPendingHumanInput(detail) || hasPendingSensitiveApproval(detail)) {
    return false;
  }

  const latestRound = Array.isArray(detail.rounds) && detail.rounds.length ? detail.rounds[detail.rounds.length - 1] : null;
  if (!latestRound || latestRound.stopReason !== "outstanding_twin_question_unanswered") {
    return false;
  }

  return Boolean(getLatestResolvedManualReview(detail) && detectOutstandingTwinQuestion(detail.session, detail.turns || [], latestRound));
}

function createManualReviewRecoveryPause({
  session,
  round,
  participants,
  targetUserId,
  sourceTurnId,
  questionText = "模型输出不可用，需要人工确认。"
}) {
  const targetParticipant =
    targetUserId === participants.initiator.userId ? participants.initiator : participants.counterparty;

  createHumanInputRequest({
    sessionId: session.id,
    roundId: round.id,
    targetUserId,
    fieldKey: "manual_review",
    questionText,
    metadata: {
      source: "manual_review_recovery",
      sourceTurnId,
      resumeSource: "manual_review"
    }
  });

  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: getLatestTurnNumber(round.id) + 1,
    actorUserId: null,
    actorRole: "system",
    content: "系统暂停：上一轮人工补充后，当前信息仍不足以继续稳定回答，已再次转为需要本人补充。",
    metadata: {
      pauseReason: "pending_human_input",
      targetUserId,
      fieldKey: "manual_review",
      source: "manual_review_recovery",
      sourceTurnId,
      targetDisplayName: targetParticipant?.displayName || "对方"
    }
  });

  return completeRound(session, round, "pending_human_input", "pending_human_input");
}

function shouldContinueForOutstandingTwinQuestion(session, round, turns = [], nextTurnNumber, softLimitExceeded = false) {
  const outstanding = detectOutstandingTwinQuestion(session, turns, round);

  if (!outstanding) {
    return null;
  }

  if (softLimitExceeded && nextTurnNumber > MAX_TURNS_PER_ROUND + 1) {
    return null;
  }

  return outstanding;
}

function buildRoundProgressSnapshot(session, objectives = [], turns = [], round = null) {
  const facts = listExtractedFacts(session.id);
  const progress = buildObjectiveProgress(session, objectives, facts);
  const activeTopicKey = getScopedActiveTopicKey(session, round, objectives);
  const outstanding = detectOutstandingTwinQuestion(session, turns, round);
  const progressKey = progress
    .map((item) => `${item.key}:${item.status}`)
    .sort()
    .join("|");

  return {
    progressKey,
    activeTopicKey: activeTopicKey || null,
    outstandingQuestionTurnId: normalizeText(outstanding?.sourceTurn?.id) || null,
    outstandingQuestionTargetUserId: normalizeText(outstanding?.targetUserId) || null,
    allObjectivesConfirmed: allObjectivesConfirmed(progress, {
      activeTopicKey,
      hasOutstandingTwinQuestion: Boolean(outstanding),
      allCanonicalTopicsClosed: areAllCanonicalTopicsClosed(session),
      scopedObjectiveKeys: getEffectiveScopedObjectiveKeys(session, round, objectives)
    })
  };
}

function didRoundProgressAdvance(previousSnapshot = null, nextSnapshot = null) {
  if (!previousSnapshot || !nextSnapshot) {
    return true;
  }

  if (previousSnapshot.allObjectivesConfirmed !== nextSnapshot.allObjectivesConfirmed) {
    return true;
  }

  return (
    previousSnapshot.progressKey !== nextSnapshot.progressKey ||
    previousSnapshot.activeTopicKey !== nextSnapshot.activeTopicKey ||
    previousSnapshot.outstandingQuestionTurnId !== nextSnapshot.outstandingQuestionTurnId ||
    previousSnapshot.outstandingQuestionTargetUserId !== nextSnapshot.outstandingQuestionTargetUserId
  );
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

function buildQuestionFingerprint(text, topicKey = null) {
  const normalizedTopicKey = normalizeTopicKey(topicKey);
  const normalizedText = normalizeText(text);
  if (!normalizedText) {
    return null;
  }

  if (
    normalizedTopicKey === "cities" &&
    /(城市|深圳|广州|上海|杭州|北京|定居|留在|长期.{0,10}(哪个|什么).{0,6}城市|在哪.{0,6}城市)/u.test(normalizedText)
  ) {
    return "cities:broad_preference";
  }

  if (
    normalizedTopicKey === "financialView" &&
    /(财务|金钱观|消费观|消费|储蓄|负债|债务|隐性负债|务实稳定|财务安排|经济安排)/u.test(normalizedText)
  ) {
    return "financialView:broad_principle";
  }

  if (
    normalizedTopicKey === "childrenPreference" &&
    /(孩子|生育|备孕|丁克)/u.test(normalizedText)
  ) {
    return "childrenPreference:broad_preference";
  }

  const comparable = normalizeComparableText(text)
    .replace(/^(你这边|你呢|那你|那你这边|你会|你更会|你更偏向|你更倾向|你更看重)/gu, "")
    .replace(/(未来|长期|目前|现在|会更|更)/gu, "")
    .replace(/(在哪个城市|哪个城市|城市生活|城市安排|生活安排|财务安排|经济安排)/gu, "")
    .replace(/(原则|想法|态度|节奏|考虑|安排)$/gu, "")
    .trim();

  if (!comparable) {
    return null;
  }

  return normalizedTopicKey ? `${normalizedTopicKey}:${comparable}` : comparable;
}

function getCoverageFromFactsWithCurrentResult(session, facts = [], resultFacts = [], topicKey) {
  return getObjectiveCoverage(session, [...facts, ...(Array.isArray(resultFacts) ? resultFacts : [])], topicKey);
}

function canTopicCloseAfterCurrentResult(session, facts = [], resultFacts = [], topicKey) {
  const normalizedTopicKey = normalizeTopicKey(topicKey);
  if (!normalizedTopicKey) {
    return false;
  }
  const coverage = getCoverageFromFactsWithCurrentResult(session, facts, resultFacts, normalizedTopicKey);
  return coverage.initiator && coverage.counterparty;
}

function buildResolvedFactForTopicFromProfile(profile, topicKey, speakerUserId) {
  const card = buildFactCard(profile, topicKey);
  if (!card?.normalizedSummary || !speakerUserId) {
    return null;
  }

  return {
    subjectUserId: speakerUserId,
    key: normalizeTopicKey(topicKey),
    value: card.normalizedSummary,
    confidence: 0.92,
    status: "confirmed"
  };
}

function resolveTopicCloseDecision({
  session,
  factsForValidation = [],
  resultFacts = [],
  topicKey = null,
  speaker = null,
  canonicalReplyTopicKey = null,
  didAnswerRequiredQuestion = false,
  latestListenerQuestionTopic = null
}) {
  const normalizedTopicKey = normalizeTopicKey(topicKey);
  const ledgerCoverage = normalizedTopicKey
    ? normalizeTopicCoverage(getTopicEntry(getSessionControl(session).automation.topicLedger, normalizedTopicKey)?.coverage)
    : null;
  const factCoverageBefore = normalizedTopicKey
    ? getObjectiveCoverage(session, factsForValidation, normalizedTopicKey)
    : null;
  const coverageBefore = factCoverageBefore
    ? {
        initiator: factCoverageBefore.initiator || Boolean(ledgerCoverage?.initiator),
        counterparty: factCoverageBefore.counterparty || Boolean(ledgerCoverage?.counterparty)
      }
    : ledgerCoverage;

  if (!normalizedTopicKey) {
    return {
      canClose: false,
      source: "missing_topic",
      coverageBefore,
      coverageAfter: coverageBefore,
      factsUsed: []
    };
  }

  const normalizedResultFacts = Array.isArray(resultFacts)
    ? resultFacts.filter((fact) => normalizeTopicKey(fact?.key) === normalizedTopicKey)
    : [];
  const directCoverage = getCoverageFromFactsWithCurrentResult(
    session,
    factsForValidation,
    normalizedResultFacts,
    normalizedTopicKey
  );
  const mergedDirectCoverage = {
    initiator: directCoverage.initiator || Boolean(ledgerCoverage?.initiator),
    counterparty: directCoverage.counterparty || Boolean(ledgerCoverage?.counterparty)
  };

  if (mergedDirectCoverage.initiator && mergedDirectCoverage.counterparty) {
    return {
      canClose: true,
      source: "result_facts",
      coverageBefore,
      coverageAfter: mergedDirectCoverage,
      factsUsed: normalizedResultFacts
    };
  }

  const canUseSpeakerProfileFallback =
    speaker &&
    normalizeTopicKey(canonicalReplyTopicKey) === normalizedTopicKey &&
    didAnswerRequiredQuestion &&
    normalizeTopicKey(latestListenerQuestionTopic) === normalizedTopicKey;
  const fallbackFact = canUseSpeakerProfileFallback
    ? buildResolvedFactForTopicFromProfile(speaker, normalizedTopicKey, speaker.userId)
    : null;
  const mergedFacts = fallbackFact
    ? [...normalizedResultFacts, fallbackFact]
    : normalizedResultFacts;
  const mergedCoverage = getCoverageFromFactsWithCurrentResult(
    session,
    factsForValidation,
    mergedFacts,
    normalizedTopicKey
  );
  const ledgerAwareMergedCoverage = {
    initiator: mergedCoverage.initiator || Boolean(ledgerCoverage?.initiator),
    counterparty: mergedCoverage.counterparty || Boolean(ledgerCoverage?.counterparty)
  };

  return {
    canClose: ledgerAwareMergedCoverage.initiator && ledgerAwareMergedCoverage.counterparty,
    source: fallbackFact ? "speaker_fact_card_fallback" : "result_facts_incomplete",
    coverageBefore,
    coverageAfter: ledgerAwareMergedCoverage,
    factsUsed: mergedFacts
  };
}

function shouldPreserveAnswerSegmentForTopicRewrite({
  answerText = "",
  latestListenerQuestionTopic = null
}) {
  const normalizedAnswerText = normalizeText(answerText);
  const normalizedLatestListenerQuestionTopic = normalizeTopicKey(latestListenerQuestionTopic);
  if (!normalizedAnswerText || !normalizedLatestListenerQuestionTopic) {
    return false;
  }

  return inferAnswerTopicFromAnswerSegment(normalizedAnswerText, null, normalizedLatestListenerQuestionTopic) === normalizedLatestListenerQuestionTopic;
}

function canonicalizeConfirmedFactsForFinalReply({
  confirmedFacts = [],
  answerTopicKey = null,
  speakerUserId = null,
  listenerUserId = null
}) {
  const normalizedAnswerTopicKey = normalizeTopicKey(answerTopicKey);
  const droppedFactKeys = [];
  const acceptedFacts = [];

  for (const fact of Array.isArray(confirmedFacts) ? confirmedFacts : []) {
    const normalizedFactKey = normalizeTopicKey(fact?.key);
    const resolvedSubjectUserId = resolveFactSubjectUserId(fact?.subjectUserId, speakerUserId, listenerUserId);
    const nextFact = {
      ...fact,
      key: normalizedFactKey,
      subjectUserId: resolvedSubjectUserId
    };

    if (!normalizedAnswerTopicKey || !normalizedFactKey || normalizedFactKey !== normalizedAnswerTopicKey) {
      if (normalizedFactKey) {
        droppedFactKeys.push(normalizedFactKey);
      }
      continue;
    }

    acceptedFacts.push(nextFact);
  }

  return {
    confirmedFacts: acceptedFacts,
    droppedFactKeys: [...new Set(droppedFactKeys)]
  };
}

function canonicalizeFinalTurnOutcome(result, context = {}) {
  if (!result || typeof result !== "object") {
    return result;
  }

  const normalizedReply = normalizeText(result.reply);
  const { answerText, questionText } = splitReplyIntoAnswerAndTrailingQuestion(normalizedReply);
  const normalizedAnswerText = normalizeText(answerText);
  const normalizedQuestionText = normalizeText(questionText);
  const substantiveAnswerText = shouldTreatLeadingAnswerSegmentAsSubstantive(normalizedAnswerText, context)
    ? normalizedAnswerText
    : "";
  const hasAnswerSegment = Boolean(substantiveAnswerText);
  const canonicalReplyTopicKey = hasAnswerSegment
    ? inferAnswerTopicFromAnswerSegment(
        substantiveAnswerText,
        context.activeTopicKey,
        context.latestListenerQuestionTopic
      )
    : null;
  const canonicalQuestionTopicKey = normalizedQuestionText
    ? inferQuestionTopicFromQuestionText(normalizedQuestionText)
    : null;
  const {
    confirmedFacts: canonicalConfirmedFacts,
    droppedFactKeys
  } = canonicalizeConfirmedFactsForFinalReply({
    confirmedFacts: result.confirmed_facts,
    answerTopicKey: canonicalReplyTopicKey,
    speakerUserId: context.speakerUserId,
    listenerUserId: context.listenerUserId
  });
  const nextOpenQuestions = normalizedQuestionText ? [normalizedQuestionText] : [];
  const questionFingerprint = normalizedQuestionText
    ? buildQuestionFingerprint(normalizedQuestionText, canonicalQuestionTopicKey)
    : null;
  const originalReplyTopicKey = normalizeTopicKey(result.reply_topic_key);
  const originalQuestionTopicKey = normalizeTopicKey(result.question_topic_key);
  const normalizedOpenQuestions = Array.isArray(result.open_questions)
    ? result.open_questions.map((item) => normalizeText(item)).filter(Boolean)
    : [];
  const alignmentIssues = [];

  if (normalizedQuestionText && originalQuestionTopicKey && canonicalQuestionTopicKey && originalQuestionTopicKey !== canonicalQuestionTopicKey) {
    alignmentIssues.push("question_topic_mismatch");
  }
  if (!normalizedQuestionText && originalQuestionTopicKey) {
    alignmentIssues.push("stale_question_topic");
  }
  if (hasAnswerSegment && canonicalReplyTopicKey && originalReplyTopicKey && canonicalReplyTopicKey !== originalReplyTopicKey) {
    alignmentIssues.push("reply_topic_mismatch");
  }
  if (JSON.stringify(normalizedOpenQuestions) !== JSON.stringify(nextOpenQuestions)) {
    alignmentIssues.push("open_questions_mismatch");
  }
  if (droppedFactKeys.length) {
    alignmentIssues.push("confirmed_facts_mismatch");
  }
  if (!hasAnswerSegment && normalizedAnswerText) {
    alignmentIssues.push("non_substantive_answer_segment");
  }

  return {
    ...result,
    reply: normalizedReply,
    reply_topic_key: hasAnswerSegment ? canonicalReplyTopicKey || null : null,
    question_topic_key: canonicalQuestionTopicKey || null,
    confirmed_facts: canonicalConfirmedFacts,
    open_questions: nextOpenQuestions,
    emitted_reply_topic_key: hasAnswerSegment ? canonicalReplyTopicKey || null : null,
    emitted_question_topic_key: canonicalQuestionTopicKey || null,
    emitted_question_text: normalizedQuestionText || null,
    canonical_reply_topic_key: hasAnswerSegment ? canonicalReplyTopicKey || null : null,
    canonical_question_topic_key: canonicalQuestionTopicKey || null,
    canonical_question_text: normalizedQuestionText || null,
    canonical_answer_text: hasAnswerSegment ? substantiveAnswerText : null,
    question_fingerprint: questionFingerprint || null,
    dropped_confirmed_fact_keys: droppedFactKeys,
    answer_segment_dropped_by_rewrite: Boolean(result.answer_segment_dropped_by_rewrite),
    rewrite_preserved_answer_topic: normalizeTopicKey(result.rewrite_preserved_answer_topic) || null,
    rewrite_target_topic: normalizeTopicKey(result.rewrite_target_topic) || null,
    alignment_issue: alignmentIssues.length ? [...new Set(alignmentIssues)].join(",") : null
  };
}

function getMostRecentQuestionForTopic(turns = [], topicKey) {
  const normalizedTopicKey = normalizeTopicKey(topicKey);
  if (!normalizedTopicKey) {
    return null;
  }

  return [...turns]
    .reverse()
    .find((turn) => String(turn.actorRole || "").endsWith("_twin") && getTurnQuestionTopic(turn) === normalizedTopicKey) || null;
}

function getCanonicalQuestionFingerprintFromMetadata(metadata = {}, fallbackContent = "") {
  const normalizedMetadata = normalizeMessageMetadata(metadata || {});
  const canonicalQuestionText = normalizeText(
    normalizedMetadata.canonical_question_text ||
      normalizedMetadata.emitted_question_text ||
      extractTrailingQuestionText(fallbackContent)
  );
  const canonicalQuestionTopic =
    normalizeTopicKey(normalizedMetadata.canonical_question_topic_key) ||
    normalizeTopicKey(normalizedMetadata.emitted_question_topic_key) ||
    normalizeTopicKey(normalizedMetadata.question_topic_key) ||
    inferQuestionTopicFromQuestionText(canonicalQuestionText);
  return canonicalQuestionText
    ? buildQuestionFingerprint(canonicalQuestionText, canonicalQuestionTopic)
    : null;
}

function isSameTopicBroadQuestionRepeat({
  session,
  turns = [],
  topicKey,
  questionText = "",
  speakerUserId = null
}) {
  const normalizedTopicKey = normalizeTopicKey(topicKey);
  const normalizedQuestionText = normalizeText(questionText);
  if (!normalizedTopicKey || !normalizedQuestionText) {
    return false;
  }

  const latestQuestionTurn = getMostRecentQuestionForTopic(turns, normalizedTopicKey);
  if (!latestQuestionTurn) {
    return false;
  }

  const latestFingerprint =
    getCanonicalQuestionFingerprintFromMetadata(latestQuestionTurn?.metadata || {}, latestQuestionTurn?.content) ||
    buildQuestionFingerprint(
      normalizeText(
        latestQuestionTurn?.metadata?.canonical_question_text ||
          latestQuestionTurn?.metadata?.emitted_question_text ||
          extractTrailingQuestionText(latestQuestionTurn?.content)
      ),
      normalizedTopicKey
    );
  const nextFingerprint = buildQuestionFingerprint(normalizedQuestionText, normalizedTopicKey);

  if (!latestFingerprint || !nextFingerprint) {
    return false;
  }

  if (latestFingerprint !== nextFingerprint) {
    return false;
  }

  const latestQuestionIndex = turns.findIndex((turn) => turn.id === latestQuestionTurn.id);
  const latestQuestionActorUserId = normalizeText(latestQuestionTurn.actorUserId) || null;
  const askedAgainBySameSpeaker = Boolean(
    speakerUserId &&
      latestQuestionActorUserId &&
      normalizeText(speakerUserId) === latestQuestionActorUserId
  );
  const humanReopenedAfterQuestion = turns
    .slice(latestQuestionIndex + 1)
    .some((turn) => isHumanUserTurn(turn) && humanTurnSignalsTopicReopen(session, normalizedTopicKey, turn, listExtractedFacts(session.id)));

  return askedAgainBySameSpeaker || !humanReopenedAfterQuestion;
}

function getTopicCoverageSnapshot(session, facts = [], resultFacts = [], topicKey) {
  const before = getObjectiveCoverage(session, facts, topicKey);
  const after = getCoverageFromFactsWithCurrentResult(session, facts, resultFacts, topicKey);
  return {
    before,
    after
  };
}

function getParticipantRoleForUserId(session, userId) {
  const normalizedUserId = normalizeText(userId);
  if (!session || !normalizedUserId) {
    return null;
  }
  if (normalizedUserId === normalizeText(session.initiatorUserId)) {
    return "initiator";
  }
  if (normalizedUserId === normalizeText(session.counterpartyUserId)) {
    return "counterparty";
  }
  return null;
}

function hasEquivalentOutstandingTwinQuestionForTopic(session, turns = [], topicKey, targetUserId = null, sourceQuestionText = "") {
  const normalizedTopicKey = normalizeTopicKey(topicKey);
  const normalizedTargetUserId = normalizeText(targetUserId);
  const normalizedQuestionText = normalizeText(sourceQuestionText);
  if (!session || !normalizedTopicKey || !normalizedTargetUserId) {
    return false;
  }

  const outstanding = detectOutstandingTwinQuestion(session, turns, null);
  if (!outstanding) {
    return false;
  }

  if (
    normalizeTopicKey(outstanding.questionTopic) !== normalizedTopicKey ||
    normalizeText(outstanding.targetUserId) !== normalizedTargetUserId
  ) {
    return false;
  }

  if (!normalizedQuestionText) {
    return true;
  }

  const outstandingFingerprint =
    getCanonicalQuestionFingerprintFromMetadata(
      outstanding.sourceTurn?.metadata || {},
      outstanding.sourceTurn?.content || ""
    ) ||
    buildQuestionFingerprint(normalizeText(outstanding.questionText), normalizedTopicKey);
  const sourceFingerprint = buildQuestionFingerprint(normalizedQuestionText, normalizedTopicKey);

  if (outstandingFingerprint && sourceFingerprint && outstandingFingerprint === sourceFingerprint) {
    return true;
  }

  return isNearDuplicateText(normalizedQuestionText, outstanding.questionText);
}

function shouldAllowMirrorQuestionForCoverage({
  session,
  turns = [],
  topicKey,
  questionText = "",
  speakerUserId = null,
  listenerUserId = null,
  latestListenerQuestionTopic = null,
  resultFacts = [],
  didAnswerRequiredQuestion = false
}) {
  const normalizedTopicKey = normalizeTopicKey(topicKey);
  const normalizedQuestionText = normalizeText(questionText);
  if (!session || !normalizedTopicKey || !normalizedQuestionText || !speakerUserId || !listenerUserId) {
    return {
      allowed: false,
      required: false,
      reason: "missing_context",
      coverageBefore: null,
      coverageAfter: null
    };
  }

  const facts = listExtractedFacts(session.id);
  const { before, after } = getTopicCoverageSnapshot(session, facts, resultFacts, normalizedTopicKey);
  const speakerRole = getParticipantRoleForUserId(session, speakerUserId);
  const listenerRole = getParticipantRoleForUserId(session, listenerUserId);
  const latestTopic = normalizeTopicKey(latestListenerQuestionTopic);

  if (!speakerRole || !listenerRole) {
    return {
      allowed: false,
      required: false,
      reason: "unknown_participant_role",
      coverageBefore: before,
      coverageAfter: after
    };
  }

  if (after.initiator && after.counterparty) {
    return {
      allowed: false,
      required: false,
      reason: "topic_already_closed",
      coverageBefore: before,
      coverageAfter: after
    };
  }

  const hasCanonicalAnswer = Array.isArray(resultFacts) && resultFacts.some((fact) => normalizeTopicKey(fact?.key) === normalizedTopicKey);
  if ((!didAnswerRequiredQuestion && !hasCanonicalAnswer) || latestTopic !== normalizedTopicKey) {
    return {
      allowed: false,
      required: false,
      reason: "required_question_not_answered",
      coverageBefore: before,
      coverageAfter: after
    };
  }

  if (!before[speakerRole] && !after[speakerRole]) {
    return {
      allowed: false,
      required: false,
      reason: "speaker_still_missing_coverage",
      coverageBefore: before,
      coverageAfter: after
    };
  }

  if (before[listenerRole] || after[listenerRole]) {
    return {
      allowed: false,
      required: false,
      reason: "listener_already_covered",
      coverageBefore: before,
      coverageAfter: after
    };
  }

  if (
    hasEquivalentOutstandingTwinQuestionForTopic(
      session,
      turns,
      normalizedTopicKey,
      listenerUserId,
      normalizedQuestionText
    )
  ) {
    return {
      allowed: false,
      required: true,
      reason: "existing_equivalent_outstanding_question",
      coverageBefore: before,
      coverageAfter: after
    };
  }

  return {
    allowed: true,
    required: true,
    reason: "mirror_question_required_for_missing_listener_coverage",
    coverageBefore: before,
    coverageAfter: after
  };
}

function canAutoRecoverRepeatFalsePositivePendingRequest(detail, request) {
  const session = detail?.session;
  if (!session || session.status !== "pending_human_input" || !request || request.status !== "pending") {
    return false;
  }

  if (normalizeText(request.questionText) !== "这轮预沟通出现了重复问答，请本人确认这一题的真实答案。") {
    return false;
  }

  const latestTwinTurn = (detail.turns || []).filter((turn) => String(turn.actorRole || "").endsWith("_twin")).slice(-1)[0];
  if (!latestTwinTurn) {
    return false;
  }

  const metadata = normalizeMessageMetadata(latestTwinTurn.metadata || {});
  const topicKey =
    normalizeTopicKey(metadata.canonical_reply_topic_key) ||
    normalizeTopicKey(metadata.emitted_reply_topic_key) ||
    normalizeTopicKey(request.fieldKey);
  const sourceTurn = resolveRepeatFalsePositiveCanonicalSourceTurn(detail, request);
  const carryoverResolved =
    metadata.carryoverTwinQuestionAnswered === true &&
    !normalizeText(metadata.canonical_question_text) &&
    Boolean(normalizeText(metadata.carryoverTwinQuestionTurnId));
  const latestResolvedCarryoverMatchesSource =
    carryoverResolved &&
    Boolean(sourceTurn?.id) &&
    normalizeText(metadata.carryoverTwinQuestionTurnId) === normalizeText(sourceTurn.id);
  if (
    normalizeText(metadata.repeat_source) !== "same_topic_broad_question_repeat" ||
    metadata.did_answer_required_question !== true ||
    normalizeText(metadata.canonical_question_text) ||
    !topicKey
  ) {
    if (latestResolvedCarryoverMatchesSource) {
      const coverage = getObjectiveCoverage(session, detail.facts || [], topicKey);
      return coverage.initiator && coverage.counterparty;
    }

    if (
      metadata.did_answer_required_question === true &&
      !normalizeText(metadata.canonical_question_text) &&
      topicKey
    ) {
      const coverage = getObjectiveCoverage(session, detail.facts || [], topicKey);
      return !(coverage.initiator && coverage.counterparty);
    }

    const sourceTurnId = normalizeText(request.metadata?.sourceTurnId) || normalizeText(sourceTurn?.id);
    const sessionWideOutstanding = getSessionWideOutstandingTwinQuestionRecovery(detail);
    if (
      !sourceTurnId ||
      !sessionWideOutstanding?.sourceTurn?.id ||
      normalizeText(sessionWideOutstanding.sourceTurn.id) === sourceTurnId
    ) {
      return false;
    }

    return (detail.turns || []).some((turn) => {
      const turnMetadata = normalizeMessageMetadata(turn.metadata || {});
      return (
        turnMetadata.carryoverTwinQuestionAnswered === true &&
        normalizeText(turnMetadata.carryoverTwinQuestionTurnId) === sourceTurnId
      );
    });
  }

  const coverage = getObjectiveCoverage(session, detail.facts || [], topicKey);
  return !(coverage.initiator && coverage.counterparty);
}

function resolveRepeatFalsePositiveSourceTurn(detail, request) {
  const sourceTurnId = normalizeText(request?.metadata?.sourceTurnId);
  if (sourceTurnId) {
    return (detail?.turns || []).find((turn) => turn.id === sourceTurnId) || getConversationTurnById(sourceTurnId);
  }

  const normalizedRoundId = normalizeText(request?.roundId);
  const requestedTurnNumber = Number(request?.metadata?.turnNumber);
  const twinTurns = (detail?.turns || [])
    .filter(
      (turn) =>
        String(turn?.actorRole || "").endsWith("_twin") &&
        (!normalizedRoundId || normalizeText(turn?.roundId) === normalizedRoundId)
    )
    .sort((left, right) => Number(left?.turnNumber || 0) - Number(right?.turnNumber || 0));

  if (Number.isFinite(requestedTurnNumber)) {
    const priorTwinTurn = twinTurns.find((turn) => Number(turn?.turnNumber || 0) === Math.max(0, requestedTurnNumber - 1));
    if (priorTwinTurn) {
      return priorTwinTurn;
    }
  }

  return twinTurns.length ? twinTurns[twinTurns.length - 1] : null;
}

function resolveRepeatFalsePositiveCanonicalSourceTurn(detail, request) {
  const sourceTurn = resolveRepeatFalsePositiveSourceTurn(detail, request);
  if (!sourceTurn) {
    return null;
  }

  const sourceMetadata = normalizeMessageMetadata(sourceTurn.metadata || {});
  const carryoverSourceTurnId = normalizeText(sourceMetadata.carryoverTwinQuestionTurnId);
  if (sourceMetadata.carryoverTwinQuestionAnswered === true && carryoverSourceTurnId) {
    return (detail?.turns || []).find((turn) => normalizeText(turn.id) === carryoverSourceTurnId) ||
      getConversationTurnById(carryoverSourceTurnId);
  }

  return sourceTurn;
}

function isRecoverableRepeatFalsePositivePendingRequest(detail) {
  const session = detail?.session;
  if (!session || session.status !== "pending_human_input") {
    return false;
  }

  if (isManualPauseActive(session)) {
    return false;
  }

  const pendingRequests = (detail.humanInputRequests || []).filter((request) => request.status === "pending");
  if (!pendingRequests.length) {
    return false;
  }

  return pendingRequests.every((request) => canAutoRecoverRepeatFalsePositivePendingRequest(detail, request));
}

function buildCanonicalMirrorQuestionForPendingTopic(session, topicKey) {
  const normalizedTopicKey = normalizeTopicKey(topicKey);
  if (!normalizedTopicKey) {
    return null;
  }

  return buildObjectiveQuestionV2(TOPIC_CONFIG.find((item) => item.key === normalizedTopicKey) || { key: normalizedTopicKey });
}

function derivePostAnswerContinuation({
  session,
  objectives,
  turns = [],
  speakerUserId = null,
  listenerUserId = null,
  result,
  activeTopicKey = null
}) {
  const emittedReplyTopicKey =
    normalizeTopicKey(result?.canonical_reply_topic_key) ||
    normalizeTopicKey(result?.emitted_reply_topic_key) ||
    normalizeTopicKey(result?.reply_topic_key);
  const emittedQuestionTopicKey =
    normalizeTopicKey(result?.canonical_question_topic_key) ||
    normalizeTopicKey(result?.emitted_question_topic_key) ||
    normalizeTopicKey(result?.question_topic_key);
  const canonicalQuestionText = normalizeText(result?.canonical_question_text || result?.emitted_question_text);
  const normalizedActiveTopicKey = normalizeTopicKey(activeTopicKey);
  const normalizedListenerUserId = normalizeText(listenerUserId);
  const latestTurn = turns.length ? turns[turns.length - 1] : null;
  const latestTurnMetadata = normalizeMessageMetadata(latestTurn?.metadata || {});
  const carryoverResolved =
    latestTurnMetadata.carryoverTwinQuestionAnswered === true &&
    !normalizeText(latestTurnMetadata.canonical_question_text) &&
    Boolean(normalizeText(latestTurnMetadata.carryoverTwinQuestionTurnId));

  if (!emittedReplyTopicKey || emittedQuestionTopicKey) {
    return {
      strategy: "explicit_pause",
      nextSpeakerUserId: null,
      questionText: canonicalQuestionText || null,
      questionTopicKey: emittedQuestionTopicKey || null
    };
  }

  const continuationEligible =
    normalizeText(result?.repeat_source) === "same_topic_broad_question_repeat" ||
    Boolean(result?.mirror_question_required_for_coverage) ||
    Boolean(result?.repeat_guard_suppressed);

  if (!continuationEligible) {
    const latestTurnQuestionOnlySameTopic =
      latestTurn?.actorUserId === normalizedListenerUserId &&
      String(latestTurn?.actorRole || "").endsWith("_twin") &&
      textLooksLikeQuestion(latestTurn?.content) &&
      normalizeTopicKey(
        latestTurnMetadata.canonical_question_topic_key ||
          latestTurnMetadata.emitted_question_topic_key ||
          latestTurnMetadata.question_topic_key ||
          getTurnQuestionTopic(latestTurn)
      ) === emittedReplyTopicKey &&
      !normalizeText(latestTurnMetadata.canonical_answer_text) &&
      !normalizeTopicKey(
        latestTurnMetadata.canonical_reply_topic_key ||
          latestTurnMetadata.emitted_reply_topic_key ||
          latestTurnMetadata.reply_topic_key
      );

    const directMirrorDecision = latestTurnQuestionOnlySameTopic
      ? shouldAllowMirrorQuestionForCoverage({
          session,
          turns,
          topicKey: emittedReplyTopicKey,
          questionText: buildCanonicalMirrorQuestionForPendingTopic(session, emittedReplyTopicKey),
          speakerUserId,
          listenerUserId,
          latestListenerQuestionTopic: emittedReplyTopicKey,
          resultFacts: result?.confirmed_facts || [],
          didAnswerRequiredQuestion: Boolean(result?.did_answer_required_question)
        })
      : { allowed: false, coverageBefore: null, coverageAfter: null };

    if (latestTurnQuestionOnlySameTopic && directMirrorDecision.allowed) {
      return {
        strategy: "emit_canonical_mirror_question",
        nextSpeakerUserId: speakerUserId,
        questionText: buildCanonicalMirrorQuestionForPendingTopic(session, emittedReplyTopicKey),
        questionTopicKey: emittedReplyTopicKey,
        coverageBefore: directMirrorDecision.coverageBefore,
        coverageAfter: directMirrorDecision.coverageAfter
      };
    }

    return {
      strategy: "explicit_pause",
      nextSpeakerUserId: null,
      questionText: null,
      questionTopicKey: normalizedActiveTopicKey || emittedReplyTopicKey
    };
  }

  if (
    canonicalQuestionText &&
    hasEquivalentOutstandingTwinQuestionForTopic(
      session,
      turns,
      emittedReplyTopicKey,
      normalizedListenerUserId,
      canonicalQuestionText
    )
  ) {
    return {
      strategy: "reuse_existing_outstanding_question",
      nextSpeakerUserId: normalizedListenerUserId,
      questionText: canonicalQuestionText,
      questionTopicKey: emittedReplyTopicKey
    };
  }

  const mirrorDecision = shouldAllowMirrorQuestionForCoverage({
    session,
    turns,
    topicKey: emittedReplyTopicKey,
    questionText: buildCanonicalMirrorQuestionForPendingTopic(session, emittedReplyTopicKey),
    speakerUserId,
    listenerUserId,
    latestListenerQuestionTopic: emittedReplyTopicKey,
    resultFacts: result?.confirmed_facts || [],
    didAnswerRequiredQuestion: Boolean(result?.did_answer_required_question)
  });

  if (mirrorDecision.allowed) {
    return {
      strategy: "emit_canonical_mirror_question",
      nextSpeakerUserId: speakerUserId,
      questionText: buildCanonicalMirrorQuestionForPendingTopic(session, emittedReplyTopicKey),
      questionTopicKey: emittedReplyTopicKey,
      coverageBefore: mirrorDecision.coverageBefore,
      coverageAfter: mirrorDecision.coverageAfter
    };
  }

  const nextObjective = chooseCanonicalNextObjective(session, objectives, turns, {
    excludedTopicKey: emittedReplyTopicKey,
    listenerUserId: normalizedListenerUserId
  });
  if (nextObjective?.key) {
    return {
      strategy: "switch_to_next_topic",
      nextSpeakerUserId: speakerUserId,
      questionText: buildObjectiveQuestionV2(nextObjective),
      questionTopicKey: nextObjective.key
    };
  }

  if (carryoverResolved) {
    return {
      strategy: "no_op_resolved_outstanding",
      nextSpeakerUserId: null,
      questionText: null,
      questionTopicKey: null
    };
  }

  if (!hasUnresolvedTopicBacklog(session) || areAllCanonicalTopicsClosed(session)) {
    return {
      strategy: "objectives_completed",
      nextSpeakerUserId: null,
      questionText: null,
      questionTopicKey: null
    };
  }

  return {
    strategy: "explicit_pause",
    nextSpeakerUserId: null,
    questionText: null,
    questionTopicKey: normalizedActiveTopicKey || emittedReplyTopicKey
  };
}

function shouldSuppressRepeatPendingRequestForResolvedCarryover(session, result, sourceTurn, facts = []) {
  if (!session || !result || !sourceTurn) {
    return false;
  }

  if (result.did_answer_required_question !== true) {
    return false;
  }

  if (normalizeText(result.canonical_question_text || result.emitted_question_text)) {
    return false;
  }

  if (!canDeterministicallyRecoverMirrorQuestionSource(session, sourceTurn)) {
    return false;
  }

  const topicKey =
    normalizeTopicKey(result.canonical_reply_topic_key) ||
    normalizeTopicKey(result.emitted_reply_topic_key) ||
    normalizeTopicKey(result.reply_topic_key) ||
    normalizeTopicKey(sourceTurn?.metadata?.canonical_question_topic_key) ||
    normalizeTopicKey(sourceTurn?.metadata?.emitted_question_topic_key) ||
    getTurnQuestionTopic(sourceTurn);
  if (!topicKey) {
    return false;
  }

  const coverage = getObjectiveCoverage(session, facts, topicKey);
  return coverage.initiator && coverage.counterparty;
}

function inferTopicKeyFromText(text) {
  const value = normalizeText(text);

  if (!value) {
    return null;
  }

  if (
    /(结婚节奏|婚期|几年|多久|时间安排|多快|年内|先相处)/u.test(value) ||
    /结婚.{0,12}(节奏|时间|推进|婚期|多久|几年|安排|快一点|慢一点|太快)/u.test(value) ||
    /(推进|稳定后).{0,8}结婚/u.test(value) ||
    /(快一点|慢一点|太快).{0,12}结婚/u.test(value) ||
    /(多久|几年|年内).{0,12}结婚/u.test(value)
  ) {
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

  if (/(关系目标|长期关系|长期稳定|进入怎样的长期关系|怎样的长期关系|更看重长期稳定|结婚放进考虑|结婚为目标|以结婚为目标|认真发展)/u.test(value)) {
    return "relationshipGoal";
  }

  if (
    /(深圳|广州|上海|杭州|北京|定居|留在|异地|落户|长期.{0,10}(哪个|什么).{0,6}城市|在哪.{0,6}城市|哪个城市生活|城市安排|生活城市)/u.test(
      value
    ) ||
    /更倾向.{0,8}(深圳|广州|上海|杭州|北京)/u.test(value) ||
    /(城市|住在哪|住哪里).{0,10}(考虑|安排|规划)/u.test(value)
  ) {
    return "cities";
  }

  if (
    /(财务观|金钱观|消费观|花钱|储蓄|债务|隐性负债|务实稳定|经济安排|财务安排|消费、储蓄|消费和储蓄|攒钱)/u.test(
      value
    )
  ) {
    return "financialView";
  }

  return null;
}

function splitReplyIntoAnswerAndTrailingQuestion(reply) {
  const normalized = normalizeText(reply);
  if (!normalized) {
    return { answerText: "", questionText: "" };
  }

  const parts = normalized
    .split(/(?<=[。！？!?])/u)
    .map((item) => normalizeText(item))
    .filter(Boolean);

  if (!parts.length) {
    return { answerText: normalized, questionText: "" };
  }

  const lastPart = parts[parts.length - 1];
  if (!textLooksLikeQuestion(lastPart)) {
    return { answerText: normalized, questionText: "" };
  }

  const answerText = parts.slice(0, -1).join(" ").trim();
  return {
    answerText,
    questionText: lastPart
  };
}

function extractTrailingQuestionText(reply) {
  return splitReplyIntoAnswerAndTrailingQuestion(reply).questionText || "";
}

function inferQuestionTopicFromQuestionText(questionText) {
  const value = normalizeText(questionText);
  if (!value) {
    return null;
  }

  if (
    /(深圳|广州|上海|杭州|北京|定居|留在|异地|落户|上海还是杭州|深圳还是广州|长期.{0,10}(哪个|什么).{0,6}城市|在哪.{0,6}城市|哪个城市生活|城市安排|生活城市|长期生活城市)/u.test(
      value
    ) ||
    /更倾向.{0,8}(深圳|广州|上海|杭州|北京)/u.test(value) ||
    /(城市|住在哪|住哪里).{0,10}(考虑|安排|规划)/u.test(value)
  ) {
    return "cities";
  }

  if (
    /(结婚节奏|婚期|几年|多久|时间安排|多快|年内|先相处)/u.test(value) ||
    /结婚.{0,12}(节奏|时间|推进|婚期|多久|几年|安排|快一点|慢一点|太快)/u.test(value) ||
    /(推进|稳定后).{0,8}结婚/u.test(value) ||
    /(快一点|慢一点|太快).{0,12}结婚/u.test(value) ||
    /(多久|几年|年内).{0,12}结婚/u.test(value)
  ) {
    return "marriageTimeline";
  }

  if (/(孩子|生育|备孕|丁克)/u.test(value)) {
    return "childrenPreference";
  }

  if (/(父母|同住|独立小家庭|家庭边界|住得近)/u.test(value)) {
    return "familyBoundary";
  }

  if (
    /(财务观|金钱观|消费观|花钱|储蓄|债务|隐性负债|务实稳定|经济安排|财务安排|消费、储蓄|消费和储蓄|攒钱)/u.test(
      value
    )
  ) {
    return "financialView";
  }

  if (/(关系目标|长期关系|长期稳定|进入怎样的长期关系|怎样的长期关系|更看重长期稳定|结婚放进考虑|结婚为目标|以结婚为目标|认真发展)/u.test(value)) {
    return "relationshipGoal";
  }

  return normalizeTopicKey(inferTopicKeyFromText(value));
}

function getTurnQuestionTopic(turn) {
  if (!turn) {
    return null;
  }

  const metadata = turn.metadata && typeof turn.metadata === "object" ? turn.metadata : {};
  const canonicalQuestionText = normalizeText(metadata.canonical_question_text);
  const canonicalQuestionTopicKey = normalizeTopicKey(metadata.canonical_question_topic_key);
  const emittedQuestionText = normalizeText(metadata.emitted_question_text);
  const emittedQuestionTopicKey = normalizeTopicKey(metadata.emitted_question_topic_key);
  const questionTopicKey = normalizeTopicKey(metadata.question_topic_key);

  if (canonicalQuestionText) {
    return canonicalQuestionTopicKey || emittedQuestionTopicKey || questionTopicKey || inferQuestionTopicFromQuestionText(canonicalQuestionText);
  }

  if (emittedQuestionText) {
    return emittedQuestionTopicKey || questionTopicKey || inferQuestionTopicFromQuestionText(emittedQuestionText);
  }

  if (questionTopicKey && textLooksLikeQuestion(turn.content)) {
    return questionTopicKey;
  }

  return textLooksLikeQuestion(turn.content) ? inferQuestionTopicFromQuestionText(turn.content) : null;
}

function inferAnswerTopicFromAnswerSegment(answerText, activeTopicKey = null, latestListenerQuestionTopic = null) {
  const normalizedAnswerText = normalizeText(answerText);
  if (!normalizedAnswerText) {
    return null;
  }

  const normalizedLatestListenerQuestionTopic = normalizeTopicKey(latestListenerQuestionTopic);
  const normalizedActiveTopicKey = normalizeTopicKey(activeTopicKey);
  const relationshipGoalAnswerPattern = /(长期关系|关系目标|认真|长期稳定|结婚放进考虑|结婚为目标|以结婚为目标)/u;

  if (
    normalizedLatestListenerQuestionTopic === "relationshipGoal" &&
    relationshipGoalAnswerPattern.test(normalizedAnswerText)
  ) {
    return "relationshipGoal";
  }

  if (
    normalizedActiveTopicKey === "relationshipGoal" &&
    relationshipGoalAnswerPattern.test(normalizedAnswerText)
  ) {
    return "relationshipGoal";
  }

  const inferred = normalizeTopicKey(inferTopicKeyFromText(answerText));
  if (inferred) {
    return inferred;
  }

  return normalizedLatestListenerQuestionTopic || normalizedActiveTopicKey || null;
}

function alignFinalTurnSemantics(result, context = {}) {
  return canonicalizeFinalTurnOutcome(result, context);
}

function resolveObjectiveForTopic(objectives = [], topicKey = null) {
  const normalizedTopicKey = normalizeTopicKey(topicKey);
  if (!normalizedTopicKey) {
    return null;
  }

  return (
    (Array.isArray(objectives)
      ? objectives.find((objective) => normalizeTopicKey(objective?.key) === normalizedTopicKey)
      : null) ||
    TOPIC_CONFIG.find((item) => item.key === normalizedTopicKey) ||
    { key: normalizedTopicKey }
  );
}

function chooseCanonicalNextObjective(session, objectives = [], turns = [], options = {}) {
  const excludedTopicKeys = new Set(
    (Array.isArray(options.excludedTopicKeys) ? options.excludedTopicKeys : [options.excludedTopicKey])
      .map((topicKey) => normalizeTopicKey(topicKey))
      .filter(Boolean)
  );
  const preferredTopicKey = normalizeTopicKey(options.preferredTopicKey);
  const listenerUserId = normalizeText(options.listenerUserId);
  const recentContents = (turns || []).slice(-6).map((turn) => normalizeText(turn.content)).filter(Boolean);
  const orderedKeys = getCanonicalScopedTopicKeys(session, options.round || null, objectives);
  const candidateTopicKeys = preferredTopicKey
    ? [preferredTopicKey, ...orderedKeys.filter((topicKey) => topicKey !== preferredTopicKey)]
    : orderedKeys;

  for (const topicKey of candidateTopicKeys) {
    if (!topicKey || excludedTopicKeys.has(topicKey)) {
      continue;
    }

    const objective = resolveObjectiveForTopic(objectives, topicKey);
    const question = buildObjectiveQuestionV2(objective || { key: topicKey });
    if (!question) {
      continue;
    }

    if (
      listenerUserId &&
      hasEquivalentOutstandingTwinQuestionForTopic(session, turns, topicKey, listenerUserId, question)
    ) {
      continue;
    }

    if (recentContents.some((content) => isNearDuplicateText(content, question))) {
      continue;
    }

    return objective || { key: topicKey };
  }

  return null;
}


function stripTrailingPunctuation(value) {
  return normalizeText(value).replace(/[。！？!?，,、；;：:]+$/gu, "").trim();
}

function ensureSentence(value) {
  const cleaned = stripTrailingPunctuation(value);
  return cleaned ? `${cleaned}。` : "";
}

function splitSemiStructuredValues(value) {
  return normalizeText(value)
    .split(/[、,，/]/u)
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function hasNaturalSentenceShape(value) {
  const text = stripTrailingPunctuation(value);

  if (!text) {
    return false;
  }

  if (/[。！？]/u.test(value)) {
    return true;
  }

  if (/^(我|如果|关于|婚后|在|对|目前|未来)/u.test(text) && text.length >= 8) {
    return true;
  }

  return false;
}

function isLikelyPlaceName(value) {
  const text = normalizeText(value);

  if (!text) {
    return false;
  }

  if (/(市|区|县|镇|乡|村|北京|上海|杭州|深圳|广州|苏州|南京|成都|重庆|武汉|西安|天津|宁波|厦门|青岛|长沙|珠海|海外)/u.test(text)) {
    return true;
  }

  return text.length >= 2 && text.length <= 6 && !/(可以|接受|希望|长期|认真|住得近|一起|生活|定居)/u.test(text);
}

function shouldUseRawValueAsFallback(rawValue) {
  const value = stripTrailingPunctuation(rawValue);

  if (!value) {
    return false;
  }

  if (!hasNaturalSentenceShape(value)) {
    return false;
  }

  return !/(我可以接受|认真长期关系，希望|住得近)/u.test(value);
}

function looksLikeSmalltalkFragment(value) {
  const text = normalizeText(value);

  if (!text) {
    return false;
  }

  return /(哈喽|你好|很高兴|感觉你很不错|感觉不错|印象不错|聊得来|挺聊得来|挺不错|很不错)/u.test(text);
}

function looksLikeMarriageTimelineValue(value) {
  const text = normalizeText(value);

  if (!text || looksLikeSmalltalkFragment(text)) {
    return false;
  }

  return /(结婚|婚期|推进|节奏|几年|年内|先相处|稳定后|不想太快|尽快|慢一点|多久)/u.test(text);
}

function looksLikeRelationshipGoalValue(value) {
  const text = normalizeText(value);

  if (!text || looksLikeSmalltalkFragment(text)) {
    return false;
  }

  return /(长期|认真|结婚为目标|以结婚为目标|稳定关系|认真发展)/u.test(text);
}

function looksLikeChildrenPreferenceValue(value) {
  const text = normalizeText(value);

  if (!text || looksLikeSmalltalkFragment(text)) {
    return false;
  }

  return /(孩子|生育|丁克|要孩子|不要孩子|备孕)/u.test(text);
}

function looksLikeFamilyBoundaryValue(value) {
  const text = normalizeText(value);

  if (!text || looksLikeSmalltalkFragment(text)) {
    return false;
  }

  return /(父母|边界|同住|独立小家庭|住得近|小家庭)/u.test(text);
}

function looksLikeFinancialViewValue(value) {
  const text = normalizeText(value);

  if (!text || looksLikeSmalltalkFragment(text)) {
    return false;
  }

  return /(财务|消费|储蓄|负债|收入|借钱|存款|务实|稳定)/u.test(text);
}

function looksLikeCitiesValue(value) {
  const text = normalizeText(value);

  if (!text || looksLikeSmalltalkFragment(text)) {
    return false;
  }

  if (/[!?！？]/u.test(text) || /(你具体|你呢|哪里|在哪|聊聊|怎么想)/u.test(text)) {
    return false;
  }

  const options = splitSemiStructuredValues(text);
  if (options.length > 1) {
    return options.every((item) => isLikelyPlaceName(cleanCityOption(item)));
  }

  const directAcceptMatch = text.match(/(?:我|目前)?(?:都)?(?:可以|能)?接受(.+)$/u);
  if (directAcceptMatch?.[1]) {
    return isLikelyPlaceName(cleanCityOption(directAcceptMatch[1]));
  }

  const preferenceMatch = text.match(/(?:更偏向|更倾向|偏向|倾向)(.+?)(?:生活|定居|$)/u);
  if (preferenceMatch?.[1]) {
    return isLikelyPlaceName(cleanCityOption(preferenceMatch[1]));
  }

  return isLikelyPlaceName(cleanCityOption(text));
}

function validateFactTopicCompatibility(topicKey, rawValue) {
  const value = normalizeText(rawValue);

  if (!value) {
    return false;
  }

  switch (topicKey) {
    case "cities":
      return looksLikeCitiesValue(value);
    case "relationshipGoal":
      return looksLikeRelationshipGoalValue(value) || shouldUseRawValueAsFallback(value);
    case "marriageTimeline":
      return looksLikeMarriageTimelineValue(value);
    case "childrenPreference":
      return looksLikeChildrenPreferenceValue(value);
    case "familyBoundary":
      return looksLikeFamilyBoundaryValue(value);
    case "financialView":
      return looksLikeFinancialViewValue(value);
    default:
      return !looksLikeSmalltalkFragment(value);
  }
}

function sanitizeFactCandidate(topicKey, rawValue, sourceContext = {}) {
  const value = stripTrailingPunctuation(rawValue);

  if (!value) {
    return {
      accepted: false,
      reason: "empty_fact_value",
      topicKey,
      rawValue: normalizeText(rawValue)
    };
  }

  if (!validateFactTopicCompatibility(topicKey, value)) {
    return {
      accepted: false,
      reason:
        topicKey === "marriageTimeline" && looksLikeSmalltalkFragment(value)
          ? "marriage_timeline_smalltalk_fragment"
          : "topic_value_mismatch",
      topicKey,
      rawValue: value,
      sourceContext
    };
  }

  return {
    accepted: true,
    topicKey,
    rawValue: value,
    value
  };
}

function getTwinProfilePatchFromHumanInput(fieldKey, responseText) {
  const normalizedFieldKey = normalizeText(fieldKey);

  if (!normalizedFieldKey || normalizedFieldKey === "manual_review" || normalizedFieldKey === "manual_question_answer") {
    return null;
  }

  const candidate = sanitizeFactCandidate(normalizedFieldKey, responseText, {
    source: "human_input_profile_writeback",
    fieldKey: normalizedFieldKey
  });

  if (!candidate.accepted) {
    writeLlmTelemetry(
      buildQualityTelemetryPayload({
        fact_rejected: true,
        fact_rejected_reason: candidate.reason,
        fact_rejected_topic: normalizedFieldKey,
        source: "human_input_profile_writeback"
      })
    );
    return null;
  }

  return {
    [normalizedFieldKey]: candidate.value
  };
}

function sanitizeConfirmedFactsForPersistence(facts = [], sourceContext = {}) {
  const acceptedFacts = [];
  const rejectedFacts = [];

  for (const fact of facts) {
    const topicKey = normalizeText(fact?.key);
    const candidate = sanitizeFactCandidate(topicKey, fact?.value, sourceContext);

    if (!candidate.accepted) {
      rejectedFacts.push({
        key: topicKey,
        value: normalizeText(fact?.value),
        reason: candidate.reason
      });
      continue;
    }

    acceptedFacts.push({
      ...fact,
      key: topicKey,
      value: candidate.value
    });
  }

  return {
    acceptedFacts,
    rejectedFacts
  };
}

function sanitizePersistedFact(fact, context = {}) {
  if (!fact?.key) {
    return null;
  }

  const candidate = sanitizeFactCandidate(fact.key, fact.value, context);
  if (!candidate.accepted) {
    writeLlmTelemetry(
      buildQualityTelemetryPayload({
        sanitized_historical_fact: true,
        fact_rejected: true,
        fact_rejected_reason: candidate.reason,
        fact_rejected_topic: normalizeText(fact.key)
      })
    );
    return null;
  }

  return {
    ...fact,
    value: candidate.value
  };
}

function sanitizeFactsForPrompt(facts = [], context = {}) {
  return facts.map((fact) => sanitizePersistedFact(fact, context)).filter(Boolean);
}

function sanitizeFactsForSessionResponse(facts = [], context = {}) {
  return facts.map((fact) => sanitizePersistedFact(fact, context)).filter(Boolean);
}

function sanitizeStageReportFacts(facts = [], context = {}) {
  return facts.map((fact) => sanitizePersistedFact(fact, context)).filter(Boolean);
}

function buildCounterpartySummaryFrame(session, facts = [], options = {}) {
  if (!session) {
    return null;
  }

  const scopedObjectiveKeys = Array.isArray(options.scopedObjectiveKeys)
    ? options.scopedObjectiveKeys.map((item) => normalizeTopicKey(item)).filter(Boolean)
    : [];
  const allTopicOrder = TOPIC_CONFIG.map((item) => item.key);
  const unresolvedTopicOrder = scopedObjectiveKeys.length
    ? allTopicOrder.filter((topicKey) => scopedObjectiveKeys.includes(topicKey))
    : allTopicOrder;
  const ledger = getSessionControl(session).automation.topicLedger;
  const byUser = {
    initiator: {
      targetUserId: session.counterpartyUserId,
      factsByTopic: {},
      confirmedTopics: [],
      unknownTopics: [],
      unresolvedTopics: [],
      evidenceTurnIds: []
    },
    counterparty: {
      targetUserId: session.initiatorUserId,
      factsByTopic: {},
      confirmedTopics: [],
      unknownTopics: [],
      unresolvedTopics: [],
      evidenceTurnIds: []
    }
  };

  for (const fact of facts) {
    const topicKey = normalizeTopicKey(fact?.key);
    const subjectUserId = normalizeText(fact?.subjectUserId);
    if (!topicKey || !subjectUserId) {
      continue;
    }

    const perspective =
      subjectUserId === session.counterpartyUserId
        ? "initiator"
        : subjectUserId === session.initiatorUserId
          ? "counterparty"
          : null;

    if (!perspective) {
      continue;
    }

    const entry = {
      key: topicKey,
      value: normalizeText(fact.value),
      confidence: Number(fact.confidence || 0),
      status: normalizeText(fact.status) || "confirmed",
      sourceTurnId: normalizeText(fact.sourceTurnId) || null
    };

    byUser[perspective].factsByTopic[topicKey] = entry;
    if (entry.sourceTurnId) {
      byUser[perspective].evidenceTurnIds.push(entry.sourceTurnId);
    }
  }

  for (const perspective of Object.keys(byUser)) {
    const frame = byUser[perspective];
    const extraFactTopics = Object.keys(frame.factsByTopic).filter((topicKey) => !allTopicOrder.includes(topicKey));
    const confirmedTopicOrder = [...allTopicOrder, ...extraFactTopics];
    frame.confirmedTopics = confirmedTopicOrder.filter((topicKey) => {
      const fact = frame.factsByTopic[topicKey];
      return Boolean(normalizeText(fact?.value));
    });
    frame.unknownTopics = unresolvedTopicOrder.filter((topicKey) => !frame.confirmedTopics.includes(topicKey));
    frame.unresolvedTopics = unresolvedTopicOrder.filter((topicKey) => {
      if (frame.factsByTopic[topicKey]) {
        return false;
      }

      const ledgerState = normalizeText(getTopicEntry(ledger, topicKey)?.state);
      if (ledgerState === "closed") {
        return false;
      }

      const coverage = getObjectiveCoverage(session, facts, topicKey);
      const coveredForPerspective = perspective === "initiator" ? coverage.counterparty : coverage.initiator;
      return !coveredForPerspective;
    });
    frame.evidenceTurnIds = [...new Set(frame.evidenceTurnIds.filter(Boolean))];
    frame.confirmedTopicCount = frame.confirmedTopics.length;
    frame.isRenderable = frame.confirmedTopicCount >= 1;
  }

  return byUser;
}

function buildCounterpartySummaryTextFromFrame(frame = null) {
  if (!frame?.isRenderable) {
    return "当前情况：可稳定确认的信息还不够多，建议继续通过后续问答补齐。";
  }

  const parts = frame.confirmedTopics
    .map((topicKey) => {
      const fact = frame.factsByTopic?.[topicKey];
      const label = getTopicLabel(topicKey);
      const value = normalizeText(fact?.value);
      return value ? `${label}：${value}` : null;
    })
    .filter(Boolean);
  return parts.length ? `${parts.join("；")}。` : "当前情况：可稳定确认的信息还不够多。";
}

function buildCounterpartyUnresolvedQuestionsFromFrame(frame = null) {
  if (!frame) {
    return ["对方仍有若干关键信息未明确。"];
  }

  const unresolved = frame.unresolvedTopics
    .slice(0, 4)
    .map((topicKey) => `对方的${getTopicLabel(topicKey)}仍未明确`)
    .filter(Boolean);

  return unresolved.length ? unresolved : [];
}

function buildStageSummaryFallbackFromCounterpartyFrame(frameByRole = null, basePayload = {}) {
  const initiatorFrame = frameByRole?.initiator || null;
  const counterpartyFrame = frameByRole?.counterparty || null;
  const initiatorSummary = buildCounterpartySummaryTextFromFrame(initiatorFrame);
  const counterpartySummary = buildCounterpartySummaryTextFromFrame(counterpartyFrame);

  return {
    ...basePayload,
    summary: initiatorSummary,
    unresolved_questions: buildCounterpartyUnresolvedQuestionsFromFrame(initiatorFrame),
    risk_summary: Array.isArray(basePayload?.risk_summary) ? basePayload.risk_summary : [],
    summary_by_role: {
      initiator: initiatorSummary,
      counterparty: counterpartySummary
    },
    counterparty_summary_frame: frameByRole
  };
}

function buildCanonicalStageSummaryPayload(basePayload = {}, frameByRole = null) {
  const fallbackPayload = buildStageSummaryFallbackFromCounterpartyFrame(frameByRole, basePayload);

  return {
    ...basePayload,
    ...fallbackPayload,
    summary_by_role: fallbackPayload.summary_by_role,
    unresolved_questions: fallbackPayload.unresolved_questions
  };
}

function applyCanonicalStageSummaryPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const frameByRole =
    payload.counterparty_summary_frame && typeof payload.counterparty_summary_frame === "object"
      ? payload.counterparty_summary_frame
      : null;

  if (!frameByRole) {
    return payload;
  }

  const canonicalPayload = buildCanonicalStageSummaryPayload(payload, frameByRole);
  return {
    ...payload,
    ...canonicalPayload,
    summary: canonicalPayload.summary,
    summary_by_role: canonicalPayload.summary_by_role,
    unresolved_questions: canonicalPayload.unresolved_questions
  };
}

function getStageReportRoleLabelMap(session, currentUserId) {
  if (!session || !currentUserId) {
    return {
      initiator: "发起方",
      counterparty: "另一方",
      initiatorDisplayName: "发起方",
      counterpartyDisplayName: "另一方"
    };
  }

  const initiatorName = normalizeText(session.initiator?.displayName) || "发起方";
  const counterpartyName = normalizeText(session.counterparty?.displayName) || "另一方";

  return participantRole(session, currentUserId) === "initiator"
    ? {
        initiator: "你",
        counterparty: "对方",
        initiatorDisplayName: "你",
        counterpartyDisplayName: counterpartyName
      }
    : {
        initiator: "对方",
        counterparty: "你",
        initiatorDisplayName: initiatorName,
        counterpartyDisplayName: "你"
      };
}

function normalizeStageReportText(text, labelMap) {
  const value = normalizeText(text);

  if (!value) {
    return value;
  }

  const replacements = [
    { pattern: /\binitiator_user\b/giu, replacement: labelMap.initiator },
    { pattern: /\binitiator_twin\b/giu, replacement: labelMap.initiator },
    { pattern: /\binitiator\b/giu, replacement: labelMap.initiator },
    { pattern: /\bcounterparty_user\b/giu, replacement: labelMap.counterparty },
    { pattern: /\bcounterparty_twin\b/giu, replacement: labelMap.counterparty },
    { pattern: /\bcounterparty\b/giu, replacement: labelMap.counterparty }
  ];

  return replacements
    .reduce((result, item) => result.replace(item.pattern, item.replacement), value)
    .replace(/(?:发起方|另一方|对方|你)\s*[（(]\s*你\s*[)）]/gu, "你")
    .replace(
      /(?:发起方|另一方|对方|你)\s*[（(]\s*([^()（）\s]{1,32})\s*[)）]/gu,
      (_match, name) => normalizeText(name)
    )
    .replace(/(你|对方|发起方|另一方)\s+(?=[\u4e00-\u9fff])/gu, "$1");
}

function sanitizeStageReportPayloadForPersistence(payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const canonicalPayload = applyCanonicalStageSummaryPayload(payload);

  const labelMap = {
    initiator: "发起方",
    counterparty: "另一方"
  };

  return {
    ...canonicalPayload,
    summary: normalizeStageReportText(canonicalPayload.summary, labelMap),
    summary_by_role:
      canonicalPayload.summary_by_role && typeof canonicalPayload.summary_by_role === "object"
        ? {
            initiator: normalizeStageReportText(canonicalPayload.summary_by_role.initiator, labelMap) || null,
            counterparty: normalizeStageReportText(canonicalPayload.summary_by_role.counterparty, labelMap) || null
          }
        : null,
    unresolved_questions: Array.isArray(canonicalPayload.unresolved_questions)
      ? canonicalPayload.unresolved_questions.map((item) => normalizeStageReportText(item, labelMap)).filter(Boolean)
      : [],
    risk_summary: Array.isArray(canonicalPayload.risk_summary)
      ? canonicalPayload.risk_summary.map((item) => ({
          ...item,
          reason: normalizeStageReportText(item?.reason, labelMap)
        }))
      : []
  };
}

function sanitizeStageReportPayloadForResponse(payload, session, currentUserId, context = {}) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const canonicalPayload = applyCanonicalStageSummaryPayload(payload);

  const labelMap = getStageReportRoleLabelMap(session, currentUserId);
  const viewerRole = participantRole(session, currentUserId) === "initiator" ? "initiator" : "counterparty";
  const viewerSummary =
    normalizeStageReportText(canonicalPayload?.summary_by_role?.[viewerRole], labelMap) ||
    normalizeStageReportText(canonicalPayload.summary, labelMap);

  return {
    ...canonicalPayload,
    summary: viewerSummary,
    summary_by_role:
      canonicalPayload.summary_by_role && typeof canonicalPayload.summary_by_role === "object"
        ? {
            initiator: normalizeStageReportText(canonicalPayload.summary_by_role.initiator, labelMap) || null,
            counterparty: normalizeStageReportText(canonicalPayload.summary_by_role.counterparty, labelMap) || null
          }
        : null,
    confirmed_facts: sanitizeStageReportFacts(canonicalPayload.confirmed_facts || [], context),
    unresolved_questions: Array.isArray(canonicalPayload.unresolved_questions)
      ? canonicalPayload.unresolved_questions.map((item) => normalizeStageReportText(item, labelMap)).filter(Boolean)
      : [],
    risk_summary: Array.isArray(canonicalPayload.risk_summary)
      ? canonicalPayload.risk_summary.map((item) => ({
          ...item,
          reason: normalizeStageReportText(item?.reason, labelMap)
        }))
      : []
  };
}

function persistAcceptedFacts({
  session,
  round,
  speaker,
  listener,
  facts = [],
  turns,
  sourceTurnId,
  telemetrySource
}) {
  const resolvedFacts = facts.map((fact) => ({
    ...fact,
    subjectUserId: resolveFactSubjectUserId(fact.subjectUserId, speaker.userId, listener.userId)
  }));
  const { acceptedFacts, rejectedFacts } = sanitizeConfirmedFactsForPersistence(resolvedFacts, {
    source: telemetrySource,
    sessionId: session.id,
    roundId: round.id
  });

  for (const rejected of rejectedFacts) {
    writeLlmTelemetry(
      buildQualityTelemetryPayload({
        fact_rejected: true,
        fact_rejected_reason: rejected.reason,
        fact_rejected_topic: rejected.key,
        reply_quality_issue: rejected.reason,
        source: telemetrySource
      })
    );
  }

  if (acceptedFacts.length) {
    saveExtractedFacts(session.id, round.id, acceptedFacts, sourceTurnId);
  }

  if (rejectedFacts.length && !acceptedFacts.length && turns && !sanitizeFactsForPrompt(acceptedFacts).length) {
    return {
      rejectedFacts,
      acceptedFacts,
      needsHumanInputFallback: true
    };
  }

  return {
    acceptedFacts,
    rejectedFacts,
    needsHumanInputFallback: false
  };
}

function cleanCityOption(value) {
  return normalizeText(value)
    .replace(
      /^(我这边|我|目前|未来|长期|生活城市|城市|定居|更偏向|更倾向|偏向|倾向|可以接受|能接受|接受|在)+/gu,
      ""
    )
    .replace(/(生活|定居|也可以|都可以|也可接受|可接受|可以接受|能接受)$/gu, "")
    .trim();
}

function naturalizeCities(rawValue) {
  const value = normalizeText(rawValue);

  if (!value) {
    return { normalizedSummary: "", naturalAnswerHint: null };
  }

  const directAcceptMatch = value.match(/(?:我|目前)?(?:都)?(?:可以|能)?接受(.+)$/u);
  if (directAcceptMatch?.[1]) {
    const option = cleanCityOption(directAcceptMatch[1]);
    if (option) {
      return {
        normalizedSummary: `对长期城市较开放，${option}也可接受`,
        naturalAnswerHint: `我对长期生活城市还算开放，${option}也可以接受。`
      };
    }
  }

  const parts = [...new Set(splitSemiStructuredValues(value).map(cleanCityOption).filter(Boolean))];
  if (parts.length >= 2) {
    const [primary, ...rest] = parts;
    const naturalRest = rest.filter(Boolean);
    return {
      normalizedSummary: `长期更倾向${primary}，${naturalRest.join("、")}也可接受`,
      naturalAnswerHint: `我长期更倾向在${primary}生活，${naturalRest.join("、")}也可以接受。`
    };
  }

  const preferenceMatch = value.match(/(?:更偏向|更倾向|偏向|倾向)(.+?)(?:生活|定居|$)/u);
  if (preferenceMatch?.[1]) {
    const preferred = cleanCityOption(preferenceMatch[1]);
    if (preferred && isLikelyPlaceName(preferred)) {
      return {
        normalizedSummary: `长期更倾向${preferred}`,
        naturalAnswerHint: `我长期更倾向在${preferred}生活。`
      };
    }
  }

  const single = cleanCityOption(value);
  if (single && isLikelyPlaceName(single)) {
    return {
      normalizedSummary: `长期更倾向${single}`,
      naturalAnswerHint: `我长期更倾向在${single}生活。`
    };
  }

  if (shouldUseRawValueAsFallback(value)) {
    return { normalizedSummary: stripTrailingPunctuation(value), naturalAnswerHint: ensureSentence(value) };
  }

  return {
    normalizedSummary: "长期生活城市偏好待澄清",
    naturalAnswerHint: "我对长期生活城市还算开放，但更具体的城市偏好需要再结合实际情况确认。"
  };
}

function naturalizeRelationshipGoal(rawValue) {
  const value = normalizeText(rawValue);

  if (!value) {
    return { normalizedSummary: "", naturalAnswerHint: null };
  }

  if (!validateFactTopicCompatibility("relationshipGoal", value)) {
    return {
      normalizedSummary: "关系目标待澄清",
      naturalAnswerHint: null
    };
  }

  if (/(长期|认真)/u.test(value) && /结婚/u.test(value)) {
    return {
      normalizedSummary: "认真长期关系，希望以结婚为目标",
      naturalAnswerHint: "我希望进入认真、长期的关系，也希望关系稳定后以结婚为目标。"
    };
  }

  if (/(长期|认真)/u.test(value)) {
    return {
      normalizedSummary: "认真长期关系",
      naturalAnswerHint: "我希望进入认真、长期的关系。"
    };
  }

  if (/结婚/u.test(value)) {
    return {
      normalizedSummary: "希望以结婚为目标",
      naturalAnswerHint: "如果关系稳定，我希望以结婚为目标。"
    };
  }

  if (shouldUseRawValueAsFallback(value)) {
    return {
      normalizedSummary: stripTrailingPunctuation(value),
      naturalAnswerHint: ensureSentence(value)
    };
  }

  return {
    normalizedSummary: stripTrailingPunctuation(value),
    naturalAnswerHint: `我的关系目标会更偏向${stripTrailingPunctuation(value)}。`
  };
}

function naturalizeMarriageTimeline(rawValue) {
  const value = normalizeText(rawValue);

  if (!value) {
    return { normalizedSummary: "", naturalAnswerHint: null };
  }

  if (!validateFactTopicCompatibility("marriageTimeline", value)) {
    return {
      normalizedSummary: "结婚节奏待澄清",
      naturalAnswerHint: null
    };
  }

  if (/^(如果|希望|我|先|更)/u.test(value) && /结婚|推进|年内/u.test(value)) {
    return {
      normalizedSummary: stripTrailingPunctuation(value),
      naturalAnswerHint: ensureSentence(value)
    };
  }

  const yearRangeMatch = value.match(/(\d+\s*(?:到|-|至)\s*\d+)\s*年/u);
  if (yearRangeMatch?.[1]) {
    const range = yearRangeMatch[1].replace(/\s+/gu, "");
    return {
      normalizedSummary: `${range}年内推进结婚`,
      naturalAnswerHint: `如果关系稳定，我希望${range}年内推进结婚。`
    };
  }

  if (shouldUseRawValueAsFallback(value) && looksLikeMarriageTimelineValue(value)) {
    return {
      normalizedSummary: stripTrailingPunctuation(value),
      naturalAnswerHint: ensureSentence(value)
    };
  }

  return {
    normalizedSummary: "结婚节奏待澄清",
    naturalAnswerHint: null
  };
}

function naturalizeChildrenPreference(rawValue) {
  const value = normalizeText(rawValue);

  if (!value) {
    return { normalizedSummary: "", naturalAnswerHint: null };
  }

  if (!validateFactTopicCompatibility("childrenPreference", value)) {
    return {
      normalizedSummary: "孩子意愿待澄清",
      naturalAnswerHint: null
    };
  }

  if (/(不要孩子|不想要孩子|丁克)/u.test(value)) {
    return {
      normalizedSummary: "目前更倾向不要孩子",
      naturalAnswerHint: "关于孩子这件事，我目前更倾向不要孩子。"
    };
  }

  if (/(要孩子|想要孩子|希望.*孩子)/u.test(value)) {
    return {
      normalizedSummary: "希望未来要孩子",
      naturalAnswerHint: "关于孩子这件事，我目前倾向于未来要孩子。"
    };
  }

  if (shouldUseRawValueAsFallback(value)) {
    return {
      normalizedSummary: stripTrailingPunctuation(value),
      naturalAnswerHint: ensureSentence(value)
    };
  }

  return {
    normalizedSummary: stripTrailingPunctuation(value),
    naturalAnswerHint: `关于孩子这件事，我目前的想法是${stripTrailingPunctuation(value)}。`
  };
}

function naturalizeFamilyBoundary(rawValue) {
  const value = normalizeText(rawValue);

  if (!value) {
    return { normalizedSummary: "", naturalAnswerHint: null };
  }

  if (!validateFactTopicCompatibility("familyBoundary", value)) {
    return {
      normalizedSummary: "家庭边界待澄清",
      naturalAnswerHint: null
    };
  }

  if (/独立小家庭/u.test(value)) {
    return {
      normalizedSummary: "婚后偏独立小家庭",
      naturalAnswerHint: "婚后我更偏向以独立小家庭为主，同时会尊重双方父母。"
    };
  }

  if (/同住|住得近/u.test(value)) {
    return {
      normalizedSummary: stripTrailingPunctuation(value),
      naturalAnswerHint: "婚后居住安排上，我可以接受和父母住得更近，但还是希望边界清楚。"
    };
  }

  if (shouldUseRawValueAsFallback(value)) {
    return {
      normalizedSummary: stripTrailingPunctuation(value),
      naturalAnswerHint: ensureSentence(value)
    };
  }

  return {
    normalizedSummary: stripTrailingPunctuation(value),
    naturalAnswerHint: `在家庭边界上，我更偏向${stripTrailingPunctuation(value)}。`
  };
}

function naturalizeFinancialView(rawValue) {
  const value = normalizeText(rawValue);

  if (!value) {
    return { normalizedSummary: "", naturalAnswerHint: null };
  }

  if (!validateFactTopicCompatibility("financialView", value)) {
    return {
      normalizedSummary: "财务观待澄清",
      naturalAnswerHint: null
    };
  }

  if (/务实|稳定/u.test(value) && /负债/u.test(value)) {
    return {
      normalizedSummary: "重视务实稳定，不接受隐性负债",
      naturalAnswerHint: "在财务安排上，我更看重务实和稳定，也不接受隐性负债。"
    };
  }

  if (/务实|稳定/u.test(value)) {
    return {
      normalizedSummary: "重视务实稳定",
      naturalAnswerHint: "在财务安排上，我更看重务实和稳定。"
    };
  }

  if (shouldUseRawValueAsFallback(value)) {
    return {
      normalizedSummary: stripTrailingPunctuation(value),
      naturalAnswerHint: ensureSentence(value)
    };
  }

  return {
    normalizedSummary: stripTrailingPunctuation(value),
    naturalAnswerHint: `在财务安排上，我更认同${stripTrailingPunctuation(value)}。`
  };
}

function naturalizeTopicValue(topicKey, rawValue) {
  const value = normalizeText(rawValue);

  if (!value) {
    return { normalizedSummary: "", naturalAnswerHint: null };
  }

  switch (topicKey) {
    case "cities":
      return naturalizeCities(value);
    case "relationshipGoal":
      return naturalizeRelationshipGoal(value);
    case "marriageTimeline":
      return naturalizeMarriageTimeline(value);
    case "childrenPreference":
      return naturalizeChildrenPreference(value);
    case "familyBoundary":
      return naturalizeFamilyBoundary(value);
    case "financialView":
      return naturalizeFinancialView(value);
    default:
      return {
        normalizedSummary: stripTrailingPunctuation(value),
        naturalAnswerHint: ensureSentence(value)
      };
  }
}

function buildFactCard(profile, topicKey) {
  const rawValue = normalizeText(profile?.twinProfile?.[topicKey]);

  if (!topicKey || !rawValue) {
    return null;
  }

  const topic = TOPIC_CONFIG.find((item) => item.key === topicKey);
  const naturalized = naturalizeTopicValue(topicKey, rawValue);

  return {
    topicKey,
    label: topic?.label || topicKey,
    rawValue,
    normalizedSummary: naturalized.normalizedSummary || rawValue,
    naturalAnswerHint: naturalized.naturalAnswerHint || null
  };
}

function buildFactCards(profile, topicKeys = []) {
  const keys = [...new Set(topicKeys.filter(Boolean))];
  return keys
    .map((topicKey) => buildFactCard(profile, topicKey))
    .filter((card) => card && (card.naturalAnswerHint || !/待澄清/u.test(card.normalizedSummary)));
}

function buildTopicAnswerV2(profile, topicKey) {
  const card = buildFactCard(profile, topicKey);
  return card?.naturalAnswerHint || null;
}

function buildObjectiveQuestionV2(objective) {
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

function buildQualityTelemetryPayload(base = {}) {
  return {
    adapter_name: "VllmOpenAIAdapter",
    provider: "vllm_openai",
    endpoint: "prechat_quality_guard",
    model: null,
    request_type: "turn_quality_guard",
    prompt_version: TURN_PROMPT_VERSION,
    started_at: new Date().toISOString(),
    duration_ms: 0,
    attempt_count: 1,
    used_repair: Boolean(base.rewrite_applied),
    used_fallback: Boolean(base.rewrite_failed),
    success: !base.rewrite_failed,
    error_type: base.rewrite_failed ? "quality_guard_pause" : null,
    ...base
  };
}

function shouldSuppressMirroredLatestQuestionQualityPause({ session, result, turns = [], speaker, listener }) {
  const latestTurn = turns.length ? turns[turns.length - 1] : null;
  const topicKey =
    normalizeTopicKey(result?.canonical_reply_topic_key) ||
    normalizeTopicKey(result?.emitted_reply_topic_key) ||
    normalizeTopicKey(result?.reply_topic_key);
  const questionTopicKey =
    normalizeTopicKey(result?.canonical_question_topic_key) ||
    normalizeTopicKey(result?.emitted_question_topic_key) ||
    normalizeTopicKey(result?.question_topic_key);
  const questionText = normalizeText(result?.canonical_question_text || result?.emitted_question_text);

  if (
    !session ||
    !latestTurn ||
    !speaker?.userId ||
    !listener?.userId ||
    !topicKey ||
    topicKey !== questionTopicKey ||
    !questionText ||
    result?.did_answer_required_question !== true
  ) {
    return {
      suppressed: false,
      reason: "missing_context",
      coverageBefore: null,
      coverageAfter: null
    };
  }

  if (!textLooksLikeQuestion(latestTurn.content) || !isNearDuplicateText(normalizeText(result?.reply), latestTurn.content)) {
    return {
      suppressed: false,
      reason: "not_mirrored_latest_question",
      coverageBefore: null,
      coverageAfter: null
    };
  }

  const mirrorDecision = shouldAllowMirrorQuestionForCoverage({
    session,
    turns,
    topicKey,
    questionText,
    speakerUserId: speaker.userId,
    listenerUserId: listener.userId,
    latestListenerQuestionTopic:
      getTurnQuestionTopic(latestTurn) ||
      normalizeTopicKey(result?.required_reply_topic) ||
      topicKey,
    resultFacts: Array.isArray(result?.confirmed_facts) ? result.confirmed_facts : [],
    didAnswerRequiredQuestion: true
  });

  return {
    suppressed: mirrorDecision.allowed,
    reason: mirrorDecision.reason,
    coverageBefore: mirrorDecision.coverageBefore,
    coverageAfter: mirrorDecision.coverageAfter
  };
}

function buildSafeFollowupReply({
  baseResult,
  session = null,
  speaker,
  listener,
  repeatedTopicKey,
  objectives,
  recentTurns,
  failureQuestion,
  options = {}
}) {
  const latestTurn = recentTurns.length ? recentTurns[recentTurns.length - 1] : null;
  const answerCard = buildFactCard(speaker, repeatedTopicKey);
  const mode = normalizeText(options.mode) || "default";
  const closedTopicGuard = mode === "closed_topic_guard";
  const suppressFalsePositiveHumanInput = Boolean(options.suppressFalsePositiveHumanInput);
  const preferredRewriteTopicKey = normalizeTopicKey(options.preferredRewriteTopicKey);
  const closedTopicKeySet = new Set(
    (Array.isArray(options.closedTopicKeys) ? options.closedTopicKeys : [])
      .map((topicKey) => normalizeTopicKey(topicKey))
      .filter(Boolean)
  );
  const latestListenerQuestionTopic =
    latestTurn?.actorUserId === listener?.userId ? getTurnQuestionTopic(latestTurn) : null;
  const candidateObjectives = Array.isArray(objectives)
    ? objectives.filter((objective) => !closedTopicKeySet.has(normalizeTopicKey(objective?.key)))
    : [];
  const preferredObjective =
    closedTopicGuard && preferredRewriteTopicKey && !closedTopicKeySet.has(preferredRewriteTopicKey)
      ? resolveObjectiveForTopic(candidateObjectives, preferredRewriteTopicKey) ||
        resolveObjectiveForTopic(objectives, preferredRewriteTopicKey)
      : null;
  const preferredQuestion = preferredObjective ? buildObjectiveQuestionV2(preferredObjective) : null;
  const canUsePreferredObjective =
    Boolean(preferredObjective && preferredQuestion) &&
    !hasEquivalentOutstandingTwinQuestionForTopic(
      session,
      recentTurns,
      preferredRewriteTopicKey,
      listener?.userId || null,
      preferredQuestion
    );
  const mustStayOnPreferredObjective = closedTopicGuard && Boolean(preferredRewriteTopicKey);
  const nextObjective = canUsePreferredObjective
    ? preferredObjective
    : mustStayOnPreferredObjective
      ? null
      : chooseCanonicalNextObjective(session, closedTopicGuard ? candidateObjectives : objectives, recentTurns, {
          excludedTopicKey: repeatedTopicKey,
          listenerUserId: listener?.userId || null
        });
  const nextObjectiveKey = normalizeTopicKey(nextObjective?.key);
  const nextQuestion = nextObjectiveKey && !closedTopicKeySet.has(nextObjectiveKey)
    ? buildObjectiveQuestionV2(nextObjective)
    : null;
  const replyParts = [];
  const stripQuestionTail = (text) => {
    const normalized = normalizeText(text);
    if (!normalized) {
      return "";
    }

    if (!textLooksLikeQuestion(normalized)) {
      return normalized;
    }

    const parts = normalized
      .split(/(?<=[。！？!?])/u)
      .map((item) => normalizeText(item))
      .filter(Boolean);

    if (parts.length > 1) {
      const withoutTail = parts.filter((item, index) => index !== parts.length - 1).join(" ").trim();
      if (withoutTail) {
        return withoutTail;
      }
    }

    return "";
  };
  const baseReplyWithoutQuestion = stripQuestionTail(baseResult?.reply);
  const sanitizedBaseReplyWithoutQuestion = normalizeText(
    sanitizeTwinReplyIdentityIntro(
      { reply: baseReplyWithoutQuestion },
      {
        isFirstTwinMessage: Boolean(options.isFirstTwinMessage),
        speakerDisplayName: options.speakerDisplayName || speaker?.displayName || ""
      },
      closedTopicGuard ? "closed_topic_guard_rewrite" : "loop_rewrite"
    )?.reply
  );
  const preservedAnswerTopic = shouldPreserveAnswerSegmentForTopicRewrite({
    answerText: sanitizedBaseReplyWithoutQuestion,
    latestListenerQuestionTopic
  })
    ? inferAnswerTopicFromAnswerSegment(sanitizedBaseReplyWithoutQuestion, null, latestListenerQuestionTopic)
    : null;

  if (closedTopicGuard && sanitizedBaseReplyWithoutQuestion && preservedAnswerTopic === normalizeTopicKey(latestListenerQuestionTopic)) {
    replyParts.push(sanitizedBaseReplyWithoutQuestion);
  }

  if (
    answerCard?.naturalAnswerHint &&
    latestTurn?.actorUserId === listener.userId &&
    normalizeTopicKey(repeatedTopicKey) === normalizeTopicKey(latestListenerQuestionTopic)
  ) {
    if (!replyParts.some((item) => isNearDuplicateText(item, answerCard.naturalAnswerHint))) {
      replyParts.push(answerCard.naturalAnswerHint);
    }
  }

  if (nextQuestion) {
    replyParts.push(nextQuestion);
  }

    if (!replyParts.length) {
    if (closedTopicGuard) {
      return {
        ...baseResult,
        reply: "",
        confirmed_facts: [...(Array.isArray(baseResult.confirmed_facts) ? baseResult.confirmed_facts : [])],
        open_questions: [],
        needs_human_input: {
          required: false,
          field: null,
          question: null,
          target_user_for_input: null
          },
        recommendation: "objectives_completed",
        repair_note: "closed_topic_guard_silenced",
        closed_topic_guard_resolution: "objectives_completed_without_followup",
        rewrite_failed: false
      };
    }

    if (suppressFalsePositiveHumanInput) {
      return alignFinalTurnSemantics(
        {
          ...baseResult,
          reply: sanitizedBaseReplyWithoutQuestion,
          confirmed_facts: Array.isArray(baseResult.confirmed_facts) ? baseResult.confirmed_facts : [],
          open_questions: [],
          needs_human_input: {
            required: false,
            field: null,
            question: null,
            target_user_for_input: null
          },
          recommendation: "pause_review",
          repair_note: "loop_repair_suppressed_false_positive",
          repeat_guard_suppressed: true,
          repeat_guard_suppression_reason: "answer_only_can_continue_without_human_input"
        },
        {
          activeTopicKey: repeatedTopicKey,
          latestListenerQuestionTopic
        }
      );
    }

    return {
      ...baseResult,
      reply: "",
      open_questions: ["当前这一题需要人工确认后再继续。"],
      needs_human_input: {
        required: true,
        field: repeatedTopicKey || "manual_review",
        question: failureQuestion,
        target_user_for_input: "self"
      },
      recommendation: "pause_review",
      repair_note: "loop_detected_without_safe_rewrite"
    };
  }

  const confirmedFacts =
    preservedAnswerTopic && Array.isArray(baseResult.confirmed_facts)
      ? baseResult.confirmed_facts.filter((fact) => normalizeTopicKey(fact?.key) === normalizeTopicKey(preservedAnswerTopic))
      : [];

  if (
    answerCard &&
    repeatedTopicKey &&
    normalizeTopicKey(repeatedTopicKey) === normalizeTopicKey(latestListenerQuestionTopic) &&
    !confirmedFacts.some(
      (fact) =>
        String(fact.key || "").trim() === repeatedTopicKey && String(fact.subjectUserId || "").toLowerCase() === "self"
    )
  ) {
    confirmedFacts.push({
      subjectUserId: "self",
      key: repeatedTopicKey,
      value: answerCard.normalizedSummary,
      confidence: 0.92,
      status: "confirmed"
    });
  }

  return {
    ...alignFinalTurnSemantics(
      {
        ...baseResult,
        reply: replyParts.join(" "),
        confirmed_facts: confirmedFacts,
        open_questions: nextQuestion ? [nextQuestion] : [],
        needs_human_input: {
          required: false,
          field: null,
          question: null,
          target_user_for_input: null
        },
        recommendation: nextQuestion ? "continue" : closedTopicGuard ? "objectives_completed" : "pause_review",
        repair_note: closedTopicGuard ? "closed_topic_guard_rewritten" : "looping_reply_rewritten",
        repeat_topic_guard_triggered: !closedTopicGuard,
        repeat_source: !closedTopicGuard ? "loop_repair" : null,
        closed_topic_guard_resolution: closedTopicGuard
          ? nextQuestion
            ? "rewritten_to_next_topic"
            : replyParts.length
              ? "answered_without_followup"
              : "objectives_completed_without_followup"
          : null,
        rewrite_source: closedTopicGuard ? "closed_topic_guard_rewrite" : "loop_rewrite",
        rewrite_preserved_answer_topic: preservedAnswerTopic || null,
        rewrite_target_topic: nextQuestion ? nextObjectiveKey || null : null,
        answer_segment_dropped_by_rewrite: Boolean(sanitizedBaseReplyWithoutQuestion) && !preservedAnswerTopic
      },
      {
        activeTopicKey: (nextQuestion ? nextObjectiveKey : null) || repeatedTopicKey,
        latestListenerQuestionTopic
      }
    )
  };
}

function repairLoopingReplyV2({ session, result, speaker, listener, objectives, turns }) {
  const latestTurn = turns.length ? turns[turns.length - 1] : null;
  const recentTurns = turns.slice(-6);
  const reply = normalizeText(result.reply);

  if (!reply) {
    return result;
  }

  const duplicatedLatest = latestTurn ? isNearDuplicateText(reply, latestTurn.content) : false;
  const duplicatedRecent = recentTurns.some((turn) => isNearDuplicateText(reply, turn.content));
  const latestTurnMetadata = normalizeMessageMetadata(latestTurn?.metadata || {});
  const resolvedCarryoverSourceTurnId = normalizeText(latestTurnMetadata.carryoverTwinQuestionTurnId);
  const resolvedCarryoverSourceTurn =
    resolvedCarryoverSourceTurnId &&
    session?.id
      ? (recentTurns.find((turn) => normalizeText(turn.id) === resolvedCarryoverSourceTurnId) ||
        getConversationTurnById(resolvedCarryoverSourceTurnId))
      : null;
  const resolvedCarryoverFacts =
    session?.id ? listExtractedFacts(session.id) : [];

  if (!duplicatedLatest && !duplicatedRecent) {
    return result;
  }

  if (
    latestTurnMetadata.carryoverTwinQuestionAnswered === true &&
    shouldSuppressRepeatPendingRequestForResolvedCarryover(
      session,
      latestTurnMetadata,
      resolvedCarryoverSourceTurn,
      resolvedCarryoverFacts
    )
  ) {
    return alignFinalTurnSemantics(
      {
        ...result,
        recommendation: "pause_review",
        needs_human_input: {
          required: false,
          field: null,
          question: null,
          target_user_for_input: null
        },
        repair_note: "loop_repair_suppressed_resolved_carryover",
        repeat_guard_suppressed: true,
        repeat_guard_suppression_reason: "resolved_carryover_answer_only"
      },
      {
        activeTopicKey: normalizeTopicKey(result?.canonical_reply_topic_key || result?.reply_topic_key),
        latestListenerQuestionTopic: normalizeTopicKey(result?.required_reply_topic)
      }
    );
  }

  const repeatedTopicKey =
    getTurnQuestionTopic(latestTurn) ||
    normalizeTopicKey(latestTurn?.metadata?.question_topic_key) ||
    inferQuestionTopicFromQuestionText(extractTrailingQuestionText(latestTurn?.content || "")) ||
    inferTopicKeyFromText(latestTurn?.content) ||
    normalizeTopicKey(result?.question_topic_key) ||
    inferQuestionTopicFromQuestionText(extractTrailingQuestionText(reply)) ||
    inferTopicKeyFromText(reply) ||
    objectives?.[0]?.key ||
    null;

  const rewritten = buildSafeFollowupReply({
    baseResult: result,
    speaker,
    listener,
    repeatedTopicKey,
    objectives,
    recentTurns,
    failureQuestion: "这轮预沟通出现了重复问答，请本人确认这一题的真实答案。",
    options: {
      suppressFalsePositiveHumanInput:
        Boolean(session?.id) &&
        Boolean(result?.did_answer_required_question) &&
        !normalizeText(result?.canonical_question_text || result?.emitted_question_text) &&
        shouldAllowMirrorQuestionForCoverage({
          session,
          turns: recentTurns,
          topicKey: normalizeTopicKey(result?.canonical_reply_topic_key || result?.emitted_reply_topic_key || result?.reply_topic_key),
          questionText: buildCanonicalMirrorQuestionForPendingTopic(
            session,
            normalizeTopicKey(result?.canonical_reply_topic_key || result?.emitted_reply_topic_key || result?.reply_topic_key)
          ),
          speakerUserId: speaker?.userId,
          listenerUserId: listener?.userId,
          latestListenerQuestionTopic:
            getTurnQuestionTopic(latestTurn) ||
            normalizeTopicKey(result?.required_reply_topic) ||
            normalizeTopicKey(result?.canonical_reply_topic_key || result?.emitted_reply_topic_key || result?.reply_topic_key),
          resultFacts: Array.isArray(result?.confirmed_facts) ? result.confirmed_facts : [],
          didAnswerRequiredQuestion: true
        }).required
    }
  });

  writeLlmTelemetry(
    buildQualityTelemetryPayload({
      reply_quality_issue: duplicatedLatest ? "mirrored_latest_question" : "duplicated_recent_question",
      rewrite_applied: true,
      rewrite_reason: "loop_repair",
      rewrite_failed: Boolean(rewritten.needs_human_input?.required)
    })
  );

  return rewritten;
}

function detectReplyQualityIssue({ result, turns, session = null, speaker = null, listener = null }) {
  const latestTurn = turns.length ? turns[turns.length - 1] : null;
  const recentTurns = turns.slice(-6);
  const reply = normalizeText(result.reply);

  if (!reply) {
    return null;
  }

  if (/在[^。！？]*可以接受[^。！？]*生活/u.test(reply) || /更倾向在[^。！？]*(可以接受|认真长期关系|住得近)[^。！？]*生活/u.test(reply)) {
    return "malformed_city_shell";
  }

  if (/按[^。！？]*(哈喽|你好|感觉你很不错|感觉不错|印象不错|聊得来|挺不错)[^。！？]*节奏推进结婚/u.test(reply)) {
    return "marriage_template_with_smalltalk_fragment";
  }

  if (
    /(哈喽|你好|感觉你很不错|印象不错|聊得来)/u.test(reply) &&
    /结婚|婚姻|推进/u.test(reply) &&
    !/年|节奏|先相处|稳定后|多久/u.test(reply)
  ) {
    return "topic_value_mismatch_marriage_timeline";
  }

  if (
    /关系目标上，我这边是.+你这边/u.test(reply) ||
    /婚姻节奏上，我这边是.+你这边/u.test(reply) ||
    /家庭边界上，我这边更偏向住得近/u.test(reply)
  ) {
    return "raw_fragment_sentence_shell";
  }

  if (
    /(我这边是认真长期关系，希望|我这边更偏向住得近|我这边是我可以接受)/u.test(reply) ||
    /(希望。|认真长期关系，希望。)/u.test(reply)
  ) {
    return "incomplete_predicate_object";
  }

  if (/待澄清/u.test(reply)) {
    return "non_speakable_fact_fragment";
  }

  if (latestTurn?.content && textLooksLikeQuestion(latestTurn.content) && isNearDuplicateText(reply, latestTurn.content)) {
    const suppression = shouldSuppressMirroredLatestQuestionQualityPause({
      session,
      result,
      turns,
      speaker,
      listener
    });
    if (suppression.suppressed) {
      writeLlmTelemetry(
        buildQualityTelemetryPayload({
          reply_quality_issue: "mirrored_latest_question",
          rewrite_applied: false,
          rewrite_reason: null,
          rewrite_failed: false,
          quality_pause_suppressed: true,
          quality_pause_suppression_reason: suppression.reason,
          quality_pause_false_positive_detected: true,
          quality_pause_source_turn_id: latestTurn.id || null,
          quality_pause_recovery_trigger: "live_guard_suppression",
          coverage_before_current_turn: suppression.coverageBefore,
          coverage_after_current_turn: suppression.coverageAfter
        })
      );
      return null;
    }
    return "mirrored_latest_question";
  }

  const duplicateRecentQuestion = recentTurns.some(
    (turn) => turn.actorUserId && textLooksLikeQuestion(turn.content) && isNearDuplicateText(reply, turn.content)
  );

  if (duplicateRecentQuestion) {
    return "duplicated_recent_question";
  }

  return null;
}

function shouldForceSilentQualityRetry(issue) {
  return new Set([
    "malformed_city_shell",
    "marriage_template_with_smalltalk_fragment",
    "topic_value_mismatch_marriage_timeline",
    "raw_fragment_sentence_shell",
    "incomplete_predicate_object",
    "non_speakable_fact_fragment"
  ]).has(normalizeText(issue));
}

function shouldSuppressDuplicatedRecentQuestionQualityPause({ result, turns = [], session = null }) {
  const normalizedResult = normalizeMessageMetadata(result || {});
  const canonicalReplyTopicKey =
    normalizeTopicKey(normalizedResult.canonical_reply_topic_key) ||
    normalizeTopicKey(normalizedResult.emitted_reply_topic_key) ||
    normalizeTopicKey(normalizedResult.reply_topic_key);
  const canonicalQuestionTopicKey =
    normalizeTopicKey(normalizedResult.canonical_question_topic_key) ||
    normalizeTopicKey(normalizedResult.emitted_question_topic_key) ||
    normalizeTopicKey(normalizedResult.question_topic_key);
  const canonicalQuestionText = normalizeText(
    normalizedResult.canonical_question_text || normalizedResult.emitted_question_text
  );

  if (!canonicalQuestionTopicKey || !canonicalQuestionText) {
    return {
      suppressed: false,
      reason: "missing_canonical_question"
    };
  }

  if (normalizedResult.switch_after_topic_close_allowed === true) {
    return {
      suppressed: true,
      reason: "switch_after_topic_close"
    };
  }

  if (
    session &&
    canonicalReplyTopicKey &&
    canonicalQuestionTopicKey !== canonicalReplyTopicKey &&
    !hasEquivalentOutstandingTwinQuestionForTopic(
      session,
      turns,
      canonicalQuestionTopicKey,
      null,
      canonicalQuestionText
    )
  ) {
    return {
      suppressed: true,
      reason: "distinct_followup_topic_after_answer"
    };
  }

  return {
    suppressed: false,
    reason: "true_recent_duplicate"
  };
}

function buildSilentQualityGuardFallbackResult(result, issue) {
  return alignFinalTurnSemantics(
    {
      ...result,
      reply: "",
      confirmed_facts: [],
      open_questions: [],
      needs_human_input: {
        required: true,
        field: "manual_review",
        question: "模型输出不可用，需要人工确认。",
        target_user_for_input: "self"
      },
      recommendation: "pause_review",
      quality_guard_reason: issue,
      reply_quality_issue: issue,
      rewrite_applied: true,
      rewrite_reason: `${issue}_silent_retry`,
      rewrite_failed: true,
      quality_pause_suppressed: true,
      quality_pause_suppression_reason: "silent_quality_guard_retry",
      model_output_failure: {
        kind: "turn_fallback",
        reason: "model_output_unstable"
      }
    },
    {
      activeTopicKey:
        normalizeTopicKey(result?.canonical_reply_topic_key) ||
        normalizeTopicKey(result?.emitted_reply_topic_key) ||
        normalizeTopicKey(result?.reply_topic_key) ||
        normalizeTopicKey(result?.canonical_question_topic_key) ||
        normalizeTopicKey(result?.emitted_question_topic_key) ||
        normalizeTopicKey(result?.question_topic_key) ||
        null,
      latestListenerQuestionTopic: normalizeTopicKey(result?.required_reply_topic) || null
    }
  );
}

function buildFactRejectionSilentRetryResult({
  result,
  topicKey = null,
  activeTopicKey = null,
  latestListenerQuestionTopic = null
} = {}) {
  const normalizedTopicKey =
    normalizeTopicKey(topicKey) ||
    normalizeTopicKey(activeTopicKey) ||
    normalizeTopicKey(latestListenerQuestionTopic) ||
    null;
  const droppedFactKeys = Array.isArray(result?.confirmed_facts)
    ? [...new Set(result.confirmed_facts.map((fact) => normalizeTopicKey(fact?.key)).filter(Boolean))]
    : [];

  return alignFinalTurnSemantics(
    {
      ...result,
      confirmed_facts: [],
      dropped_confirmed_fact_keys: [
        ...new Set([
          ...(Array.isArray(result?.dropped_confirmed_fact_keys) ? result.dropped_confirmed_fact_keys : []),
          ...droppedFactKeys
        ].map((item) => normalizeTopicKey(item)).filter(Boolean))
      ],
      reply_quality_issue: normalizeText(result?.reply_quality_issue) || "fact_rejected_for_persistence",
      quality_guard_reason: "fact_rejected_for_persistence",
      rewrite_applied: true,
      rewrite_reason: "fact_rejected_silent_retry",
      rewrite_failed: true,
      quality_pause_suppressed: true,
      quality_pause_suppression_reason: "fact_rejected_silent_retry",
      model_output_failure: {
        kind: "turn_fallback",
        reason: "model_output_unstable"
      }
    },
    {
      activeTopicKey: normalizedTopicKey,
      latestListenerQuestionTopic: normalizeTopicKey(latestListenerQuestionTopic) || normalizedTopicKey
    }
  );
}

function applyChineseQualityGuard({ result, speaker, listener, objectives, turns, session = null }) {
  const issue = detectReplyQualityIssue({
    result,
    turns,
    session,
    speaker,
    listener
  });

  if (!issue) {
    return result;
  }

  if (issue === "duplicated_recent_question") {
    const suppression = shouldSuppressDuplicatedRecentQuestionQualityPause({
      result,
      turns,
      session
    });

    if (suppression.suppressed) {
      writeLlmTelemetry(
        buildQualityTelemetryPayload({
          reply_quality_issue: issue,
          rewrite_applied: false,
          rewrite_reason: null,
          rewrite_failed: false,
          quality_pause_suppressed: true,
          quality_pause_suppression_reason: suppression.reason,
          quality_pause_false_positive_detected: true,
          quality_pause_recovery_trigger: "live_guard_suppression"
        })
      );
      return {
        ...result,
        quality_pause_suppressed: true,
        quality_pause_suppression_reason: suppression.reason
      };
    }
  }

  if (shouldForceSilentQualityRetry(issue)) {
    writeLlmTelemetry(
      buildQualityTelemetryPayload({
        reply_quality_issue: issue,
        rewrite_applied: true,
        rewrite_reason: `${issue}_silent_retry`,
        rewrite_failed: true,
        quality_pause_suppressed: true,
        quality_pause_suppression_reason: "silent_quality_guard_retry"
      })
    );

    return buildSilentQualityGuardFallbackResult(result, issue);
  }

  const latestTurn = turns.length ? turns[turns.length - 1] : null;
  const repeatedTopicKey =
    inferTopicKeyFromText(latestTurn?.content) || inferTopicKeyFromText(result.reply) || objectives?.[0]?.key || null;
  const repaired = buildSafeFollowupReply({
    baseResult: result,
    speaker,
    listener,
    repeatedTopicKey,
    objectives,
    recentTurns: turns.slice(-6),
    failureQuestion: "这一轮预沟通的表述不够自然，请本人确认这一题的真实说法。"
  });

  const repairedIssue = detectReplyQualityIssue({
    result: repaired,
    turns,
    session,
    speaker,
    listener
  });
  const rewriteNeedsHumanInput = Boolean(repaired.needs_human_input?.required);
  const suspiciousCityReply =
    repeatedTopicKey === "cities" && /在[^。！？]*可以接受[^。！？]*生活/u.test(normalizeText(repaired.reply));
  const suspiciousMarriageReply =
    repeatedTopicKey === "marriageTimeline" &&
    /按[^。！？]*(哈喽|你好|感觉你很不错|感觉不错|印象不错|聊得来|挺不错)[^。！？]*节奏推进结婚/u.test(
      normalizeText(repaired.reply)
    );

  if (!repairedIssue && !suspiciousCityReply && !suspiciousMarriageReply && !rewriteNeedsHumanInput) {
    writeLlmTelemetry(
      buildQualityTelemetryPayload({
        reply_quality_issue: issue,
        rewrite_applied: true,
        rewrite_reason: issue,
        rewrite_failed: false
      })
    );

    return {
      ...repaired,
      repair_note: `${repaired.repair_note || "rewritten"}_${issue}`,
      reply_quality_issue: issue,
      rewrite_applied: true,
      rewrite_reason: issue,
      rewrite_failed: false
    };
  }

  writeLlmTelemetry(
    buildQualityTelemetryPayload({
      reply_quality_issue: issue,
      rewrite_applied: true,
      rewrite_reason: rewriteNeedsHumanInput ? `${issue}_needs_human_input` : issue,
      rewrite_failed: issue === "mirrored_latest_question" ? false : true,
      quality_pause_suppressed: true,
      quality_pause_suppression_reason:
        issue === "mirrored_latest_question" ? "quality_guard_pause_removed" : "silent_quality_guard_retry"
    })
  );

  if (issue !== "mirrored_latest_question") {
    return buildSilentQualityGuardFallbackResult(result, issue);
  }

  return {
    ...repaired,
    recommendation: repaired.recommendation || result.recommendation || "continue",
    needs_human_input: {
      required: false,
      field: null,
      question: null,
      target_user_for_input: null
    },
    quality_guard_reason: issue,
    reply_quality_issue: issue,
    rewrite_applied: true,
    rewrite_reason: rewriteNeedsHumanInput ? `${issue}_needs_human_input` : issue,
    rewrite_failed: false,
    quality_pause_suppressed: true,
    quality_pause_suppression_reason: "quality_guard_pause_removed"
  };
}

function buildTurnContextV2({
  session,
  round,
  speaker,
  listener,
  objectives,
  turns,
  facts,
  automationMode,
  activeTopic = null,
  manualQuestion = null,
  carryoverTwinQuestion = null
}) {
  const dedupedTurns = collapseAdjacentDuplicateTwinTurns(turns || []);
  const canonicalizedTurns = dedupedTurns.map((turn) => canonicalizeHistoricalTwinTurn(turn, session, dedupedTurns));
  const sanitizedTurns = canonicalizedTurns.map((turn) => sanitizeTwinTurnForDisplay(turn, session));
  const trustedTurnsForPrompt = sanitizedTurns.filter((turn) => {
    if (!String(turn?.actorRole || "").endsWith("_twin")) {
      return true;
    }
    return isTrustedCanonicalTwinTurn(turn);
  });
  const openingContext = buildOpeningRecoveryTurnContext(session, sanitizedTurns);
  const turnsForPrompt = openingContext.effectiveFirstOpening
    ? openingContext.filteredTurns.filter((turn) => !String(turn?.actorRole || "").endsWith("_twin") || isTrustedCanonicalTwinTurn(turn))
    : trustedTurnsForPrompt;
  const latestTurn = turnsForPrompt.length ? turnsForPrompt[turnsForPrompt.length - 1] : null;
  const lastSpeakerTurn = [...turnsForPrompt].reverse().find((turn) => turn.actorUserId === speaker.userId) || null;
  const lastListenerTurn = [...turnsForPrompt].reverse().find((turn) => turn.actorUserId === listener.userId) || null;
  const latestListenerQuestionTopic =
    latestTurn?.actorUserId === listener.userId
      ? getTurnQuestionTopic(latestTurn)
      : null;
  const cleanFacts = sanitizeFactsForPrompt(facts, {
    source: "turn_context",
    sessionId: session.id,
    roundId: round.id
  });
  const topicControl = syncSessionTopicLedger(session, objectives, sanitizedTurns, cleanFacts);
  const topicAutomation = topicControl.automation;
  const effectiveActiveTopic = normalizeTopicKey(activeTopic || topicAutomation.activeTopicKey);
  const closedTopicKeys = TOPIC_CONFIG.map((item) => item.key).filter(
    (topicKey) => getTopicEntry(topicAutomation.topicLedger, topicKey)?.state === "closed"
  );
  const nextCandidateTopicKey = getTopicQueueSnapshot(session, objectives, topicAutomation.topicLedger).find(
    (topicKey) => topicKey !== effectiveActiveTopic
  ) || null;
  const topicKeys = [
    ...new Set([
      ...TOPIC_CONFIG.map((item) => item.key),
      ...objectives.map((item) => item.key),
      latestListenerQuestionTopic,
      effectiveActiveTopic
    ].filter(Boolean))
  ];
  const speakerFactCards = buildFactCards(speaker, topicKeys);
  const listenerFactCards = buildFactCards(listener, topicKeys);
  const suggestedAnswerMaterial = manualQuestion?.questionTopic
    ? speakerFactCards.find((item) => item.topicKey === normalizeTopicKey(manualQuestion.questionTopic)) || null
    : carryoverTwinQuestion?.questionTopic
      ? speakerFactCards.find((item) => item.topicKey === normalizeTopicKey(carryoverTwinQuestion.questionTopic)) || null
      : latestListenerQuestionTopic
        ? speakerFactCards.find((item) => item.topicKey === latestListenerQuestionTopic) || null
        : effectiveActiveTopic
          ? speakerFactCards.find((item) => item.topicKey === effectiveActiveTopic) || null
          : null;
  const turnFrame = buildCanonicalTurnFrame({
    session,
    speaker,
    listener,
    latestTurn,
    latestListenerQuestionTopic,
    manualQuestion,
    carryoverTwinQuestion,
    activeTopicKey: effectiveActiveTopic,
    activeTopicState: effectiveActiveTopic ? getTopicEntry(topicAutomation.topicLedger, effectiveActiveTopic) : null,
    nextCandidateTopicKey,
    closedTopicKeys,
    forbiddenTopicKeys: closedTopicKeys,
    suggestedAnswerMaterial,
    turnsForPrompt,
    openingContext
  });

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
    speaker_fact_cards: speakerFactCards,
    listener_fact_cards: listenerFactCards,
    turn_frame: turnFrame,
    latest_listener_question_topic: latestListenerQuestionTopic,
    suggested_answer_material: suggestedAnswerMaterial,
    active_topic: effectiveActiveTopic,
    active_topic_state: effectiveActiveTopic ? getTopicEntry(topicAutomation.topicLedger, effectiveActiveTopic) : null,
    closed_topic_keys: closedTopicKeys,
    forbidden_topic_keys: closedTopicKeys,
    next_candidate_topic_key: nextCandidateTopicKey,
    manual_question_mode: Boolean(manualQuestion?.enabled),
    manual_question_text: manualQuestion?.questionText || null,
    manual_question_topic: manualQuestion?.questionTopic || null,
    manual_question_asked_by_user_id: manualQuestion?.askedByUserId || null,
    carryover_twin_question_mode: Boolean(carryoverTwinQuestion?.enabled),
    carryover_twin_question_text: carryoverTwinQuestion?.questionText || null,
    carryover_twin_question_topic: carryoverTwinQuestion?.questionTopic || null,
    carryover_twin_question_turn_id: carryoverTwinQuestion?.sourceTurnId || null,
    carryover_twin_question_asked_by_user_id: carryoverTwinQuestion?.askedByUserId || null,
    automation_mode: automationMode,
    objective_source: getAutomationModeSource(session),
    preferred_objectives: getPreferredObjectiveKeysForSession(session),
    objectives: objectives.map((item) => ({
      key: item.key,
      label: item.label,
      prompt: item.prompt
    })),
    objective_progress: buildObjectiveProgress(session, objectives, cleanFacts),
    recent_turns: turnsForPrompt
      .filter((turn) => !String(turn?.actorRole || "").endsWith("_twin") || isTrustedCanonicalTwinTurn(turn))
      .slice(-6)
      .map((turn) => ({
      actorRole: turn.actorRole,
      actorUserId: turn.actorUserId,
      content: turn.content
      })),
    known_facts: cleanFacts.slice(-12).map((fact) => ({
      key: fact.key,
      value: fact.value,
      confidence: fact.confidence,
      subjectUserId: fact.subjectUserId
    })),
    conversation_state: {
      conversation_started: turnsForPrompt.length > 0,
      is_first_twin_message: openingContext.effectiveFirstOpening,
      latest_turn_from_listener: latestTurn?.actorUserId === listener.userId,
      latest_turn_is_question: textLooksLikeQuestion(latestTurn?.content),
      latest_turn_content: latestTurn?.content || null,
      last_speaker_message: lastSpeakerTurn?.content || null,
      last_listener_message: lastListenerTurn?.content || null
    },
    opening_recovery_context: {
      effective_first_opening: openingContext.effectiveFirstOpening,
      has_any_twin_turn: openingContext.hasAnyTwinTurn,
      filtered_turn_count: openingContext.filteredTurnCount
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
  const cleanFacts = sanitizeFactsForPrompt(facts, {
    source: "stage_context",
    sessionId: session.id,
    roundId: round.id
  });
  const nextControl = syncSessionTopicLedger(session, objectives, turns, cleanFacts);
  const stageSession = {
    ...session,
    control: nextControl
  };
  const scopedObjectiveKeys = getEffectiveScopedObjectiveKeys(stageSession, round, objectives);
  const sessionFacts = sanitizeFactsForPrompt(listExtractedFacts(session.id), {
    source: "stage_context_scoped",
    sessionId: session.id,
    roundId: round.id
  });
  const scopedFacts = sessionFacts.filter((fact) => {
    const topicKey = normalizeTopicKey(fact?.key);
    return !scopedObjectiveKeys.length || scopedObjectiveKeys.includes(topicKey);
  });
  const counterpartySummaryFrame = buildCounterpartySummaryFrame(stageSession, sessionFacts, {
    scopedObjectiveKeys
  });
  return {
    session_id: session.id,
    round_number: round.roundNumber,
    stop_reason: stopReason,
    objectives: objectives.map((item) => ({
      key: item.key,
      label: item.label,
      prompt: item.prompt
    })),
    objective_progress: buildObjectiveProgress(stageSession, objectives, scopedFacts),
    active_topic: getSessionControl(stageSession).automation.activeTopicKey,
    topic_ledger: getSessionControl(stageSession).automation.topicLedger,
    turns: turns.map((turn) => ({
      actorRole: turn.actorRole,
      content: turn.content
    })),
    facts: scopedFacts.map((fact) => ({
      key: fact.key,
      value: fact.value,
      confidence: fact.confidence,
      subjectUserId: fact.subjectUserId
    })),
    counterparty_summary_frame: counterpartySummaryFrame
  };
}

function toSessionResponse(detail, currentUserId) {
  const { session } = detail;
  const participants = getSessionParticipantProfiles(session);
  const sessionWithParticipants = {
    ...session,
    initiator: participants.initiator,
    counterparty: participants.counterparty
  };
  const currentTwin =
    participants.initiator?.userId === currentUserId ? participants.initiator : participants.counterparty;
  const latestRound = Array.isArray(detail.rounds) && detail.rounds.length ? detail.rounds[detail.rounds.length - 1] : null;
  const turnMap = new Map((detail.turns || []).map((turn) => [turn.id, turn]));
  const visibleTurns = (detail.turns || [])
    .map((turn) => buildVisibleTurn(turn, session, currentUserId, turnMap))
    .filter(Boolean);
  const cleanFacts = sanitizeFactsForSessionResponse(detail.facts || [], {
    source: "session_response",
    sessionId: session.id
  });
  const cleanStageReports = (detail.stageReports || []).map((report) => ({
    ...report,
    payload: sanitizeStageReportPayloadForResponse(report?.payload, sessionWithParticipants, currentUserId, {
      source: "stage_report_response",
      sessionId: session.id,
      roundId: report.roundId
    })
  }));

  return {
    ...detail,
    facts: cleanFacts,
    stageReports: cleanStageReports,
    turns: visibleTurns,
    currentUser: currentTwin
      ? {
          id: currentTwin.userId,
          displayName: currentTwin.displayName,
          email: currentTwin.email
        }
      : null,
    session: {
      ...session,
      control: getSessionControl(session),
      latestStopReason: latestRound?.stopReason || null,
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

function isRecoverableFirstTurnTopicGuardSession(detail) {
  const session = detail?.session;
  if (!session || session.status !== "pending_human_input") {
    return false;
  }

  if (isManualPauseActive(session)) {
    return false;
  }

  const pendingRequests = (detail.humanInputRequests || []).filter((request) => request.status === "pending");
  if (!pendingRequests.length) {
    return false;
  }

  const latestRound = Array.isArray(detail.rounds) && detail.rounds.length ? detail.rounds[detail.rounds.length - 1] : null;
  if (!latestRound || Number(latestRound.roundNumber || 0) !== 1) {
    return false;
  }

  const turns = detail.turns || [];
  const nonSystemTurns = turns.filter((turn) => turn.actorUserId != null);
  if (nonSystemTurns.length) {
    return false;
  }

  const control = getSessionControl(session);
  const activeTopicKey = normalizeTopicKey(control.automation.activeTopicKey);
  if (!activeTopicKey) {
    return false;
  }

  const onlyTopicGuardRequests = pendingRequests.every((request) => {
    const source = normalizeText(request.metadata?.source);
    const firstTurnGuardBlock = Boolean(request.metadata?.firstTurnGuardBlock);
    return (
      request.fieldKey === activeTopicKey &&
      (source === "topic_guard_blocked_first_turn" || firstTurnGuardBlock)
    );
  });

  if (!onlyTopicGuardRequests) {
    return false;
  }

  return turns.every((turn) => {
    const source = normalizeText(turn.metadata?.source);
    return (
      turn.actorRole === "system" &&
      turn.metadata?.pauseReason === "pending_human_input" &&
      turn.metadata?.fieldKey === activeTopicKey &&
      (source === "topic_guard_blocked_first_turn" || Boolean(turn.metadata?.firstTurnGuardBlock))
    );
  });
}

function isRecoverablePausedQuestionSession(detail) {
  if (!detail?.session || detail.session.status !== "paused_review") {
    return false;
  }

  if (isManualPauseActive(detail.session)) {
    return false;
  }

  if (hasPendingHumanInput(detail) || hasPendingSensitiveApproval(detail)) {
    return false;
  }

  const latestRound = Array.isArray(detail.rounds) && detail.rounds.length ? detail.rounds[detail.rounds.length - 1] : null;
  if (
    !latestRound ||
    normalizeText(latestRound.stopReason) !== "outstanding_twin_question_unanswered"
  ) {
    return false;
  }

  const sessionUpdatedAt = Date.parse(detail.session.updatedAt || "");
  const roundUpdatedAt = Date.parse(latestRound.updatedAt || latestRound.createdAt || "");
  const isFreshCurrentRoundPause =
    Number.isFinite(sessionUpdatedAt) &&
    Number.isFinite(roundUpdatedAt) &&
    detail.session.currentRound === latestRound.roundNumber &&
    Math.abs(sessionUpdatedAt - roundUpdatedAt) < 1500;
  const hasResolvedManualReview = Boolean(getLatestResolvedManualReview(detail));
  const latestTurn = Array.isArray(detail.turns) && detail.turns.length ? detail.turns[detail.turns.length - 1] : null;
  const latestTurnIsTwinQuestion =
    Boolean(latestTurn) &&
    String(latestTurn.actorRole || "").endsWith("_twin") &&
    textLooksLikeQuestion(latestTurn.content);

  if (isFreshCurrentRoundPause && !hasResolvedManualReview && !latestTurnIsTwinQuestion) {
    return false;
  }

  return Boolean(detectOutstandingTwinQuestion(detail.session, detail.turns || [], latestRound));
}

function isRecoverableSemanticMisalignmentSession(detail) {
  if (!detail?.session || detail.session.status !== "paused_review") {
    return false;
  }

  if (isManualPauseActive(detail.session)) {
    return false;
  }

  if (hasPendingHumanInput(detail) || hasPendingSensitiveApproval(detail)) {
    return false;
  }

  if (!hasUnresolvedTopicBacklog(detail.session)) {
    return false;
  }

  const visibleTurns = detail.turns || [];
  const latestTwinTurns = visibleTurns.filter((turn) => String(turn.actorRole || "").endsWith("_twin")).slice(-2);
  if (!latestTwinTurns.length) {
    return false;
  }

  return latestTwinTurns.some((turn) => isSemanticallyMisalignedTwinTurn(turn));
}

function isRecoverableInvalidClosedTopicPendingRequest(detail) {
  const session = detail?.session;
  if (!session || session.status !== "pending_human_input") {
    return false;
  }

  if (isManualPauseActive(session)) {
    return false;
  }

  const pendingRequests = (detail.humanInputRequests || []).filter((request) => request.status === "pending");
  if (!pendingRequests.length) {
    return false;
  }

  const facts = detail.facts || [];

  return pendingRequests.every((request) => {
    const fieldKey = normalizeTopicKey(request.fieldKey);
    const questionText = normalizeText(request.questionText);

    return (
      Boolean(fieldKey) &&
      /已经确认完成，请不要重复确认/u.test(questionText) &&
      hasBothSidesConfirmedTopic(session, facts, fieldKey)
    );
  });
}

function isRecoverableInvalidNextCandidateTopicPendingRequest(detail, currentUserId) {
  const session = detail?.session;
  if (!session || session.status !== "pending_human_input") {
    return false;
  }

  if (isManualPauseActive(session)) {
    return false;
  }

  const pendingRequests = (detail.humanInputRequests || []).filter((request) => request.status === "pending");
  if (!pendingRequests.length) {
    return false;
  }

  const latestRound = Array.isArray(detail.rounds) && detail.rounds.length ? detail.rounds[detail.rounds.length - 1] : null;
  if (!latestRound || latestRound.stopReason !== "pending_human_input") {
    return false;
  }

  const currentRole = participantRole(session, currentUserId);
  const reviewInbox = getSessionControl(session).reviewInbox;
  const objectivesCompletedSeenAt = reviewInbox.objectivesCompleted?.seenByRole?.[currentRole] || null;
  const hasCanonicalCompletionEvidence =
    areAllCanonicalTopicsClosed(session) ||
    TOPIC_CONFIG.every((topic) => hasBothSidesConfirmedTopic(session, detail.facts || [], topic.key));
  const recentTwinTurns = (detail.turns || []).filter((turn) => String(turn.actorRole || "").endsWith("_twin")).slice(-2);
  const hasClosedTopicSilencedTwinTurn = recentTwinTurns.some(
    (turn) =>
      !normalizeText(turn.content) &&
      normalizeText(turn.metadata?.repair_note) === "closed_topic_guard_silenced" &&
      ["pause_without_pending_request", "objectives_completed_without_followup"].includes(
        normalizeText(turn.metadata?.closed_topic_guard_resolution)
      )
  );
  const latestRoundHasEmptyObjectives = !Array.isArray(latestRound.objective?.topics) || latestRound.objective.topics.length === 0;
  const matchesHistoricalPollutionShape =
    latestRoundHasEmptyObjectives &&
    hasClosedTopicSilencedTwinTurn &&
    !hasPendingSensitiveApproval(detail);

  return pendingRequests.every((request) => {
    const questionText = normalizeText(request.questionText);
    const source = normalizeText(request.metadata?.source);
    return (
      request.fieldKey === "next_candidate_topic_key" &&
      request.targetUserId === currentUserId &&
      (source === "all_topics_closed" ||
        /forbidden_topic_keys/u.test(questionText) ||
        /当前所有核心议题/u.test(questionText)) &&
      (!hasUnresolvedTopicBacklog(session) && hasCanonicalCompletionEvidence || matchesHistoricalPollutionShape) &&
      !objectivesCompletedSeenAt
    );
  });
}

function canAutoRecoverTopicGuardFalsePositivePendingRequest(detail, request) {
  const session = detail?.session;
  if (!session || session.status !== "pending_human_input" || !request || request.status !== "pending") {
    return false;
  }

  const source = normalizeText(request.metadata?.source);
  if (!["topic_guard_blocked", "topic_guard_blocked_first_turn"].includes(source)) {
    return false;
  }

  const activeTopicKey = normalizeTopicKey(request.metadata?.activeTopicKey || request.fieldKey);
  const derivedReplyTopicKey = normalizeTopicKey(request.metadata?.derivedReplyTopicKey);
  const derivedQuestionTopicKey = normalizeTopicKey(request.metadata?.derivedQuestionTopicKey);
  const rawReply = normalizeText(request.metadata?.rawReply);
  if (!activeTopicKey || !derivedReplyTopicKey || !derivedQuestionTopicKey || !rawReply) {
    return false;
  }

  if (activeTopicKey !== derivedReplyTopicKey || activeTopicKey === derivedQuestionTopicKey) {
    return false;
  }

  const targetUserId = request.targetUserId || null;
  const speakerProfile =
    targetUserId && targetUserId === session.initiatorUserId
      ? getCurrentTwin(session.initiatorUserId)
      : targetUserId && targetUserId === session.counterpartyUserId
        ? getCurrentTwin(session.counterpartyUserId)
        : null;
  const fallbackFact = buildResolvedFactForTopicFromProfile(speakerProfile, activeTopicKey, targetUserId);
  if (!fallbackFact) {
    return false;
  }

  const closeDecision = resolveTopicCloseDecision({
    session,
    factsForValidation: detail.facts || [],
    resultFacts: [fallbackFact],
    topicKey: activeTopicKey,
    speaker: speakerProfile,
    canonicalReplyTopicKey: activeTopicKey,
    didAnswerRequiredQuestion: true,
    latestListenerQuestionTopic: activeTopicKey
  });

  return closeDecision.canClose;
}

function isRecoverableTopicGuardFalsePositivePendingRequest(detail) {
  const session = detail?.session;
  if (!session || session.status !== "pending_human_input") {
    return false;
  }

  if (isManualPauseActive(session)) {
    return false;
  }

  const pendingRequests = (detail.humanInputRequests || []).filter((request) => request.status === "pending");
  if (!pendingRequests.length) {
    return false;
  }

  return pendingRequests.every((request) => canAutoRecoverTopicGuardFalsePositivePendingRequest(detail, request));
}

function canDeterministicallyRecoverMirrorQuestionSource(session, sourceTurn, responderUserId = null) {
  if (!session || !sourceTurn) {
    return false;
  }

  const metadata = normalizeMessageMetadata(sourceTurn.metadata || {});
  const normalizedResponderUserId =
    normalizeText(responderUserId) ||
    (normalizeText(sourceTurn.actorUserId) === normalizeText(session.initiatorUserId)
      ? normalizeText(session.counterpartyUserId)
      : normalizeText(session.initiatorUserId));
  const sourceQuestionTopic =
    normalizeTopicKey(metadata.canonical_question_topic_key) ||
    normalizeTopicKey(metadata.emitted_question_topic_key) ||
    normalizeTopicKey(metadata.question_topic_key);
  const sourceReplyTopic =
    normalizeTopicKey(metadata.canonical_reply_topic_key) ||
    normalizeTopicKey(metadata.emitted_reply_topic_key) ||
    normalizeTopicKey(metadata.reply_topic_key);

  if (
    !sourceQuestionTopic ||
    sourceQuestionTopic !== sourceReplyTopic ||
    metadata.did_answer_required_question !== true ||
    metadata.mirror_question_required_for_coverage !== true ||
    metadata.mirror_question_allowed !== true
  ) {
    return false;
  }

  const speakerTwin = getCurrentTwin(normalizedResponderUserId);
  const answerHint = buildTopicAnswerV2(speakerTwin, sourceQuestionTopic);
  if (!normalizeText(answerHint)) {
    return false;
  }

  const speakerFact = buildResolvedFactForTopicFromProfile(speakerTwin, sourceQuestionTopic, normalizedResponderUserId);
  if (!speakerFact) {
    return false;
  }

  const responderRole = getParticipantRoleForUserId(session, normalizedResponderUserId);
  const coverageBefore = getObjectiveCoverage(session, listExtractedFacts(session.id), sourceQuestionTopic);

  return Boolean(responderRole && coverageBefore[responderRole] === false);
}

function buildDeterministicMirrorQuestionRecoveryResult(session, sourceTurn, speaker, listener) {
  if (!session || !sourceTurn || !speaker || !listener) {
    return null;
  }

  const metadata = normalizeMessageMetadata(sourceTurn.metadata || {});
  const topicKey =
    normalizeTopicKey(metadata.canonical_question_topic_key) ||
    normalizeTopicKey(metadata.emitted_question_topic_key) ||
    normalizeTopicKey(metadata.question_topic_key);

  if (!topicKey) {
    return null;
  }

  const speakerFact = buildResolvedFactForTopicFromProfile(speaker, topicKey, speaker.userId);
  const answerText = buildTopicAnswerV2(speaker, topicKey);
  if (!speakerFact || !normalizeText(answerText)) {
    return null;
  }

  return alignFinalTurnSemantics(
    {
      reply: answerText,
      reply_topic_key: topicKey,
      question_topic_key: null,
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [speakerFact],
      open_questions: [],
      risk_flags: [],
      needs_human_input: {
        required: false,
        field: null,
        question: null,
        target_user_for_input: null
      },
      recommendation: "continue",
      repair_note: "deterministic_mirror_question_recovery",
      repeat_guard_suppressed: true,
      repeat_guard_suppression_reason: "deterministic_mirror_question_recovery",
      mirror_question_required_for_coverage: false,
      mirror_question_allowed: false,
      carryover_source_valid: true,
      rewrite_source: "deterministic_mirror_question_recovery"
    },
    {
      activeTopicKey: topicKey,
      latestListenerQuestionTopic: topicKey,
      speakerUserId: speaker.userId,
      listenerUserId: listener.userId
    }
  );
}

function canAutoRecoverMirrorQuestionFalsePositivePendingRequest(detail, request) {
  const session = detail?.session;
  if (!session || session.status !== "pending_human_input" || !request || request.status !== "pending") {
    return false;
  }

  if (normalizeText(request.questionText) !== "这一轮预沟通的表述不够自然，请本人确认后再继续。") {
    return false;
  }

  const sourceTurn = resolveMirrorQuestionFalsePositiveSourceTurn(detail, request);
  return canDeterministicallyRecoverMirrorQuestionSource(session, sourceTurn, request.targetUserId);
}

function canAutoRecoverDuplicatedRecentQuestionFalsePositivePendingRequest(detail, request) {
  const session = detail?.session;
  if (!session || session.status !== "pending_human_input" || !request || request.status !== "pending") {
    return false;
  }

  if (normalizeText(request.questionText) !== "这一轮预沟通的表述不够自然，请本人确认后再继续。") {
    return false;
  }

  if (normalizeText(request.metadata?.replyQualityIssue) !== "duplicated_recent_question") {
    return false;
  }

  const sourceTurnId = normalizeText(request.metadata?.sourceTurnId);
  if (!sourceTurnId) {
    return false;
  }

  const sourceTurn =
    (detail.turns || []).find((turn) => turn.id === sourceTurnId) ||
    getConversationTurnById(sourceTurnId);
  if (!sourceTurn) {
    return false;
  }

  return shouldSuppressDuplicatedRecentQuestionQualityPause({
    result: normalizeMessageMetadata(sourceTurn.metadata || {}),
    turns: detail.turns || [],
    session
  }).suppressed;
}

function canAutoResolveGenericQualityPausePendingRequest(detail, request) {
  const session = detail?.session;
  if (!session || session.status !== "pending_human_input" || !request || request.status !== "pending") {
    return false;
  }

  const normalizedQuestionText = normalizeText(request.questionText);
  if (
    normalizedQuestionText &&
    normalizedQuestionText !== "这一轮预沟通的表述不够自然，请本人确认后再继续。" &&
    !/^\?+$/u.test(normalizedQuestionText)
  ) {
    return false;
  }

  if (normalizeText(request.metadata?.source) !== "quality_guard") {
    return false;
  }

  const issue = normalizeText(request.metadata?.replyQualityIssue || request.metadata?.qualityGuardReason);
  if (!issue) {
    return false;
  }

  return !["mirrored_latest_question", "duplicated_recent_question"].includes(issue);
}

function isRecoverableGenericQualityPausePendingRequest(detail) {
  const session = detail?.session;
  if (!session || session.status !== "pending_human_input") {
    return false;
  }

  if (isManualPauseActive(session)) {
    return false;
  }

  const pendingRequests = (detail.humanInputRequests || []).filter((request) => request.status === "pending");
  if (!pendingRequests.length) {
    return false;
  }

  return pendingRequests.every((request) => canAutoResolveGenericQualityPausePendingRequest(detail, request));
}

function isRecoverableDuplicatedRecentQuestionFalsePositivePendingRequest(detail) {
  const session = detail?.session;
  if (!session || session.status !== "pending_human_input") {
    return false;
  }

  if (isManualPauseActive(session)) {
    return false;
  }

  const pendingRequests = (detail.humanInputRequests || []).filter((request) => request.status === "pending");
  if (!pendingRequests.length) {
    return false;
  }

  return pendingRequests.every((request) => canAutoRecoverDuplicatedRecentQuestionFalsePositivePendingRequest(detail, request));
}

function resolveMirrorQuestionFalsePositiveSourceTurn(detail, request) {
  const sourceTurnId = normalizeText(request.metadata?.sourceTurnId);
  if (sourceTurnId) {
    return (detail.turns || []).find((turn) => turn.id === sourceTurnId) || getConversationTurnById(sourceTurnId);
  }

  const normalizedRoundId = normalizeText(request.roundId);
  const requestedTurnNumber = Number(request.metadata?.turnNumber);
  const turns = (detail.turns || [])
    .filter((turn) => (!normalizedRoundId || normalizeText(turn.roundId) === normalizedRoundId) && String(turn.actorRole || "").endsWith("_twin"))
    .sort((left, right) => Number(left.turnNumber || 0) - Number(right.turnNumber || 0));

  if (Number.isFinite(requestedTurnNumber)) {
    const priorTwinTurn = turns.find((turn) => Number(turn.turnNumber || 0) === Math.max(0, requestedTurnNumber - 1));
    if (priorTwinTurn) {
      return priorTwinTurn;
    }
  }

  return turns.length ? turns[turns.length - 1] : null;
}

function isRecoverableMirrorQuestionFalsePositivePendingRequest(detail) {
  const session = detail?.session;
  if (!session || session.status !== "pending_human_input") {
    return false;
  }

  if (isManualPauseActive(session)) {
    return false;
  }

  const pendingRequests = (detail.humanInputRequests || []).filter((request) => request.status === "pending");
  if (!pendingRequests.length) {
    return false;
  }

  return pendingRequests.every((request) => canAutoRecoverMirrorQuestionFalsePositivePendingRequest(detail, request));
}

async function autoRecoverManualReviewSession(sessionId, currentUserId) {
  const detail = getSessionDetailForUser(sessionId, currentUserId);

  if (!detail || !isAutoRecoverableManualReviewSession(detail, currentUserId)) {
    return false;
  }

  if (isManualPauseActive(detail.session)) {
    return false;
  }

  for (const request of detail.humanInputRequests.filter((item) => item.status === "pending")) {
    resolveHumanInputRequest(request.id, "[auto-resume]", {
      resolvedByUserId: currentUserId,
      autoResolved: true
    });
  }

  updatePrechatSession(sessionId, { status: "paused_review" });
  scheduleSessionAutomation(sessionId, currentUserId, "manual_review_auto_recovered");
  return true;
}

async function autoRecoverFirstTurnTopicGuardSession(sessionId, currentUserId) {
  const detail = getSessionDetailForUser(sessionId, currentUserId);

  if (!detail || !isRecoverableFirstTurnTopicGuardSession(detail)) {
    return false;
  }

  const pendingRequests = (detail.humanInputRequests || []).filter((request) => request.status === "pending");
  for (const request of pendingRequests) {
    resolveHumanInputRequest(request.id, "[auto-recovered-first-turn-topic-guard]", {
      ...(request.metadata || {}),
      resolvedByUserId: currentUserId,
      autoResolved: true,
      autoRecoverySource: "topic_guard_blocked_first_turn"
    });
  }

  updatePrechatSession(sessionId, { status: "paused_review" });
  emitTopicGuardTelemetry(
    {
      source: "topic_guard_recovered_session",
      firstTurnGuardBlock: true,
      sessionId,
      roundId: detail.rounds?.[detail.rounds.length - 1]?.id || null,
      trigger: "session_view",
      activeTopicKey: getSessionControl(detail.session).automation.activeTopicKey,
      derivedReplyTopicKey: null,
      derivedQuestionTopicKey: null,
      topicInferenceSource: {},
      rawReply: "",
      rawOpenQuestions: [],
      isFirstTurn: true,
      isReportPlan: getSessionControl(detail.session).automation.source === "report_plan",
      effectiveFirstOpening: true,
      hasAnyTwinTurn: false,
      openingRecoveryTriggered: true,
      openingContextFilteredTurnCount: (detail.turns || []).length
    },
    {
      topic_guard_event: "topic_guard_recovered_session",
      topic_guard_recovered_session: true,
      opening_recovery_triggered: true
    }
  );
  return true;
}

async function autoRecoverInvalidClosedTopicPendingRequest(sessionId, currentUserId) {
  const detail = getSessionDetailForUser(sessionId, currentUserId);

  if (!detail || !isRecoverableInvalidClosedTopicPendingRequest(detail)) {
    return false;
  }

  const pendingRequests = (detail.humanInputRequests || []).filter((request) => request.status === "pending");
  for (const request of pendingRequests) {
    resolveHumanInputRequest(request.id, "[auto-dismissed-invalid-closed-topic-pending-request]", {
      ...(request.metadata || {}),
      resolvedByUserId: currentUserId,
      autoResolved: true,
      autoRecoverySource: "invalid_closed_topic_pending_request"
    });

    emitTopicGuardTelemetry(
      {
        source: "invalid_closed_topic_pending_request",
        firstTurnGuardBlock: false,
        sessionId,
        roundId: request.roundId || detail.rounds?.[detail.rounds.length - 1]?.id || null,
        trigger: "session_view",
        activeTopicKey: normalizeTopicKey(request.fieldKey),
        objectiveKeys: detail.rounds?.[detail.rounds.length - 1]?.objective?.topics?.map((item) => item.key) || [],
        derivedReplyTopicKey: null,
        derivedQuestionTopicKey: normalizeTopicKey(request.fieldKey),
        topicInferenceSource: {},
        rawReply: "",
        rawOpenQuestions: [normalizeText(request.questionText)],
        isFirstTurn: false,
        isReportPlan: getSessionControl(detail.session).automation.source === "report_plan",
        closedTopicKeys: [normalizeTopicKey(request.fieldKey)].filter(Boolean)
      },
      {
        topic_guard_event: "closed_topic_guard_pending_human_input_recovered",
        closed_topic_guard_pending_human_input_recovered: true
      }
    );
  }

  updatePrechatSession(sessionId, { status: "paused_review" });
  return true;
}

async function autoRecoverInvalidNextCandidateTopicPendingRequest(sessionId, currentUserId) {
  const detail = getSessionDetailForUser(sessionId, currentUserId);

  if (!detail || !isRecoverableInvalidNextCandidateTopicPendingRequest(detail, currentUserId)) {
    return false;
  }

  const latestRound = detail.rounds?.[detail.rounds.length - 1] || null;
  const pendingRequests = (detail.humanInputRequests || []).filter((request) => request.status === "pending");
  for (const request of pendingRequests) {
    resolveHumanInputRequest(request.id, "[auto-dismissed-invalid-next-candidate-topic-request]", {
      ...(request.metadata || {}),
      resolvedByUserId: currentUserId,
      autoResolved: true,
      autoRecoverySource: "invalid_next_candidate_topic_pending_request"
    });

    emitTopicGuardTelemetry(
      {
        source: "invalid_next_candidate_topic_pending_request",
        firstTurnGuardBlock: false,
        sessionId,
        roundId: request.roundId || latestRound?.id || null,
        trigger: "session_view",
        activeTopicKey: null,
        objectiveKeys: latestRound?.objective?.topics?.map((item) => item.key) || [],
        derivedReplyTopicKey: null,
        derivedQuestionTopicKey: null,
        topicInferenceSource: {},
        rawReply: "",
        rawOpenQuestions: [normalizeText(request.questionText)],
        isFirstTurn: false,
        isReportPlan: getSessionControl(detail.session).automation.source === "report_plan",
        closedTopicKeys: TOPIC_CONFIG.map((item) => item.key)
      },
      {
        topic_guard_event: "invalid_next_candidate_topic_pending_request_recovered",
        invalid_next_candidate_topic_pending_request_recovered: true
      }
    );
  }

  if (latestRound && (latestRound.status !== "completed" || latestRound.stopReason !== "objectives_completed")) {
    finishPrechatRound(latestRound.id, { status: "completed", stopReason: "objectives_completed" });
  }

  const sessionAfterFinish = getPrechatSessionById(sessionId) || detail.session;
  const latestRoundAfterFinish = latestRound ? getPrechatRound(latestRound.id) || latestRound : null;
  const nextPatch = {
    status: "paused_review"
  };

  if (latestRoundAfterFinish) {
    nextPatch.control = buildObjectivesCompletedReviewInboxPatch(
      sessionAfterFinish,
      latestRoundAfterFinish,
      latestRoundAfterFinish.updatedAt || sessionAfterFinish.updatedAt || nowIso()
    );
  }

  updatePrechatSession(sessionId, nextPatch);
  return true;
}

async function autoRecoverRepeatFalsePositivePendingRequest(sessionId, currentUserId) {
  const detail = getSessionDetailForUser(sessionId, currentUserId);

  if (!detail || !isRecoverableRepeatFalsePositivePendingRequest(detail)) {
    return false;
  }

  const pendingRequests = (detail.humanInputRequests || []).filter((request) => request.status === "pending");
  const sessionWideOutstanding = getSessionWideOutstandingTwinQuestionRecovery(detail);

  for (const request of pendingRequests) {
    const sourceTurn = resolveRepeatFalsePositiveCanonicalSourceTurn(detail, request);
    const latestTwinTurn = (detail.turns || []).filter((turn) => String(turn.actorRole || "").endsWith("_twin")).slice(-1)[0] || null;
    const latestTwinTurnMetadata = normalizeMessageMetadata(latestTwinTurn?.metadata || {});
    resolveHumanInputRequest(request.id, "[auto-dismissed-repeat-false-positive]", {
      ...(request.metadata || {}),
      resolvedByUserId: currentUserId,
      autoResolved: true,
      autoRecoverySource: "repeat_false_positive_pending_request",
      sourceTurnId: sourceTurn?.id || normalizeText(request.metadata?.sourceTurnId) || null,
      repeatFalsePositiveSourceTurnId: sourceTurn?.id || null,
      source: normalizeText(request.metadata?.source) || "carryover_twin_question",
      repeatSource:
        normalizeText(request.metadata?.repeatSource) ||
        normalizeText(latestTwinTurnMetadata.repeat_source) ||
        null,
      carryoverTwinQuestionTurnId:
        normalizeText(request.metadata?.carryoverTwinQuestionTurnId) ||
        normalizeText(latestTwinTurnMetadata.carryoverTwinQuestionTurnId) ||
        null,
      postAnswerContinuationStrategy:
        normalizeText(request.metadata?.postAnswerContinuationStrategy) ||
        normalizeText(latestTwinTurnMetadata.post_answer_continuation_strategy) ||
        null,
      activeTopicKey:
        normalizeTopicKey(request.metadata?.activeTopicKey) ||
        normalizeTopicKey(getSessionControl(detail.session).automation.activeTopicKey) ||
        null,
      coverageBefore:
        request.metadata?.coverageBefore ||
        latestTwinTurnMetadata.coverage_before_current_turn ||
        null,
      coverageAfter:
        request.metadata?.coverageAfter ||
        latestTwinTurnMetadata.coverage_after_current_turn ||
        null
    });
  }

  updatePrechatSession(sessionId, { status: "paused_review" });
  return true;
}

async function autoRecoverTopicGuardFalsePositivePendingRequest(sessionId, currentUserId) {
  const detail = getSessionDetailForUser(sessionId, currentUserId);

  if (!detail || !isRecoverableTopicGuardFalsePositivePendingRequest(detail)) {
    return false;
  }

  const pendingRequests = (detail.humanInputRequests || []).filter((request) => request.status === "pending");
  for (const request of pendingRequests) {
    resolveHumanInputRequest(request.id, "[auto-dismissed-topic-guard-false-positive]", {
      ...(request.metadata || {}),
      resolvedByUserId: currentUserId,
      autoResolved: true,
      autoRecoverySource: "topic_guard_false_positive_pending_request"
    });

    emitTopicGuardTelemetry(
      {
        source: normalizeText(request.metadata?.source) || "topic_guard_blocked",
        firstTurnGuardBlock: Boolean(request.metadata?.firstTurnGuardBlock),
        sessionId,
        roundId: request.roundId || detail.rounds?.[detail.rounds.length - 1]?.id || null,
        trigger: "session_view",
        activeTopicKey: normalizeTopicKey(request.metadata?.activeTopicKey || request.fieldKey),
        objectiveKeys: Array.isArray(request.metadata?.objectiveKeys) ? request.metadata.objectiveKeys : [],
        derivedReplyTopicKey: normalizeTopicKey(request.metadata?.derivedReplyTopicKey),
        derivedQuestionTopicKey: normalizeTopicKey(request.metadata?.derivedQuestionTopicKey),
        topicInferenceSource: request.metadata?.topicInferenceSource || {},
        rawReply: normalizeText(request.metadata?.rawReply),
        rawOpenQuestions: Array.isArray(request.metadata?.rawOpenQuestions) ? request.metadata.rawOpenQuestions : [],
        isFirstTurn: Boolean(request.metadata?.isFirstTurn),
        isReportPlan: Boolean(request.metadata?.isReportPlan)
      },
      {
        topic_guard_event: "topic_guard_false_positive_recovered",
        false_positive_topic_guard_recovered: true
      }
    );
  }

  updatePrechatSession(sessionId, { status: "paused_review" });
  return true;
}

async function autoRecoverMirrorQuestionFalsePositivePendingRequest(sessionId, currentUserId) {
  const detail = getSessionDetailForUser(sessionId, currentUserId);

  if (!detail || !isRecoverableMirrorQuestionFalsePositivePendingRequest(detail)) {
    return false;
  }

  const pendingRequests = (detail.humanInputRequests || []).filter((request) => request.status === "pending");
  for (const request of pendingRequests) {
    const sourceTurn = resolveMirrorQuestionFalsePositiveSourceTurn(detail, request);
    resolveHumanInputRequest(request.id, "[auto-dismissed-mirror-question-false-positive]", {
      ...(request.metadata || {}),
      resolvedByUserId: currentUserId,
      autoResolved: true,
      resolutionSource: "mirror_quality_false_positive",
      recoveredFromQualityIssue: "mirrored_latest_question",
      autoRecoverySource: "mirror_question_false_positive_pending_request",
      quality_pause_auto_recovered: true,
      quality_pause_source_turn_id: sourceTurn?.id || null,
      quality_pause_recovery_trigger: "mirror_question_false_positive_pending_request"
    });
    writeLlmTelemetry(
      buildQualityTelemetryPayload({
        reply_quality_issue: "mirrored_latest_question",
        rewrite_applied: true,
        rewrite_reason: "mirrored_latest_question",
        rewrite_failed: false,
        quality_pause_false_positive_detected: true,
        quality_pause_auto_recovered: true,
        quality_pause_source_turn_id: sourceTurn?.id || null,
        quality_pause_recovery_trigger: "mirror_question_false_positive_pending_request"
      })
    );
  }

  updatePrechatSession(sessionId, { status: "active" });
  scheduleSessionAutomation(sessionId, currentUserId, "mirror_question_false_positive_pending_request");
  return true;
}

async function autoRecoverDuplicatedRecentQuestionFalsePositivePendingRequest(sessionId, currentUserId) {
  const detail = getSessionDetailForUser(sessionId, currentUserId);

  if (!detail || !isRecoverableDuplicatedRecentQuestionFalsePositivePendingRequest(detail)) {
    return false;
  }

  const pendingRequests = (detail.humanInputRequests || []).filter((request) => request.status === "pending");
  for (const request of pendingRequests) {
    const sourceTurnId = normalizeText(request.metadata?.sourceTurnId) || null;
    resolveHumanInputRequest(request.id, "[auto-dismissed-duplicated-recent-question-false-positive]", {
      ...(request.metadata || {}),
      resolvedByUserId: currentUserId,
      autoResolved: true,
      resolutionSource: "duplicated_recent_question_false_positive",
      recoveredFromQualityIssue: "duplicated_recent_question",
      autoRecoverySource: "duplicated_recent_question_false_positive_pending_request",
      quality_pause_auto_recovered: true,
      quality_pause_source_turn_id: sourceTurnId,
      quality_pause_recovery_trigger: "duplicated_recent_question_false_positive_pending_request"
    });
    writeLlmTelemetry(
      buildQualityTelemetryPayload({
        reply_quality_issue: "duplicated_recent_question",
        rewrite_applied: true,
        rewrite_reason: "duplicated_recent_question",
        rewrite_failed: false,
        quality_pause_false_positive_detected: true,
        quality_pause_auto_recovered: true,
        quality_pause_source_turn_id: sourceTurnId,
        quality_pause_recovery_trigger: "duplicated_recent_question_false_positive_pending_request"
      })
    );
  }

  updatePrechatSession(sessionId, { status: "active" });
  scheduleSessionAutomation(sessionId, currentUserId, "duplicated_recent_question_false_positive_pending_request");
  return true;
}

async function autoResolveGenericQualityPausePendingRequest(sessionId, currentUserId) {
  const detail = getSessionDetailForUser(sessionId, currentUserId);

  if (!detail || !isRecoverableGenericQualityPausePendingRequest(detail)) {
    return false;
  }

  const pendingRequests = (detail.humanInputRequests || []).filter((request) => request.status === "pending");
  for (const request of pendingRequests) {
    const issue = normalizeText(request.metadata?.replyQualityIssue || request.metadata?.qualityGuardReason) || null;
    resolveHumanInputRequest(request.id, "[auto-dismissed-generic-quality-pause]", {
      ...(request.metadata || {}),
      resolvedByUserId: currentUserId,
      autoResolved: true,
      resolutionSource: "generic_quality_pause_silent_retry",
      recoveredFromQualityIssue: issue,
      autoRecoverySource: "generic_quality_pause_pending_request",
      quality_pause_auto_recovered: true,
      quality_pause_recovery_trigger: "generic_quality_pause_pending_request"
    });
    writeLlmTelemetry(
      buildQualityTelemetryPayload({
        reply_quality_issue: issue,
        rewrite_applied: true,
        rewrite_reason: issue ? `${issue}_silent_retry` : "generic_quality_pause_silent_retry",
        rewrite_failed: true,
        quality_pause_false_positive_detected: true,
        quality_pause_auto_recovered: true,
        quality_pause_recovery_trigger: "generic_quality_pause_pending_request"
      })
    );
  }

  updatePrechatSession(sessionId, { status: "active" });
  scheduleSessionAutomation(sessionId, currentUserId, "generic_quality_pause_pending_request");
  return true;
}

async function autoRecoverPausedQuestionSession(sessionId, currentUserId) {
  const detail = getSessionDetailForUser(sessionId, currentUserId);

  if (!detail || !isRecoverablePausedQuestionSession(detail)) {
    return false;
  }

  scheduleSessionAutomation(sessionId, currentUserId, "stuck_unanswered_twin_question");
  return true;
}

async function autoRecoverSemanticMisalignmentSession(sessionId, currentUserId) {
  const detail = getSessionDetailForUser(sessionId, currentUserId);

  if (!detail || !isRecoverableSemanticMisalignmentSession(detail)) {
    return false;
  }

  updatePrechatSession(sessionId, { status: "active" });
  scheduleSessionAutomation(sessionId, currentUserId, "stuck_unanswered_twin_question");
  return true;
}

async function autoStartEligibleSession(sessionId, currentUserId) {
  const detail = getSessionDetailForUser(sessionId, currentUserId);

  if (!detail) {
    return false;
  }

  if (shouldBlockAutomation(detail)) {
    return false;
  }

  scheduleSessionAutomation(detail.session.id, currentUserId, "accept_invitation");
  return true;
}

function describeAutomationFailure(stopReason) {
  switch (normalizeText(stopReason)) {
    case "empty_reply_with_continue":
      return "系统暂停：自动启动 Twin 预沟通时没有生成稳定的首轮消息，请稍后重试或等待下一次恢复。";
    case "invalid_sensitive_question":
      return "系统暂停：自动启动时生成了不完整的敏感问题，当前已停止继续发送。";
    case "invalid_sensitive_category":
      return "系统暂停：自动启动时命中了无法识别的敏感问题类别，当前已停止继续发送。";
    case "manual_pause_active":
      return "系统提示：当前至少一方处于“结束推进”，Twin 自动预沟通已暂停。";
    default:
      return "系统暂停：自动启动 Twin 预沟通时未能生成有效消息，请稍后重试或等待恢复。";
  }
}

function buildAutomationFailureControlPatch(session, trigger, reason) {
  return buildSessionControlPatch(session, {
    automation: {
      startAttempts: getSessionControl(session).automation.startAttempts + 1,
      lastTrigger: trigger,
      lastFailureReason: reason,
      lastFailureAt: new Date().toISOString(),
      deferredRetry: null
    }
  });
}

function buildAutomationSuccessControlPatch(session, trigger) {
  return buildSessionControlPatch(session, {
    automation: {
      startAttempts: getSessionControl(session).automation.startAttempts + 1,
      lastTrigger: trigger,
      lastFailureReason: null,
      lastFailureAt: null,
      lastStartedAt: new Date().toISOString(),
      deferredRetry: null
    }
  });
}

async function handleAutomationStartFailure(sessionId, currentUserId, trigger, reason) {
  const session = getPrechatSessionById(sessionId);

  if (!session) {
    return null;
  }

  const control = getSessionControl(session);
  const shouldWriteSystemTurn =
    !control.automation.lastFailureReason ||
    control.automation.lastFailureReason !== reason ||
    !hasVisibleConversationContent(getSessionDetailForUser(sessionId, currentUserId));

  if (shouldWriteSystemTurn) {
    addAutomationSystemTurn(session, describeAutomationFailure(reason), {
      automationFailure: true,
      reason,
      trigger
    });
  }

  clearDeferredRetryState(sessionId);
  updatePrechatSession(sessionId, {
    status: "paused_review",
    control: buildAutomationFailureControlPatch(session, trigger, reason)
  });

  return getSessionView(sessionId, currentUserId);
}

async function tryStartAutomation(sessionId, actorUserId, trigger, automationIntent = null, retriesRemaining = MAX_AUTO_START_RETRIES) {
  const session = getPrechatSessionById(sessionId);

  if (!session) {
    return { advanced: false, reason: "session_missing" };
  }

  updatePrechatSession(sessionId, {
    control: buildSessionControlPatch(session, {
      automation: {
        lastTrigger: trigger
      }
    })
  });

  const result = await runSessionRound(sessionId, actorUserId, {
    trigger,
    automationIntent,
    skipLock: true
  });
  const postDetail = getSessionDetailForUser(sessionId, actorUserId);
  const hasTurns = hasVisibleConversationContent(postDetail);
  const stopReason = normalizeText(result?.stopReason);
  const invalidStart = !hasTurns && ["empty_reply_with_continue", "invalid_sensitive_question", "invalid_sensitive_category"].includes(stopReason);
  const modelUnstableInvalidStart = !hasTurns && stopReason === "empty_reply_with_continue";
  const deferredRetryEligibleInvalidStart =
    modelUnstableInvalidStart &&
    !isDeferredRetrySuppressedByTrigger(trigger) &&
    true;

  if (invalidStart && !modelUnstableInvalidStart && retriesRemaining > 0) {
    return tryStartAutomation(sessionId, actorUserId, trigger, automationIntent, retriesRemaining - 1);
  }

  if (deferredRetryEligibleInvalidStart) {
    const deferredRetry = buildDeferredRetryState(session, {
      ...buildModelOutputDeferredRetryOptions({
        trigger,
        automationIntent,
        sourceRoundId: result?.metadata?.roundId || null,
        sourceTurnNumber: result?.metadata?.turnNumber || 0
      })
    });

    if (!shouldExhaustDeferredRetry(deferredRetry)) {
      await scheduleDeferredModelRetry({
        sessionId,
        currentUserId: actorUserId,
        trigger,
        automationIntent,
        ...buildModelOutputDeferredRetryOptions({
          trigger,
          automationIntent,
          sourceRoundId: result?.metadata?.roundId || null,
          sourceTurnNumber: result?.metadata?.turnNumber || 0
        })
      });
      return {
        advanced: true,
        result: {
          ...result,
          status: "active",
          stopReason: "deferred_model_retry"
        }
      };
    }

    return {
      advanced: false,
      reason: "auto_start_failed",
      result
    };
  }

  if (invalidStart) {
    return { advanced: false, reason: stopReason || "auto_start_failed", result };
  }

  const finalResult = await autoAdvanceSessionIfNeeded(sessionId, actorUserId, result);
  const liveSession = getPrechatSessionById(sessionId);

  if (liveSession && normalizeText(finalResult?.stopReason) !== "deferred_model_retry") {
    clearDeferredRetryState(sessionId);
    updatePrechatSession(sessionId, {
      control: buildAutomationSuccessControlPatch(liveSession, trigger)
    });
  }

  return { advanced: true, result: finalResult };
}

async function answerManualQuestionIfPossible(sessionId, actorUserId, options = {}) {
  const session = getPrechatSessionById(sessionId);

  if (!session || isManualPauseActive(session)) {
    return getSessionView(sessionId, actorUserId);
  }

  const round = getLatestRoundForSession(sessionId);
  if (!round) {
    return ensureSessionAutomationProgress(sessionId, actorUserId, "manual_message");
  }

  const participants = getSessionParticipantProfiles(session);
  const speaker =
    session.initiatorUserId === actorUserId ? participants.initiator : participants.counterparty;
  const listener =
    session.initiatorUserId === actorUserId ? participants.counterparty : participants.initiator;
  const turnsSoFar = listConversationTurns(session.id);
  const factsSoFar = listExtractedFacts(session.id);
  const objectives = buildObjectives(session, participants.initiator, participants.counterparty, factsSoFar);
  const automationMode = objectives.length ? "objective_driven" : "lightweight_alignment";
  const turnNumber = getLatestTurnNumber(round.id) + 1;

  const turnContext = buildTurnContextV2({
    session,
    round,
    speaker,
    listener,
    objectives,
    turns: turnsSoFar,
    facts: factsSoFar,
    automationMode,
    manualQuestion: {
      enabled: true,
      questionText: options.questionText || options.triggeringTurn?.content || "",
      questionTopic: options.questionTopic || null,
      askedByUserId: options.triggeringTurn?.actorUserId || listener.userId
    }
  });
  const result = await generatePrechatTurn(turnContext);

  const guard = guardTurnResult(result);
  if (!guard.result) {
    return completeRound(session, round, "paused_review", guard.stopReason);
  }

  const repairedResult = repairLoopingReplyV2({
    session,
    result: guard.result,
    speaker,
    listener,
    objectives,
    turns: turnsSoFar
  });
  const safeResult =
    options?.questionTopic && options?.questionTopic !== "unknown" && repairedResult.needs_sensitive_approval
      ? repairedResult
      : applyChineseQualityGuard({
          result: repairedResult,
          speaker,
          listener,
          objectives,
          turns: turnsSoFar,
          session
        });
  const finalizedResult = finalizeTwinTurnResult(
    alignFinalTurnSemantics(safeResult, {
      activeTopicKey: options.questionTopic || null,
      latestListenerQuestionTopic: options.questionTopic || null,
      speakerUserId: speaker.userId,
      listenerUserId: listener.userId
    }),
    speaker,
    turnsSoFar,
    "manual_question_answer",
    {
      turnFrame: turnContext.turn_frame,
      canonicalContext: {
        activeTopicKey: options.questionTopic || null,
        latestListenerQuestionTopic: options.questionTopic || null,
        speakerUserId: speaker.userId,
        listenerUserId: listener.userId
      }
    }
  );

  if (finalizedResult.needs_sensitive_approval || finalizedResult.is_sensitive_question) {
    const targetUserId = resolveTargetUserId(
      finalizedResult.target_user_for_approval,
      speaker.userId,
      listener.userId
    );
    const sensitiveRequest = requestSensitiveTopicApproval({
      session,
      round,
      requestingUserId: speaker.userId,
      targetUserId,
      topicCategory: finalizedResult.sensitive_topic_category || "unknown",
      promptText: finalizedResult.reply,
      promptIntent: "manual_question",
      source: "manual_question_answer",
      turnNumber,
      extraMetadata: {
        triggeringTurnId: options.triggeringTurn?.id || null,
        questionTopic: options.questionTopic || "unknown"
      }
    });

    if (sensitiveRequest.kind === "created" || sensitiveRequest.kind === "already_pending") {
      return completeRound(session, round, "pending_sensitive_approval", "pending_sensitive_approval");
    }

    if (["skipped_by_profile", "already_blocked"].includes(sensitiveRequest.kind)) {
      const resumedSession = sensitiveRequest.session || getPrechatSessionById(session.id) || session;
      const result = await executeConversationLoop({
        session: resumedSession,
        round,
        speakerUserId: speaker.userId,
        startingTurnNumber: turnNumber
      });
      return result;
    }
  }

  if (finalizedResult.needs_human_input.required) {
    const targetUserId = speaker.userId;
    const targetParticipant = speaker;
    const fieldKey = finalizedResult.needs_human_input.field || "manual_question_answer";
    const questionText =
      finalizedResult.needs_human_input.question ||
      buildManualQuestionHumanInputQuestion(
        { human_input_question: null, question_text: options.questionText || "" },
        targetParticipant,
        options.triggeringTurn
      );

    createHumanInputRequest({
      sessionId: session.id,
      roundId: round.id,
      targetUserId,
      fieldKey,
      questionText,
      metadata: {
        source: "manual_question",
        triggeringTurnId: options.triggeringTurn?.id || null,
        questionTopic: options.questionTopic || "unknown",
        classifiedAsQuestion: true,
        classificationPromptVersion: MANUAL_QUESTION_PROMPT_VERSION
      }
    });

    addConversationTurn({
      sessionId: session.id,
      roundId: round.id,
      turnNumber,
      actorUserId: null,
      actorRole: "system",
      content: buildPauseMessage(targetParticipant?.displayName || "对方", fieldKey, questionText),
      metadata: {
        pauseReason: "pending_human_input",
        targetUserId,
        fieldKey,
        source: "manual_question",
        triggeringTurnId: options.triggeringTurn?.id || null
      }
    });

    return completeRound(session, round, "pending_human_input", "pending_human_input");
  }

  const turn = addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber,
    actorUserId: speaker.userId,
    actorRole: `${participantRole(session, speaker.userId)}_twin`,
    content: finalizedResult.reply,
    metadata: persistFinalCanonicalTurnMetadata(
      finalizedResult,
      turnContext.turn_frame,
      {
        activeTopicKey: options.questionTopic || null,
        latestListenerQuestionTopic: options.questionTopic || null,
        speakerUserId: speaker.userId,
        listenerUserId: listener.userId,
        speakerDisplayName: speaker.displayName || ""
      },
      {
        source: "manual_question_answer",
        triggeringTurnId: options.triggeringTurn?.id || null,
        questionTopic: options.questionTopic || "unknown"
      }
    )
  });

  if (finalizedResult.confirmed_facts.length) {
    const persisted = persistAcceptedFacts({
      session,
      round,
      speaker,
      listener,
      facts: finalizedResult.confirmed_facts,
      turns: turnsSoFar,
      sourceTurnId: turn.id,
      telemetrySource: "manual_question_answer"
    });

    if (persisted.needsHumanInputFallback) {
      const deferredRetry = await scheduleSilentModelRetry({
        session,
        currentUserId: actorUserId,
        trigger: "manual_message",
        automationIntent: { intent: "resume_active_round" },
        sourceRoundId: round.id,
        sourceTurnNumber: turnNumber
      });

      if (deferredRetry) {
        return {
          status: "active",
          stopReason: "deferred_model_retry",
          metadata: {
            deferred_retry_scheduled: true,
            deferred_retry_attempt: deferredRetry.attemptCount,
            roundId: round.id,
            turnNumber
          }
        };
      }

      return completeRound(session, round, "paused_review", "deferred_model_retry");
    }
  }

  if (isHighRisk(finalizedResult.risk_flags)) {
    return completeRound(session, round, "blocked_risk", "blocked_risk");
  }

  if (finalizedResult.recommendation === "handoff_ready") {
    return completeRound(session, round, "handoff_ready", "handoff_ready");
  }

  if (finalizedResult.recommendation === "pause_review") {
    return completeRound(session, round, "paused_review", "paused_review");
  }

  return getSessionView(sessionId, actorUserId);
}

async function answerOutstandingTwinQuestion(sessionId, sourceTurnId, actorUserId) {
  const session = getPrechatSessionById(sessionId);

  if (!session || isManualPauseActive(session)) {
    return getSessionView(sessionId, actorUserId);
  }

  const sourceTurn = getConversationTurnById(sourceTurnId);
  if (!sourceTurn || sourceTurn.sessionId !== sessionId || !isTwinQuestionTurn(sourceTurn)) {
    return getSessionView(sessionId, actorUserId);
  }

  const latestRound = getLatestRoundForSession(sessionId);
  const scopedSession = ensureSessionPreferredObjectiveScope(session, latestRound);
  const participants = getSessionParticipantProfiles(scopedSession);
  const preRecoveryDetail = getSessionDetailForUser(sessionId, actorUserId);
  const resolvedManualReviewRecovery = isResolvedManualReviewRecovery(preRecoveryDetail);
  const latestResolvedManualReview = resolvedManualReviewRecovery ? getLatestResolvedManualReview(preRecoveryDetail) : null;
  const recoveryTargetUserId = latestResolvedManualReview?.targetUserId || actorUserId;
  const roundNumber = scopedSession.currentRound + 1;
  const factsSoFar = listExtractedFacts(scopedSession.id);
  const objectives = buildObjectives(scopedSession, participants.initiator, participants.counterparty, factsSoFar);
  const syncedSession = persistSessionTopicLedger(scopedSession, objectives, listConversationTurns(scopedSession.id), factsSoFar, {
    activeTopicKey: inferTopicKeyFromText(sourceTurn.content)
  });
  const automationMode = objectives.length ? "objective_driven" : "lightweight_alignment";
  const round = createPrechatRound({
    sessionId: scopedSession.id,
    roundNumber,
    objective: {
      topics: objectives,
      activeTopicKey: getSessionControl(syncedSession).automation.activeTopicKey,
      topicQueueSnapshot: getSessionControl(syncedSession).automation.topicQueueSnapshot
    }
  });
  const syncedRound = syncRoundObjectiveSnapshot(round, syncedSession, objectives);

  updatePrechatSession(scopedSession.id, { status: "active", currentRound: roundNumber });

  const speaker =
    scopedSession.initiatorUserId === actorUserId ? participants.initiator : participants.counterparty;
  const listener =
    scopedSession.initiatorUserId === actorUserId ? participants.counterparty : participants.initiator;
  const turnsSoFar = listConversationTurns(scopedSession.id);
  const carryoverQuestionText =
    normalizeText(normalizeMessageMetadata(sourceTurn.metadata || {}).canonical_question_text) ||
    normalizeText(normalizeMessageMetadata(sourceTurn.metadata || {}).emitted_question_text) ||
    sourceTurn.content;
  const carryoverQuestionTopic =
    normalizeTopicKey(normalizeMessageMetadata(sourceTurn.metadata || {}).canonical_question_topic_key) ||
    normalizeTopicKey(normalizeMessageMetadata(sourceTurn.metadata || {}).emitted_question_topic_key) ||
    inferTopicKeyFromText(sourceTurn.content);
  const deterministicMirrorRecovery = canDeterministicallyRecoverMirrorQuestionSource(scopedSession, sourceTurn, actorUserId)
    ? buildDeterministicMirrorQuestionRecoveryResult(scopedSession, sourceTurn, speaker, listener)
    : null;

  if (deterministicMirrorRecovery) {
    const guardedDeterministicMirrorRecovery = finalizeTwinTurnResult(
      deterministicMirrorRecovery,
      speaker,
      turnsSoFar,
      "deterministic_mirror_question_recovery",
      {
        canonicalContext: {
          activeTopicKey: carryoverQuestionTopic,
          latestListenerQuestionTopic: carryoverQuestionTopic,
          speakerUserId: speaker.userId,
          listenerUserId: listener.userId
        }
      }
    );
    const turnNumber = 1;
    const duplicateTwinTurn = shouldSkipDuplicateTwinTurn(
      session.id,
      {
        actorUserId: speaker.userId,
        actorRole: `${participantRole(session, speaker.userId)}_twin`,
        content: guardedDeterministicMirrorRecovery.reply,
        metadata: {
          ...guardedDeterministicMirrorRecovery,
          carryoverTwinQuestionAnswered: true,
          carryoverTwinQuestionTurnId: sourceTurn.id
        }
      },
      {
        turns: turnsSoFar,
        trigger: "stuck_unanswered_twin_question",
        reason: "deterministic_mirror_question_recovery"
      }
    );

    if (duplicateTwinTurn?.duplicate && duplicateTwinTurn.existingTurn) {
      return completeRound(session, syncedRound, "paused_review", "paused_review");
    }

    const turn = addConversationTurn({
      sessionId: session.id,
      roundId: syncedRound.id,
      turnNumber,
      actorUserId: speaker.userId,
      actorRole: `${participantRole(session, speaker.userId)}_twin`,
      content: guardedDeterministicMirrorRecovery.reply,
      metadata: persistFinalCanonicalTurnMetadata(
        guardedDeterministicMirrorRecovery,
        {},
        {
          activeTopicKey: carryoverQuestionTopic,
          latestListenerQuestionTopic: carryoverQuestionTopic,
          speakerUserId: speaker.userId,
          listenerUserId: listener.userId,
          speakerDisplayName: speaker.displayName || ""
        },
        {
          carryoverTwinQuestionAnswered: true,
          carryoverTwinQuestionTurnId: sourceTurn.id
        }
      )
    });

    persistAcceptedFacts({
      session,
      round: syncedRound,
      speaker,
      listener,
      facts: guardedDeterministicMirrorRecovery.confirmed_facts,
      turns: turnsSoFar,
      sourceTurnId: turn.id,
      telemetrySource: "deterministic_mirror_question_recovery"
    });

    const sessionAfterCarryoverTurn = advanceTopicLedgerAfterTwinTurn(session, objectives, turn, listExtractedFacts(session.id));
    syncRoundObjectiveSnapshot(syncedRound, sessionAfterCarryoverTurn, objectives);
    const postRecoveryContinuation = derivePostAnswerContinuation({
      session: sessionAfterCarryoverTurn,
      objectives,
      turns: listConversationTurns(session.id),
      speakerUserId: speaker.userId,
      listenerUserId: listener.userId,
      result: {
        ...guardedDeterministicMirrorRecovery,
        carryoverTwinQuestionAnswered: true,
        carryoverTwinQuestionTurnId: sourceTurn.id
      },
      activeTopicKey: getSessionControl(sessionAfterCarryoverTurn).automation.activeTopicKey
    });

    if (postRecoveryContinuation.strategy === "no_op_resolved_outstanding") {
      return completeRound(
        sessionAfterCarryoverTurn,
        syncedRound,
        "paused_review",
        areAllCanonicalTopicsClosed(sessionAfterCarryoverTurn) || !hasUnresolvedTopicBacklog(sessionAfterCarryoverTurn)
          ? "objectives_completed"
          : "paused_review"
      );
    }

    const loopResult = await executeConversationLoop({
      session: getPrechatSessionById(session.id),
      round: syncedRound,
      speakerUserId: listener.userId,
      startingTurnNumber: turnNumber + 1,
      trigger: "stuck_unanswered_twin_question"
    });

    if (loopResult?.stopReason === "outstanding_twin_question_unanswered") {
      const latestOutstandingRecovery = getLatestOutstandingTwinQuestionRecoveryForSession(session.id, actorUserId);
      if (latestOutstandingRecovery?.sourceTurn?.id && latestOutstandingRecovery?.targetUserId) {
        return answerOutstandingTwinQuestion(
          session.id,
          latestOutstandingRecovery.sourceTurn.id,
          latestOutstandingRecovery.targetUserId
        );
      }
      return answerOutstandingTwinQuestion(session.id, sourceTurn.id, sourceTurn.actorUserId);
    }

    return loopResult;
  }

  const carryoverTurnContext = buildTurnContextV2({
    session: getPrechatSessionById(session.id),
    round: syncedRound,
    speaker,
    listener,
    objectives,
    turns: turnsSoFar,
    facts: factsSoFar,
    automationMode,
    activeTopic: carryoverQuestionTopic,
    carryoverTwinQuestion: {
      enabled: true,
      questionText: carryoverQuestionText,
      questionTopic: carryoverQuestionTopic,
      sourceTurnId: sourceTurn.id,
      askedByUserId: sourceTurn.actorUserId
    }
  });
  const result = await generatePrechatTurn(carryoverTurnContext);

  const guard = guardTurnResult(result);
  if (!guard.result) {
    if (
      shouldUseDeferredRetryForGuardFailure(guard.stopReason, result) &&
      !isDeferredRetrySuppressedByTrigger("stuck_unanswered_twin_question")
    ) {
      const deferredRetry = buildDeferredRetryState(session, {
        ...buildModelOutputDeferredRetryOptions({
          trigger: "stuck_unanswered_twin_question",
          automationIntent: { intent: "answer_outstanding_question" },
          sourceRoundId: syncedRound.id,
          sourceTurnNumber: 1
        })
      });

      if (!shouldExhaustDeferredRetry(deferredRetry)) {
        finishPrechatRound(syncedRound.id, { status: "completed", stopReason: "deferred_model_retry" });
        updatePrechatSession(session.id, {
          status: "active",
          control: buildSessionControlPatch(session, {
            automation: {
              lastFailureReason: "model_output_unstable",
              lastFailureAt: nowIso(),
              deferredRetry
            }
          })
        });
        scheduleDeferredAutomationRetry(session.id, actorUserId, deferredRetry);
        return {
          status: "active",
          stopReason: "deferred_model_retry",
          metadata: {
            deferred_retry_scheduled: true,
            deferred_retry_attempt: deferredRetry.attemptCount,
            roundId: syncedRound.id,
            turnNumber: 1
          }
        };
      }
    }

    if (resolvedManualReviewRecovery) {
      return createManualReviewRecoveryPause({
        session,
        round: syncedRound,
        participants,
        targetUserId: recoveryTargetUserId,
        sourceTurnId,
        questionText: "模型输出不可用，需要人工确认。"
      });
    }
    return completeRound(session, syncedRound, "paused_review", guard.stopReason);
  }

  const repairedResult = repairLoopingReplyV2({
    session,
    result: guard.result,
    speaker,
    listener,
    objectives,
    turns: turnsSoFar
  });
  const safeResult = applyChineseQualityGuard({
      result: repairedResult,
      speaker,
      listener,
      objectives,
      turns: turnsSoFar,
      session
    });
  const topicGuardedCarryoverResult = validateTopicAwareTurnResult({
    session: getPrechatSessionById(session.id),
    result: safeResult,
    turns: turnsSoFar,
    activeTopicKey: inferTopicKeyFromText(sourceTurn.content),
    objectives,
    speaker,
    listener,
    roundId: syncedRound.id,
    trigger: "stuck_unanswered_twin_question",
    turnFrame: carryoverTurnContext.turn_frame
  });
  const guardedCarryoverResult = finalizeTwinTurnResult(
    alignFinalTurnSemantics(topicGuardedCarryoverResult, {
      activeTopicKey: carryoverQuestionTopic,
      latestListenerQuestionTopic: getTurnQuestionTopic(sourceTurn),
      speakerUserId: speaker.userId,
      listenerUserId: listener.userId
    }),
    speaker,
    turnsSoFar,
    topicGuardedCarryoverResult?.repair_note === "closed_topic_guard_rewritten"
      ? "closed_topic_guard_rewrite"
      : topicGuardedCarryoverResult?.repair_note === "looping_reply_rewritten"
        ? "loop_rewrite"
      : topicGuardedCarryoverResult?.rewrite_applied
          ? "quality_rewrite"
          : "raw_model_output",
    {
      turnFrame: carryoverTurnContext.turn_frame,
      canonicalContext: {
        activeTopicKey: carryoverQuestionTopic,
        latestListenerQuestionTopic: getTurnQuestionTopic(sourceTurn),
        speakerUserId: speaker.userId,
        listenerUserId: listener.userId
      }
    }
  );
  const turnNumber = 1;

  if (guardedCarryoverResult.needs_sensitive_approval || guardedCarryoverResult.is_sensitive_question) {
    const targetUserId = resolveTargetUserId(
      guardedCarryoverResult.target_user_for_approval,
      speaker.userId,
      listener.userId
    );
    const sensitiveRequest = requestSensitiveTopicApproval({
      session,
      round: syncedRound,
      requestingUserId: speaker.userId,
      targetUserId,
      topicCategory: guardedCarryoverResult.sensitive_topic_category || "unknown",
      promptText: guardedCarryoverResult.reply,
      promptIntent: "carryover_twin_question",
      source: "carryover_twin_question",
      turnNumber,
      extraMetadata: {
        sourceTurnId: sourceTurn.id
      }
    });

    if (sensitiveRequest.kind === "created" || sensitiveRequest.kind === "already_pending") {
      return completeRound(session, syncedRound, "pending_sensitive_approval", "pending_sensitive_approval");
    }

    if (["skipped_by_profile", "already_blocked"].includes(sensitiveRequest.kind)) {
      if (resolvedManualReviewRecovery) {
        return ensureSessionAutomationProgress(session.id, actorUserId, "stuck_unanswered_twin_question");
      }
      return ensureSessionAutomationProgress(session.id, actorUserId, "stuck_unanswered_twin_question");
    }
  }

  if (guardedCarryoverResult.needs_human_input.required) {
    if (
      shouldUseDeferredRetryForTurnResult(guardedCarryoverResult) &&
      !isDeferredRetrySuppressedByTrigger("stuck_unanswered_twin_question")
    ) {
      const deferredRetry = buildDeferredRetryState(session, {
        ...buildModelOutputDeferredRetryOptions({
          trigger: "stuck_unanswered_twin_question",
          automationIntent: { intent: "answer_outstanding_question" },
          sourceRoundId: syncedRound.id,
          sourceTurnNumber: turnNumber
        })
      });

      if (!shouldExhaustDeferredRetry(deferredRetry)) {
        finishPrechatRound(syncedRound.id, { status: "completed", stopReason: "deferred_model_retry" });
        updatePrechatSession(session.id, {
          status: "active",
          control: buildSessionControlPatch(session, {
            automation: {
              lastFailureReason: "model_output_unstable",
              lastFailureAt: nowIso(),
              deferredRetry
            }
          })
        });
        scheduleDeferredAutomationRetry(session.id, actorUserId, deferredRetry);
        return {
          status: "active",
          stopReason: "deferred_model_retry",
          metadata: {
            deferred_retry_scheduled: true,
            deferred_retry_attempt: deferredRetry.attemptCount,
            roundId: syncedRound.id,
            turnNumber
          }
        };
      }
    }

    const targetUserId = resolveTargetUserId(
      guardedCarryoverResult.needs_human_input.target_user_for_input,
      speaker.userId,
      listener.userId
    );
    const targetParticipant =
      targetUserId === participants.initiator.userId ? participants.initiator : participants.counterparty;
    const fieldKey = guardedCarryoverResult.needs_human_input.field || "manual_review";
    const questionText = guardedCarryoverResult.needs_human_input.question || "请人工补充这一项信息。";
    const qualityPauseMetadata =
      normalizeText(guardedCarryoverResult.reply_quality_issue) || normalizeText(guardedCarryoverResult.quality_guard_reason)
        ? buildQualityPauseMetadata({
            result: guardedCarryoverResult,
            source: "quality_guard",
            sourceTurnId: sourceTurn.id,
            turnNumber,
            activeTopicKey: inferTopicKeyFromText(sourceTurn.content)
          })
        : null;

    createHumanInputRequest({
      sessionId: session.id,
      roundId: syncedRound.id,
      targetUserId,
      fieldKey,
      questionText,
      metadata: {
        turnNumber,
        source: "carryover_twin_question",
        sourceTurnId: sourceTurn.id,
        ...(qualityPauseMetadata || {})
      }
    });

    addConversationTurn({
      sessionId: session.id,
      roundId: syncedRound.id,
      turnNumber,
      actorUserId: null,
      actorRole: "system",
      content: buildPauseMessage(targetParticipant?.displayName || "对方", fieldKey, questionText),
      metadata: {
        pauseReason: "pending_human_input",
        targetUserId,
        fieldKey,
        source: "carryover_twin_question",
        sourceTurnId: sourceTurn.id,
        ...(qualityPauseMetadata || {})
      }
    });

    return completeRound(session, syncedRound, "pending_human_input", "pending_human_input");
  }

  const duplicateTwinTurn = shouldSkipDuplicateTwinTurn(
    session.id,
    {
      actorUserId: speaker.userId,
      actorRole: `${participantRole(session, speaker.userId)}_twin`,
      content: guardedCarryoverResult.reply,
      metadata: {
        ...guardedCarryoverResult,
        carryoverTwinQuestionAnswered: true,
        carryoverTwinQuestionTurnId: sourceTurn.id
      }
    },
    {
      turns: turnsSoFar,
      trigger: "stuck_unanswered_twin_question",
      reason: "identical_carryover_recovery_turn"
    }
  );

  if (duplicateTwinTurn?.duplicate && duplicateTwinTurn.existingTurn) {
    return completeRound(session, syncedRound, "paused_review", "paused_review");
  }

  const turn = addConversationTurn({
    sessionId: session.id,
    roundId: syncedRound.id,
    turnNumber,
    actorUserId: speaker.userId,
    actorRole: `${participantRole(session, speaker.userId)}_twin`,
    content: guardedCarryoverResult.reply,
    metadata: persistFinalCanonicalTurnMetadata(
      guardedCarryoverResult,
      carryoverTurnContext.turn_frame,
      {
        activeTopicKey: carryoverQuestionTopic,
        latestListenerQuestionTopic: getTurnQuestionTopic(sourceTurn),
        speakerUserId: speaker.userId,
        listenerUserId: listener.userId,
        speakerDisplayName: speaker.displayName || ""
      },
      {
        carryoverTwinQuestionAnswered: true,
        carryoverTwinQuestionTurnId: sourceTurn.id
      }
    )
  });

  if (guardedCarryoverResult.confirmed_facts.length) {
    const persisted = persistAcceptedFacts({
      session,
      round: syncedRound,
      speaker,
      listener,
      facts: guardedCarryoverResult.confirmed_facts,
      turns: turnsSoFar,
      sourceTurnId: turn.id,
      telemetrySource: "carryover_twin_question"
    });

    if (persisted.needsHumanInputFallback) {
      const deferredRetry = await scheduleSilentModelRetry({
        session,
        currentUserId: actorUserId,
        trigger: "stuck_unanswered_twin_question",
        automationIntent: { intent: "answer_outstanding_question" },
        sourceRoundId: syncedRound.id,
        sourceTurnNumber: turnNumber
      });

      if (deferredRetry) {
        finishPrechatRound(syncedRound.id, { status: "completed", stopReason: "deferred_model_retry" });
        return {
          status: "active",
          stopReason: "deferred_model_retry",
          metadata: {
            deferred_retry_scheduled: true,
            deferred_retry_attempt: deferredRetry.attemptCount,
            roundId: syncedRound.id,
            turnNumber
          }
        };
      }

      return completeRound(session, syncedRound, "paused_review", "deferred_model_retry");
    }
  }

  if (isHighRisk(guardedCarryoverResult.risk_flags)) {
    return completeRound(session, syncedRound, "blocked_risk", "blocked_risk");
  }

  const sessionAfterCarryoverTurn = advanceTopicLedgerAfterTwinTurn(session, objectives, turn, listExtractedFacts(session.id));
  syncRoundObjectiveSnapshot(syncedRound, sessionAfterCarryoverTurn, objectives);
  const postCarryoverContinuation = derivePostAnswerContinuation({
    session: sessionAfterCarryoverTurn,
    objectives,
    turns: listConversationTurns(session.id),
    speakerUserId: speaker.userId,
    listenerUserId: listener.userId,
    result: {
      ...guardedCarryoverResult,
      carryoverTwinQuestionAnswered: true,
      carryoverTwinQuestionTurnId: sourceTurn.id
    },
    activeTopicKey: getSessionControl(sessionAfterCarryoverTurn).automation.activeTopicKey
  });

  if (postCarryoverContinuation.strategy === "no_op_resolved_outstanding") {
    return completeRound(
      sessionAfterCarryoverTurn,
      syncedRound,
      "paused_review",
      areAllCanonicalTopicsClosed(sessionAfterCarryoverTurn) || !hasUnresolvedTopicBacklog(sessionAfterCarryoverTurn)
        ? "objectives_completed"
        : "paused_review"
    );
  }

  if (guardedCarryoverResult.recommendation === "handoff_ready") {
    return completeRound(sessionAfterCarryoverTurn, syncedRound, "handoff_ready", "handoff_ready");
  }

  if (guardedCarryoverResult.recommendation === "pause_review") {
    return completeRound(sessionAfterCarryoverTurn, syncedRound, "paused_review", "paused_review");
  }

  const loopResult = await executeConversationLoop({
    session: getPrechatSessionById(session.id),
    round: syncedRound,
    speakerUserId: listener.userId,
    startingTurnNumber: turnNumber + 1
  });

  if (loopResult?.stopReason === "outstanding_twin_question_unanswered") {
    const recoveredDetail = getSessionDetailForUser(sessionId, actorUserId);

    if (isResolvedManualReviewRecovery(recoveredDetail)) {
      return createManualReviewRecoveryPause({
        session,
        round: syncedRound,
        participants,
        targetUserId: recoveryTargetUserId,
        sourceTurnId,
        questionText: "上一轮人工补充后，系统仍缺少足够信息继续回答，请本人再补充这一项。"
      });
    }
  }

  return loopResult;
}

async function classifyAndHandleManualQuestion(sessionId, currentUserId, manualTurn) {
  const session = getPrechatSessionById(sessionId);

  if (!session || isManualPauseActive(session)) {
    return null;
  }

  const round = getLatestRoundForSession(sessionId);
  if (!round) {
    return null;
  }

  const participants = getSessionParticipantProfiles(session);
  const manualSenderUserId = manualTurn?.actorUserId || currentUserId;
  const sender =
    session.initiatorUserId === manualSenderUserId ? participants.initiator : participants.counterparty;
  const receiver =
    session.initiatorUserId === manualSenderUserId ? participants.counterparty : participants.initiator;
  const turns = listConversationTurns(sessionId);
  const facts = listExtractedFacts(sessionId);
  const classification = await classifyManualQuestion(
    buildManualQuestionClassificationContext({
      session,
      sender,
      receiver,
      manualTurn,
      turns,
      facts
    })
  );

  writeLlmTelemetry({
    adapter_name: "VllmOpenAIAdapter",
    provider: "vllm_openai",
    endpoint: "manual_question_router",
    model: null,
    request_type: "manual_question_routing",
    prompt_version: MANUAL_QUESTION_PROMPT_VERSION,
    started_at: new Date().toISOString(),
    duration_ms: 0,
    attempt_count: 1,
    used_repair: false,
    used_fallback: false,
    success: true,
    error_type: null,
    manual_question_triggered: true,
    is_question: classification.is_question,
    can_answer_from_context: classification.can_answer_from_context,
    classified_topic: classification.question_topic || null,
    classification_result: classification.is_question
      ? classification.can_answer_from_context
        ? "answerable"
        : classification.needs_sensitive_approval
          ? "needs_sensitive_approval"
          : "needs_human_input"
      : "not_question"
  });

  if (!classification.is_question) {
    return null;
  }

  if (classification.needs_sensitive_approval) {
    const targetUserId = receiver.userId;
    const sensitiveRequest = requestSensitiveTopicApproval({
      session,
      round,
      requestingUserId: sender.userId,
      targetUserId,
      topicCategory: classification.sensitive_topic_category || "unknown",
      promptText: classification.question_text || manualTurn.content,
      promptIntent: "manual_question",
      source: "manual_question_classification",
      turnNumber: getLatestTurnNumber(round.id) + 1,
      extraMetadata: {
        triggeringTurnId: manualTurn.id,
        classificationQuestionTopic: classification.question_topic || "unknown"
      }
    });

    if (sensitiveRequest.kind === "created" || sensitiveRequest.kind === "already_pending") {
      const result = await completeRound(session, round, "pending_sensitive_approval", "pending_sensitive_approval");
      return { session: getSessionView(sessionId, currentUserId), result };
    }

    if (["skipped_by_profile", "already_blocked"].includes(sensitiveRequest.kind)) {
      const result = await completeRound(session, round, "paused_review", "sensitive_topic_skipped");
      return { session: getSessionView(sessionId, currentUserId), result };
    }
  }

  if (classification.needs_human_input || !classification.can_answer_from_context) {
    createPendingHumanInputFromManualQuestion({
      session,
      round,
      targetUserId: receiver.userId,
      targetParticipant: receiver,
      turnNumber: getLatestTurnNumber(round.id) + 1,
      questionText: buildManualQuestionHumanInputQuestion(classification, receiver, manualTurn),
      triggeringTurn: manualTurn,
      classification
    });

    const result = await completeRound(session, round, "pending_human_input", "pending_human_input");
    return { session: getSessionView(sessionId, currentUserId), result };
  }

  const result = await answerManualQuestionIfPossible(sessionId, receiver.userId, {
    triggeringTurn: manualTurn,
    questionText: classification.question_text || manualTurn.content,
    questionTopic: classification.question_topic || inferTopicKeyFromText(classification.question_text || manualTurn.content)
  });

  return { session: getSessionView(sessionId, currentUserId), result };
}

async function processPendingManualMessageIfNeeded(sessionId, currentUserId) {
  const manualTurn = findPendingManualMessageTurn(sessionId);

  if (!manualTurn) {
    return { handled: false, result: null };
  }

  const handled = await classifyAndHandleManualQuestion(sessionId, currentUserId, manualTurn);
  markManualMessageTurnProcessed(manualTurn.id, {
    classifiedAsQuestion: Boolean(handled?.result),
    routingHandled: Boolean(handled)
  });
  return { handled: true, result: handled?.result || null };
}

async function resumeApprovedSensitiveTopicRequest(request, currentUserId) {
  const session = getPrechatSessionById(request.sessionId);

  if (!session) {
    return getSessionView(request.sessionId, currentUserId);
  }

  const participants = getSessionParticipantProfiles(session);
  const factsSoFar = listExtractedFacts(session.id);
  const turnsSoFar = listConversationTurns(session.id);
  const sensitiveObjectiveKey = getSensitiveObjectiveKey(request.topicCategory);
  const sensitiveObjective =
    sensitiveObjectiveKey
      ? TOPIC_CONFIG.find((item) => item.key === sensitiveObjectiveKey) || {
          key: sensitiveObjectiveKey,
          label: getTopicLabel(sensitiveObjectiveKey),
          prompt: ""
        }
      : null;
  let objectives = buildObjectives(session, participants.initiator, participants.counterparty, factsSoFar);

  if (sensitiveObjective && !objectives.some((item) => item.key === sensitiveObjective.key)) {
    objectives = [sensitiveObjective, ...objectives].slice(0, Math.max(MAX_OBJECTIVES, 1));
  }

  const preparedSession = sensitiveObjectiveKey
    ? persistSessionTopicLedger(session, objectives, turnsSoFar, factsSoFar, {
        activeTopicKey: sensitiveObjectiveKey
      })
    : session;
  const liveSession = getPrechatSessionById(preparedSession.id) || preparedSession;
  const nextRoundNumber = liveSession.currentRound + 1;
  const nextTopicQueue = sensitiveObjectiveKey
    ? [
        sensitiveObjectiveKey,
        ...getSessionControl(liveSession).automation.topicQueueSnapshot.filter(
          (item) => normalizeTopicKey(item) !== sensitiveObjectiveKey
        )
      ]
    : getSessionControl(liveSession).automation.topicQueueSnapshot;
  const round = createPrechatRound({
    sessionId: liveSession.id,
    roundNumber: nextRoundNumber,
    objective: {
      topics: objectives,
      activeTopicKey: sensitiveObjectiveKey || getSessionControl(liveSession).automation.activeTopicKey,
      topicQueueSnapshot: nextTopicQueue
    }
  });
  const syncedRound = syncRoundObjectiveSnapshot(round, liveSession, objectives);

  updatePrechatSession(liveSession.id, {
    status: "active",
    currentRound: nextRoundNumber,
    control: buildSessionControlPatch(liveSession, {
      automation: {
        activeTopicKey: sensitiveObjectiveKey || getSessionControl(liveSession).automation.activeTopicKey,
        topicQueueSnapshot: nextTopicQueue
      }
    })
  });

  const sessionAfterRoundStart = getPrechatSessionById(liveSession.id) || liveSession;
  const regeneratedQuestion =
    (sensitiveObjectiveKey
      ? buildObjectiveQuestionV2(
          TOPIC_CONFIG.find((item) => item.key === sensitiveObjectiveKey) || { key: sensitiveObjectiveKey }
        )
      : null) ||
    normalizeText(request.metadata?.lastPromptText) ||
    normalizeText(request.questionText);
  const regeneratedQuestionTopic =
    normalizeTopicKey(sensitiveObjectiveKey) ||
    inferQuestionTopicFromQuestionText(regeneratedQuestion) ||
    inferTopicKeyFromText(regeneratedQuestion);

  if (!normalizeText(regeneratedQuestion)) {
    return completeRound(sessionAfterRoundStart, syncedRound, "paused_review", "paused_review");
  }

  const regeneratedTurnFrame = {
    frame_version: TURN_FRAME_VERSION,
    reply_obligation: "none",
    reply_target: {
      text: null,
      topicKey: null,
      askedByUserId: null,
      sourceTurnId: null
    },
    topic_plan: {
      activeTopicKey: regeneratedQuestionTopic || null,
      activeTopicState: null,
      canSwitchOnlyAfterClose: true,
      nextCandidateTopicKey: null,
      closedTopicKeys: [],
      forbiddenTopicKeys: []
    }
  };
  const regeneratedMetadata = persistFinalCanonicalTurnMetadata(
    {
      reply: regeneratedQuestion,
      reply_topic_key: null,
      question_topic_key: regeneratedQuestionTopic || null,
      is_sensitive_question: false,
      sensitive_topic_category: request.topicCategory,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: [regeneratedQuestion],
      risk_flags: [],
      needs_human_input: {
        required: false,
        field: null,
        question: null,
        target_user_for_input: null
      },
      recommendation: "continue",
      emitted_reply_topic_key: null,
      emitted_question_topic_key: regeneratedQuestionTopic || null,
      emitted_question_text: regeneratedQuestion,
      approvalKind: "topic",
      regeneratedFromApprovedSensitiveTopic: true,
      sourceSensitiveRequestId: request.id
    },
    regeneratedTurnFrame,
    {
      activeTopicKey: regeneratedQuestionTopic || null,
      latestListenerQuestionTopic: null,
      speakerUserId: request.requestingUserId,
      listenerUserId: request.targetUserId
    },
    {
      round_scope_mirror_synced: true
    }
  );

  const regeneratedQuestionTurn = addConversationTurn({
    sessionId: sessionAfterRoundStart.id,
    roundId: syncedRound.id,
    turnNumber: 1,
    actorUserId: request.requestingUserId,
    actorRole: `${participantRole(sessionAfterRoundStart, request.requestingUserId)}_twin`,
    content: regeneratedQuestion,
    metadata: regeneratedMetadata
  });

  const sessionAfterQuestion = advanceTopicLedgerAfterTwinTurn(
    sessionAfterRoundStart,
    objectives,
    regeneratedQuestionTurn,
    listExtractedFacts(sessionAfterRoundStart.id)
  );
  syncRoundObjectiveSnapshot(syncedRound, sessionAfterQuestion, objectives);

  return executeConversationLoop({
    session: sessionAfterQuestion,
    round: syncedRound,
    speakerUserId: request.targetUserId,
    startingTurnNumber: 2
  });
}

async function processApprovedSensitiveRequestsIfNeeded(sessionId, currentUserId) {
  const detail = getSessionDetailForUser(sessionId, currentUserId);
  const request =
    (detail?.sensitiveRequests || []).find(
      (item) => item.status === "approved" && !item.metadata?.resumedByAutomation
    ) || null;

  if (!request) {
    return { handled: false, result: null, resumeTrigger: null };
  }

  const session = getPrechatSessionById(request.sessionId);
  if (!session) {
    return { handled: false, result: null, resumeTrigger: null };
  }

  updateSensitiveQuestionRequest(request.id, {
    status: "approved",
    resolvedAt: request.resolvedAt,
    metadata: {
      ...(request.metadata || {}),
      resumedByAutomation: true
    }
  });
  updatePrechatSession(session.id, { status: "active" });
  const result = await resumeApprovedSensitiveTopicRequest(request, currentUserId);
  return { handled: true, result, resumeTrigger: null };
}

async function ensureSessionAutomationProgress(sessionId, currentUserId, trigger) {
  return withSessionAutomationLock(sessionId, async () => {
    reconcileSessionStatusFromLatestRound(sessionId, currentUserId);
    let detail = getSessionDetailForUser(sessionId, currentUserId);

    if (!detail || shouldBlockAutomation(detail)) {
      if (detail?.session) {
        clearDeferredRetryState(detail.session.id);
      }
      return getSessionView(sessionId, currentUserId);
    }

    if (!isManualPauseActive(detail.session) && hasPendingManualMessageTurn(sessionId)) {
      const processed = await processPendingManualMessageIfNeeded(sessionId, currentUserId);
      if (processed.handled) {
        const postDetail = getSessionDetailForUser(sessionId, currentUserId);
        if (!postDetail || shouldBlockAutomation(postDetail)) {
          return getSessionView(sessionId, currentUserId);
        }
        if (["pending_human_input", "pending_sensitive_approval"].includes(postDetail.session.status)) {
          return getSessionView(sessionId, currentUserId);
        }
      }
    }

    const approvedSensitive = await processApprovedSensitiveRequestsIfNeeded(sessionId, currentUserId);
    if (approvedSensitive.resumeTrigger) {
      detail = getSessionDetailForUser(sessionId, currentUserId);
      trigger = approvedSensitive.resumeTrigger;
      if (!detail || shouldBlockAutomation(detail)) {
        return getSessionView(sessionId, currentUserId);
      }
    } else if (approvedSensitive.handled) {
      return getSessionView(sessionId, currentUserId);
    }

    const automationIntent = deriveAutomationIntent(detail, trigger);
    if (automationIntent.intent === "answer_outstanding_question" && automationIntent.outstandingRecovery) {
      const result = await answerOutstandingTwinQuestion(
        sessionId,
        automationIntent.outstandingRecovery.sourceTurn.id,
        automationIntent.outstandingRecovery.targetUserId
      );
      const liveSession = getPrechatSessionById(sessionId);
      if (liveSession && normalizeText(result?.stopReason) !== "deferred_model_retry") {
        clearDeferredRetryState(sessionId);
        updatePrechatSession(sessionId, {
          control: buildAutomationSuccessControlPatch(liveSession, trigger)
        });
      }
      return result;
    }

    if (automationIntent.intent === "no_op") {
      return getSessionView(sessionId, currentUserId);
    }

    const actorUserId = detail.session.initiatorUserId;
    const start = await tryStartAutomation(
      sessionId,
      actorUserId,
      trigger,
      automationIntent
    );

    if (!start.advanced) {
      return handleAutomationStartFailure(sessionId, currentUserId, trigger, start.reason || "auto_start_failed");
    }

    if (normalizeText(start.result?.stopReason) !== "deferred_model_retry") {
      clearDeferredRetryState(sessionId);
    }
    return getSessionView(sessionId, currentUserId);
  });
}

async function buildRoundSummaryPayload(session, round, stopReason) {
  const turns = listConversationTurns(session.id).filter((turn) => turn.roundId === round.id);
  const facts = listExtractedFacts(session.id).filter((fact) => fact.roundId === round.id);
  const syncedSession = persistSessionTopicLedger(session, Array.isArray(round.objective?.topics) ? round.objective.topics : [], turns, facts);
  const objectiveProgress = buildObjectiveProgress(
    syncedSession,
    Array.isArray(round.objective?.topics) ? round.objective.topics : [],
    facts
  );
  const stageContext = buildStageContext({ session: syncedSession, round, turns, facts, stopReason });
  const stageSummary = await summarizeStage(stageContext);
  const fallbackPayload = buildCanonicalStageSummaryPayload({
    ...stageSummary,
    next_action: stageSummary?.next_action || "continue",
    handoff_ready: Boolean(stageSummary?.handoff_ready)
  }, stageContext.counterparty_summary_frame);
  const canonicalUnresolvedQuestions = Array.isArray(fallbackPayload.unresolved_questions)
    ? fallbackPayload.unresolved_questions
    : [];
  const renderedPayload =
    normalizeText(stageSummary?.summary) && stageSummary.summary !== "模型总结不可用，需要人工确认。"
      ? {
          ...fallbackPayload,
          ...stageSummary,
          summary_by_role: fallbackPayload.summary_by_role,
          unresolved_questions: canonicalUnresolvedQuestions,
          summary:
            normalizeText(stageSummary?.summary_by_role?.initiator) ||
            normalizeText(stageSummary?.summary) ||
            fallbackPayload.summary
        }
      : fallbackPayload;
  const payload = sanitizeStageReportPayloadForPersistence(renderedPayload);
  return {
    ...payload,
    objective_progress: objectiveProgress,
    all_objectives_confirmed: allObjectivesConfirmed(objectiveProgress, {
      activeTopicKey: getScopedActiveTopicKey(
        syncedSession,
        round,
        Array.isArray(round.objective?.topics) ? round.objective.topics : []
      ),
      hasOutstandingTwinQuestion: Boolean(detectOutstandingTwinQuestion(syncedSession, turns, round)),
      scopedObjectiveKeys: getEffectiveScopedObjectiveKeys(
        syncedSession,
        round,
        Array.isArray(round.objective?.topics) ? round.objective.topics : []
      )
    })
  };
}

async function createRoundSummary(session, round, stopReason) {
  const payload = await buildRoundSummaryPayload(session, round, stopReason);
  return createStageReport(session.id, round.id, payload);
}

export async function regenerateStageSummary(sessionId, options = {}) {
  const session = getPrechatSessionById(sessionId);

  if (!session) {
    throw new Error("未找到该预沟通会话。");
  }

  const rounds = listPrechatRounds(session.id);
  const round =
    normalizeText(options.roundId)
      ? rounds.find((item) => item.id === normalizeText(options.roundId))
      : rounds[rounds.length - 1];

  if (!round) {
    throw new Error("该预沟通会话还没有可重算总结的轮次。");
  }

  const payload = await buildRoundSummaryPayload(session, round, normalizeText(options.stopReason) || round.stopReason);
  const stageReports = listStageReports(session.id);
  const existingReport = stageReports.find((report) => report.roundId === round.id);
  const persisted = existingReport
    ? updateStageReport(existingReport.id, payload)
    : createStageReport(session.id, round.id, payload);

  return {
    sessionId: session.id,
    roundId: round.id,
    reportId: persisted.id,
    replacedExisting: Boolean(existingReport),
    payload
  };
}

async function completeRound(session, round, status, stopReason) {
  finishPrechatRound(round.id, { status: "completed", stopReason });
  const liveSessionAfterFinish = getPrechatSessionById(session.id) || session;
  const nextPatch = { status };

  if (status === "paused_review" && stopReason === "objectives_completed") {
    const completedRound = getPrechatRound(round.id) || { ...round, stopReason, status: "completed" };
    nextPatch.control = buildObjectivesCompletedReviewInboxPatch(
      liveSessionAfterFinish,
      completedRound,
      completedRound.updatedAt || liveSessionAfterFinish.updatedAt || nowIso()
    );
  } else if (
    status === "paused_review" &&
    ["outstanding_twin_question_unanswered", "paused_review", "max_turns_reached"].includes(normalizeText(stopReason))
  ) {
    const completedRound = getPrechatRound(round.id) || { ...round, stopReason, status: "completed" };
    nextPatch.control = buildPauseNoticeReviewInboxPatch(
      liveSessionAfterFinish,
      completedRound,
      completedRound.updatedAt || liveSessionAfterFinish.updatedAt || nowIso()
    );
  }

  updatePrechatSession(session.id, nextPatch);
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

  if (!session || isManualPauseActive(session) || !isAutomationEnabledForSession(session)) {
    return result;
  }

  if (!["active", "paused_review"].includes(session.status)) {
    return result;
  }

  const nextResult = await runSessionRound(sessionId, actorUserId, { skipLock: true });
  return autoAdvanceSessionIfNeeded(sessionId, actorUserId, nextResult, depth + 1);
}

async function executeConversationLoop({ session, round, speakerUserId, startingTurnNumber, trigger = null, automationIntent = null }) {
  if (isManualPauseActive(session)) {
    return { status: session.status, stopReason: "manual_pause_active" };
  }

  let liveSession = getPrechatSessionById(session.id) || session;
  liveSession = ensureSessionPreferredObjectiveScope(liveSession, round);
  const participants = getSessionParticipantProfiles(liveSession);
  const objectives = buildObjectives(
    liveSession,
    participants.initiator,
    participants.counterparty,
    listExtractedFacts(liveSession.id)
  );
  liveSession = persistSessionTopicLedger(liveSession, objectives);
  let liveRound = syncRoundObjectiveSnapshot(round, liveSession, objectives);
  const automationMode = objectives.length ? "objective_driven" : "lightweight_alignment";
  let currentSpeakerId = speakerUserId;
  let nextTurnNumber = startingTurnNumber;
  let usedOutstandingQuestionOverflowTurn = startingTurnNumber > MAX_TURNS_PER_ROUND;
  let noProgressTurns = 0;
  let lastProgressSnapshot = buildRoundProgressSnapshot(
    liveSession,
    objectives,
    listConversationTurns(liveSession.id),
    liveRound
  );

  while (nextTurnNumber <= MAX_TURNS_PER_ROUND + (usedOutstandingQuestionOverflowTurn ? 0 : 1)) {
    const liveSessionBeforeTurn = getPrechatSessionById(liveSession.id);

    if (!liveSessionBeforeTurn || isManualPauseActive(liveSessionBeforeTurn)) {
      return {
        status: liveSessionBeforeTurn?.status || liveSession.status,
        stopReason: "manual_pause_active"
      };
    }

    liveSession = persistSessionTopicLedger(liveSessionBeforeTurn, objectives);
    const activeTopicKey = getSessionControl(liveSession).automation.activeTopicKey;
    const activeTopicEntry = activeTopicKey
      ? getTopicEntry(getSessionControl(liveSession).automation.topicLedger, activeTopicKey)
      : null;
    if (activeTopicEntry?.pendingAnswerUserId) {
      currentSpeakerId = activeTopicEntry.pendingAnswerUserId;
    }

    const speaker =
      liveSession.initiatorUserId === currentSpeakerId ? participants.initiator : participants.counterparty;
    const listener =
      liveSession.initiatorUserId === currentSpeakerId ? participants.counterparty : participants.initiator;
    const turnsSoFar = listConversationTurns(liveSession.id);
    const factsSoFar = listExtractedFacts(liveSession.id);
    const openingBootstrapMode =
      !hasAnyTwinTurn(liveSession, turnsSoFar) &&
      (
        normalizeText(automationIntent?.intent) === "bootstrap_opening" ||
        startingTurnNumber === 1
      );
    const deferredRetrySourceIntent = openingBootstrapMode ? "bootstrap_opening" : "resume_active_round";

    const turnContext = buildTurnContextV2({
      session: liveSession,
      round: liveRound,
      speaker,
      listener,
      objectives,
      turns: turnsSoFar,
      facts: factsSoFar,
      automationMode,
      activeTopic: activeTopicKey
    });
    const result = await generatePrechatTurn(turnContext);

    const guard = guardTurnResult(result);

    if (!guard.result) {
      if (shouldUseDeferredRetryForGuardFailure(guard.stopReason, result) && !isDeferredRetrySuppressedByTrigger(trigger)) {
        const deferredRetry = buildDeferredRetryState(liveSession, {
          ...buildModelOutputDeferredRetryOptions({
            trigger:
              normalizeText(trigger) ||
              normalizeText(getSessionControl(liveSession).automation.activeTrigger) ||
              normalizeText(getSessionControl(liveSession).automation.lastTrigger) ||
              "conversation_loop",
            automationIntent: { intent: deferredRetrySourceIntent },
            sourceRoundId: liveRound.id,
            sourceTurnNumber: nextTurnNumber
          })
        });

        if (!shouldExhaustDeferredRetry(deferredRetry)) {
          finishPrechatRound(liveRound.id, { status: "completed", stopReason: "deferred_model_retry" });
          updatePrechatSession(liveSession.id, {
            status: "active",
            control: buildSessionControlPatch(liveSession, {
              automation: {
                lastFailureReason: "model_output_unstable",
                lastFailureAt: nowIso(),
                deferredRetry
              }
            })
          });
          scheduleDeferredAutomationRetry(liveSession.id, speaker.userId, deferredRetry);
          return {
            status: "active",
            stopReason: "deferred_model_retry",
            metadata: {
              deferred_retry_scheduled: true,
              deferred_retry_attempt: deferredRetry.attemptCount,
              roundId: liveRound.id,
              turnNumber: nextTurnNumber
            }
          };
        }
      }
      return completeRound(liveSession, liveRound, "paused_review", guard.stopReason);
    }

    const repairedResult = repairLoopingReplyV2({
      session: liveSession,
      result: guard.result,
      speaker,
      listener,
      objectives,
      turns: turnsSoFar
    });

    const liveSessionAfterGeneration = getPrechatSessionById(session.id);

    if (!liveSessionAfterGeneration || isManualPauseActive(liveSessionAfterGeneration)) {
      return {
        status: liveSessionAfterGeneration?.status || liveSession.status,
        stopReason: "manual_pause_active"
      };
    }

  const qualitySafeResult = applyChineseQualityGuard({
      result: repairedResult,
      speaker,
      listener,
      objectives,
      turns: turnsSoFar,
      session: liveSession
    });
    const topicSafeResult = validateTopicAwareTurnResult({
      session: liveSessionAfterGeneration,
      result: qualitySafeResult,
      turns: turnsSoFar,
      activeTopicKey,
      objectives,
      speaker,
      listener,
      roundId: liveRound.id,
      trigger: getSessionControl(liveSessionAfterGeneration).automation.activeTrigger || getSessionControl(liveSessionAfterGeneration).automation.lastTrigger || "conversation_loop",
      turnFrame: turnContext.turn_frame
    });
    const alignedTopicSafeResult = alignFinalTurnSemantics(topicSafeResult, {
      activeTopicKey,
      latestListenerQuestionTopic:
        turnsSoFar.length && turnsSoFar[turnsSoFar.length - 1]?.actorUserId === listener.userId
          ? getTurnQuestionTopic(turnsSoFar[turnsSoFar.length - 1])
          : null,
      speakerUserId: speaker.userId,
      listenerUserId: listener.userId
    });
    const safeResult = finalizeTwinTurnResult(alignedTopicSafeResult, speaker, turnsSoFar, alignedTopicSafeResult?.rewrite_source || (alignedTopicSafeResult?.repair_note === "closed_topic_guard_rewritten"
      ? "closed_topic_guard_rewrite"
      : alignedTopicSafeResult?.repair_note === "looping_reply_rewritten"
        ? "loop_rewrite"
        : alignedTopicSafeResult?.rewrite_applied
          ? "quality_rewrite"
          : "raw_model_output"), {
      turnFrame: turnContext.turn_frame,
      canonicalContext: {
        activeTopicKey,
        latestListenerQuestionTopic:
          turnsSoFar.length && turnsSoFar[turnsSoFar.length - 1]?.actorUserId === listener.userId
            ? getTurnQuestionTopic(turnsSoFar[turnsSoFar.length - 1])
            : null,
        speakerUserId: speaker.userId,
        listenerUserId: listener.userId
      }
    });
    const latestListenerQuestionTopic =
      turnsSoFar.length && turnsSoFar[turnsSoFar.length - 1]?.actorUserId === listener.userId
        ? getTurnQuestionTopic(turnsSoFar[turnsSoFar.length - 1])
        : null;

    if (
      turnsSoFar.length &&
      turnsSoFar[turnsSoFar.length - 1]?.actorUserId === listener.userId &&
      textLooksLikeQuestion(turnsSoFar[turnsSoFar.length - 1]?.content) &&
      !(
        normalizeTopicKey(safeResult?.reply_topic_key || safeResult?.emitted_reply_topic_key) === normalizeTopicKey(latestListenerQuestionTopic)
      ) &&
      shouldRejectAnswerTopicMismatch({ result: safeResult, activeTopicKey, latestListenerQuestionTopic })
    ) {
      createHumanInputRequest({
        sessionId: liveSessionAfterGeneration.id,
        roundId: liveRound.id,
        targetUserId: speaker.userId,
        fieldKey: latestListenerQuestionTopic || activeTopicKey || "manual_review",
        questionText: "当前回复没有先正面回答上一条问题，系统需要本人确认后再继续。",
        metadata: {
          turnNumber: nextTurnNumber,
          source: "answer_topic_mismatch_guard",
          expectedTopic: latestListenerQuestionTopic || activeTopicKey || null,
          actualTopic: safeResult.emitted_reply_topic_key || safeResult.reply_topic_key || null
        }
      });
      addConversationTurn({
        sessionId: liveSessionAfterGeneration.id,
        roundId: liveRound.id,
        turnNumber: nextTurnNumber,
        actorUserId: null,
        actorRole: "system",
        content: "当前回复没有先正面回答上一条问题，系统需要本人确认后再继续。",
        metadata: {
          pauseReason: "pending_human_input",
          targetUserId: speaker.userId,
          fieldKey: latestListenerQuestionTopic || activeTopicKey || "manual_review",
          source: "answer_topic_mismatch_guard"
        }
      });
      return completeRound(liveSessionAfterGeneration, liveRound, "pending_human_input", "pending_human_input");
    }

    if (safeResult.needs_sensitive_approval || safeResult.is_sensitive_question) {
      const targetUserId = resolveTargetUserId(
        safeResult.target_user_for_approval,
        speaker.userId,
        listener.userId
      );
      const sensitiveRequest = requestSensitiveTopicApproval({
        session: liveSessionAfterGeneration,
        round: liveRound,
        requestingUserId: speaker.userId,
        targetUserId,
        topicCategory: safeResult.sensitive_topic_category || "unknown",
        promptText: safeResult.reply,
        promptIntent: "twin_question",
        source: "conversation_loop",
        turnNumber: nextTurnNumber
      });

      if (sensitiveRequest.kind === "created" || sensitiveRequest.kind === "already_pending") {
        return completeRound(liveSessionAfterGeneration, liveRound, "pending_sensitive_approval", "pending_sensitive_approval");
      }

      if (["skipped_by_profile", "already_blocked"].includes(sensitiveRequest.kind)) {
        liveSession = sensitiveRequest.session || getPrechatSessionById(liveSessionAfterGeneration.id) || liveSessionAfterGeneration;
        currentSpeakerId =
          getTopicEntry(getSessionControl(liveSession).automation.topicLedger, getSessionControl(liveSession).automation.activeTopicKey)
            ?.pendingAnswerUserId || listener.userId;
        nextTurnNumber += 1;
        continue;
      }
    }

    if (safeResult.needs_human_input.required) {
      if (shouldUseDeferredRetryForTurnResult(safeResult) && !isDeferredRetrySuppressedByTrigger(trigger)) {
        const deferredRetry = buildDeferredRetryState(liveSessionAfterGeneration, {
          ...buildModelOutputDeferredRetryOptions({
            trigger:
              normalizeText(trigger) ||
              normalizeText(getSessionControl(liveSessionAfterGeneration).automation.activeTrigger) ||
              normalizeText(getSessionControl(liveSessionAfterGeneration).automation.lastTrigger) ||
              "conversation_loop",
            automationIntent: { intent: deferredRetrySourceIntent },
            sourceRoundId: liveRound.id,
            sourceTurnNumber: nextTurnNumber
          })
        });

        if (!shouldExhaustDeferredRetry(deferredRetry)) {
          finishPrechatRound(liveRound.id, { status: "completed", stopReason: "deferred_model_retry" });
          updatePrechatSession(liveSessionAfterGeneration.id, {
            status: "active",
            control: buildSessionControlPatch(liveSessionAfterGeneration, {
              automation: {
                lastFailureReason: "model_output_unstable",
                lastFailureAt: nowIso(),
                deferredRetry
              }
            })
          });
          scheduleDeferredAutomationRetry(liveSessionAfterGeneration.id, speaker.userId, deferredRetry);
          return {
            status: "active",
            stopReason: "deferred_model_retry",
            metadata: {
              deferred_retry_scheduled: true,
              deferred_retry_attempt: deferredRetry.attemptCount,
              roundId: liveRound.id,
              turnNumber: nextTurnNumber
            }
          };
        }
      }

      const targetUserId = resolveTargetUserId(
        safeResult.needs_human_input.target_user_for_input,
        speaker.userId,
        listener.userId
      );
      const targetParticipant =
        targetUserId === participants.initiator.userId ? participants.initiator : participants.counterparty;
      const fieldKey = safeResult.needs_human_input.field || "manual_review";
      const questionText = safeResult.needs_human_input.question || "请人工补充这一项信息。";
      const topicGuardMetadata =
        safeResult.topic_guard_metadata && typeof safeResult.topic_guard_metadata === "object"
          ? safeResult.topic_guard_metadata
          : null;
      const qualityPauseMetadata =
        normalizeText(safeResult.reply_quality_issue) || normalizeText(safeResult.quality_guard_reason)
          ? buildQualityPauseMetadata({
              result: safeResult,
              source: "quality_guard",
              sourceTurnId: turnsSoFar.length ? turnsSoFar[turnsSoFar.length - 1]?.id || null : null,
              turnNumber: nextTurnNumber,
              activeTopicKey
            })
          : null;
      const requestMetadata = {
        turnNumber: nextTurnNumber,
        ...(topicGuardMetadata || {}),
        ...(qualityPauseMetadata || {})
      };

      createHumanInputRequest({
        sessionId: liveSessionAfterGeneration.id,
        roundId: liveRound.id,
        targetUserId,
        fieldKey,
        questionText,
        metadata: requestMetadata
      });

      addConversationTurn({
        sessionId: liveSessionAfterGeneration.id,
        roundId: liveRound.id,
        turnNumber: nextTurnNumber,
        actorUserId: null,
        actorRole: "system",
        content: buildPauseMessage(targetParticipant?.displayName || "对方", fieldKey, questionText),
        metadata: {
          pauseReason: "pending_human_input",
          targetUserId,
          fieldKey,
          ...(topicGuardMetadata || {}),
          ...(qualityPauseMetadata || {})
        }
      });

      if (topicGuardMetadata) {
        emitTopicGuardTelemetry(topicGuardMetadata, {
          pending_human_input_emitted: true
        });
      }

      return completeRound(liveSessionAfterGeneration, liveRound, "pending_human_input", "pending_human_input");
    }

    const closesConversationWithoutMessage =
      safeResult.recommendation === "objectives_completed" &&
      !normalizeText(safeResult.reply) &&
      !safeResult.needs_human_input?.required;

    if (closesConversationWithoutMessage) {
      return completeRound(liveSessionAfterGeneration, liveRound, "paused_review", "objectives_completed");
    }

    const hasPersistableTwinReply =
      Boolean(normalizeText(safeResult.reply)) ||
      safeResult.needs_human_input?.required ||
      safeResult.needs_sensitive_approval;

    if (!hasPersistableTwinReply) {
      return completeRound(liveSessionAfterGeneration, liveRound, "paused_review", "paused_review");
    }

    const persistedSafeResult = persistFinalCanonicalTurnMetadata(
      safeResult,
      turnContext.turn_frame,
      {
        activeTopicKey,
        latestListenerQuestionTopic,
        speakerUserId: speaker.userId,
        listenerUserId: listener.userId,
        speakerDisplayName: speaker.displayName || ""
      }
    );
    const duplicateTwinTurn = shouldSkipDuplicateTwinTurn(
      liveSessionAfterGeneration.id,
      {
        actorUserId: speaker.userId,
        actorRole: `${participantRole(session, speaker.userId)}_twin`,
        content: persistedSafeResult.reply,
        metadata: persistedSafeResult
      },
      {
        turns: turnsSoFar,
        trigger:
          normalizeText(trigger) ||
          normalizeText(getSessionControl(liveSessionAfterGeneration).automation.activeTrigger) ||
          normalizeText(getSessionControl(liveSessionAfterGeneration).automation.lastTrigger) ||
          normalizeText(automationIntent?.intent) ||
          "conversation_loop",
        reason: "identical_recent_twin_turn"
      }
    );

    if (duplicateTwinTurn?.duplicate && duplicateTwinTurn.existingTurn) {
      return completeRound(liveSessionAfterGeneration, liveRound, "paused_review", "paused_review");
    }

    const turn = addConversationTurn({
      sessionId: liveSessionAfterGeneration.id,
      roundId: liveRound.id,
      turnNumber: nextTurnNumber,
      actorUserId: speaker.userId,
      actorRole: `${participantRole(session, speaker.userId)}_twin`,
      content: persistedSafeResult.reply,
      metadata: persistedSafeResult
    });

    if (persistedSafeResult.confirmed_facts.length) {
      const persisted = persistAcceptedFacts({
        session: liveSessionAfterGeneration,
        round: liveRound,
        speaker,
        listener,
        facts: persistedSafeResult.confirmed_facts,
        turns: turnsSoFar,
        sourceTurnId: turn.id,
        telemetrySource: "conversation_loop"
      });

      if (persisted.needsHumanInputFallback) {
        const factRejectedResult = buildFactRejectionSilentRetryResult({
          result: safeResult,
          topicKey: activeTopicKey || objectives?.[0]?.key || "manual_review",
          activeTopicKey,
          latestListenerQuestionTopic
        });

        if (shouldUseDeferredRetryForTurnResult(factRejectedResult) && !isDeferredRetrySuppressedByTrigger(trigger)) {
          const deferredRetry = buildDeferredRetryState(liveSessionAfterGeneration, {
            ...buildModelOutputDeferredRetryOptions({
              trigger:
                normalizeText(trigger) ||
                normalizeText(getSessionControl(liveSessionAfterGeneration).automation.activeTrigger) ||
                normalizeText(getSessionControl(liveSessionAfterGeneration).automation.lastTrigger) ||
                "conversation_loop",
              automationIntent: { intent: deferredRetrySourceIntent },
              sourceRoundId: liveRound.id,
              sourceTurnNumber: nextTurnNumber + 1
            })
          });

          if (!shouldExhaustDeferredRetry(deferredRetry)) {
            finishPrechatRound(liveRound.id, { status: "completed", stopReason: "deferred_model_retry" });
            updatePrechatSession(liveSessionAfterGeneration.id, {
              status: "active",
              control: buildSessionControlPatch(liveSessionAfterGeneration, {
                automation: {
                  lastFailureReason: "model_output_unstable",
                  lastFailureAt: nowIso(),
                  deferredRetry
                }
              })
            });
            scheduleDeferredAutomationRetry(liveSessionAfterGeneration.id, speaker.userId, deferredRetry);
            return {
              status: "active",
              stopReason: "deferred_model_retry",
              metadata: {
                deferred_retry_scheduled: true,
                deferred_retry_attempt: deferredRetry.attemptCount,
                roundId: liveRound.id,
                turnNumber: nextTurnNumber + 1
              }
            };
          }
        }

        return completeRound(liveSessionAfterGeneration, liveRound, "paused_review", "deferred_model_retry");
      }
    }

    liveSession = advanceTopicLedgerAfterTwinTurn(
      liveSessionAfterGeneration,
      objectives,
      turn,
      listExtractedFacts(liveSessionAfterGeneration.id)
    );
    liveRound = syncRoundObjectiveSnapshot(liveRound, liveSession, objectives);

    if (isHighRisk(safeResult.risk_flags)) {
      return completeRound(liveSession, liveRound, "blocked_risk", "blocked_risk");
    }

    const liveTurns = listConversationTurns(liveSession.id);
    const outstandingTwinQuestion = shouldContinueForOutstandingTwinQuestion(
      liveSession,
      round,
      liveTurns,
      nextTurnNumber + 1,
      nextTurnNumber >= MAX_TURNS_PER_ROUND
    );

    if (outstandingTwinQuestion) {
      currentSpeakerId = outstandingTwinQuestion.targetUserId;
      nextTurnNumber += 1;
      continue;
    }

    const progress = buildObjectiveProgress(liveSession, objectives, listExtractedFacts(liveSession.id));
    const currentActiveTopicKey = getSessionControl(liveSession).automation.activeTopicKey;
    const currentProgressSnapshot = buildRoundProgressSnapshot(
      liveSession,
      objectives,
      liveTurns,
      liveRound
    );

    if (didRoundProgressAdvance(lastProgressSnapshot, currentProgressSnapshot)) {
      noProgressTurns = 0;
    } else {
      noProgressTurns += 1;
    }
    lastProgressSnapshot = currentProgressSnapshot;

    if (
      allObjectivesConfirmed(progress, {
        activeTopicKey: getScopedActiveTopicKey(liveSession, liveRound, objectives) || currentActiveTopicKey,
        hasOutstandingTwinQuestion: hasTrustedOutstandingTwinQuestion(liveSession, liveTurns, liveRound),
        allCanonicalTopicsClosed: areAllCanonicalTopicsClosed(liveSession),
        scopedObjectiveKeys: getEffectiveScopedObjectiveKeys(liveSession, liveRound, objectives)
      })
    ) {
      return completeRound(liveSession, liveRound, "paused_review", "objectives_completed");
    }

    if (safeResult.recommendation === "objectives_completed") {
      return completeRound(liveSession, liveRound, "paused_review", "objectives_completed");
    }

    if (safeResult.recommendation === "handoff_ready") {
      return completeRound(liveSession, liveRound, "handoff_ready", "handoff_ready");
    }

    if (noProgressTurns >= MAX_NO_PROGRESS_TURNS && hasUnresolvedTopicBacklog(liveSession)) {
      return completeRound(liveSession, liveRound, "paused_review", "paused_review");
    }

    if (safeResult.recommendation === "pause_review") {
      const emittedReplyTopicKey =
        normalizeTopicKey(safeResult.canonical_reply_topic_key) ||
        normalizeTopicKey(safeResult.emitted_reply_topic_key) ||
        normalizeTopicKey(safeResult.reply_topic_key);
      const emittedQuestionTopicKey =
        normalizeTopicKey(safeResult.canonical_question_topic_key) ||
        normalizeTopicKey(safeResult.emitted_question_topic_key) ||
        normalizeTopicKey(safeResult.question_topic_key);
      const answerOnlyWithoutPendingRequest =
        Boolean(emittedReplyTopicKey) &&
        !emittedQuestionTopicKey &&
        !safeResult.needs_human_input?.required &&
        !safeResult.needs_sensitive_approval;

      if (answerOnlyWithoutPendingRequest && hasUnresolvedTopicBacklog(liveSession)) {
        const continuation = derivePostAnswerContinuation({
          session: liveSession,
          objectives,
          turns: liveTurns,
          speakerUserId: speaker.userId,
          listenerUserId: listener.userId,
          result: safeResult,
          activeTopicKey: getSessionControl(liveSession).automation.activeTopicKey
        });

        if (continuation.strategy === "reuse_existing_outstanding_question") {
          currentSpeakerId = continuation.nextSpeakerUserId || listener.userId;
          nextTurnNumber += 1;
          continue;
        }

        if (continuation.strategy === "emit_canonical_mirror_question" || continuation.strategy === "switch_to_next_topic") {
          const generatedQuestionText = normalizeText(continuation.questionText);
          const generatedQuestionTopicKey = normalizeTopicKey(continuation.questionTopicKey);
          const generatedReply = generatedQuestionText;
          const generatedTurnMetadata = persistFinalCanonicalTurnMetadata(
            {
              reply: generatedReply,
              reply_topic_key: null,
              question_topic_key: generatedQuestionTopicKey,
              confirmed_facts: [],
              open_questions: generatedQuestionText ? [generatedQuestionText] : [],
              risk_flags: [],
              needs_human_input: {
                required: false,
                field: null,
                question: null,
                target_user_for_input: null
              },
              recommendation: "continue"
            },
            turnContext.turn_frame,
            {
              activeTopicKey: generatedQuestionTopicKey,
              latestListenerQuestionTopic: null,
              speakerUserId: speaker.userId,
              listenerUserId: listener.userId,
              speakerDisplayName: speaker.displayName || ""
            },
            {
              post_answer_continuation_strategy: continuation.strategy,
              mirror_question_required_for_coverage: continuation.strategy === "emit_canonical_mirror_question",
              mirror_question_allowed: continuation.strategy === "emit_canonical_mirror_question",
              repeat_guard_suppressed: continuation.strategy === "emit_canonical_mirror_question",
              repeat_guard_suppression_reason:
                continuation.strategy === "emit_canonical_mirror_question"
                  ? "mirror_question_required_for_missing_listener_coverage"
                  : null,
              coverage_before_current_turn: continuation.coverageBefore || null,
              coverage_after_current_turn: continuation.coverageAfter || null
            }
          );
          const duplicateTwinTurn = shouldSkipDuplicateTwinTurn(
            liveSession.id,
            {
              content: generatedReply,
              actorUserId: speaker.userId,
              actorRole: `${participantRole(session, speaker.userId)}_twin`,
              metadata: generatedTurnMetadata
            },
            {
              turns: liveTurns,
              trigger:
                normalizeText(trigger) ||
                normalizeText(getSessionControl(liveSession).automation.activeTrigger) ||
                normalizeText(getSessionControl(liveSession).automation.lastTrigger) ||
                normalizeText(automationIntent?.intent) ||
                "conversation_loop",
              reason: "post_answer_generated_question"
            }
          );

          if (!duplicateTwinTurn?.duplicate && generatedReply && generatedQuestionTopicKey) {
            const synthesizedTurnResult = generatedTurnMetadata;

            const generatedTurn = addConversationTurn({
              sessionId: liveSession.id,
              roundId: liveRound.id,
              turnNumber: nextTurnNumber + 1,
              actorUserId: speaker.userId,
              actorRole: `${participantRole(session, speaker.userId)}_twin`,
              content: synthesizedTurnResult.reply,
              metadata: synthesizedTurnResult
            });

            liveSession = advanceTopicLedgerAfterTwinTurn(
              liveSession,
              objectives,
              generatedTurn,
              listExtractedFacts(liveSession.id)
            );
            liveRound = syncRoundObjectiveSnapshot(liveRound, liveSession, objectives);
            currentSpeakerId = listener.userId;
            nextTurnNumber += 2;
            if (nextTurnNumber > MAX_TURNS_PER_ROUND) {
              usedOutstandingQuestionOverflowTurn = true;
            }
            continue;
          }

          if (duplicateTwinTurn?.duplicate) {
            currentSpeakerId = listener.userId;
            nextTurnNumber += 1;
            if (nextTurnNumber > MAX_TURNS_PER_ROUND) {
              usedOutstandingQuestionOverflowTurn = true;
            }
            continue;
          }
        }

        if (continuation.strategy === "objectives_completed") {
          return completeRound(liveSession, liveRound, "paused_review", "objectives_completed");
        }
      }

      if (hasUnresolvedTopicBacklog(liveSession) && isSemanticallyMisalignedTwinTurn({ actorRole: "twin", metadata: safeResult })) {
        const unresolvedTopic =
          normalizeTopicKey(getSessionControl(liveSession).automation.activeTopicKey) ||
          normalizeTopicKey(getSessionControl(liveSession).automation.topicQueueSnapshot?.[0]) ||
          "manual_review";
        createHumanInputRequest({
          sessionId: liveSession.id,
          roundId: liveRound.id,
          targetUserId: speaker.userId,
          fieldKey: unresolvedTopic,
          questionText: `当前议题“${getTopicLabel(unresolvedTopic)}”还没有被稳定确认，系统需要本人补充后再继续。`,
          metadata: {
            turnNumber: nextTurnNumber + 1,
            source: "semantic_alignment_guard",
            alignmentIssue: safeResult.alignment_issue || null,
            emittedQuestionText: safeResult.emitted_question_text || null
          }
        });
        addConversationTurn({
          sessionId: liveSession.id,
          roundId: liveRound.id,
          turnNumber: nextTurnNumber + 1,
          actorUserId: null,
          actorRole: "system",
          content: `当前议题“${getTopicLabel(unresolvedTopic)}”还没有被稳定确认，系统需要本人补充后再继续。`,
          metadata: {
            pauseReason: "pending_human_input",
            targetUserId: speaker.userId,
            fieldKey: unresolvedTopic,
            source: "semantic_alignment_guard"
          }
        });
        return completeRound(liveSession, liveRound, "pending_human_input", "pending_human_input");
      }

      return completeRound(liveSession, liveRound, "paused_review", "paused_review");
    }

    currentSpeakerId =
      getTopicEntry(getSessionControl(liveSession).automation.topicLedger, getSessionControl(liveSession).automation.activeTopicKey)
        ?.pendingAnswerUserId || listener.userId;
    nextTurnNumber += 1;
    if (nextTurnNumber > MAX_TURNS_PER_ROUND) {
      usedOutstandingQuestionOverflowTurn = true;
    }
  }

  const finalOutstandingTwinQuestion = shouldContinueForOutstandingTwinQuestion(
    liveSession,
    round,
    listConversationTurns(liveSession.id),
    nextTurnNumber,
    true
  );

  if (finalOutstandingTwinQuestion) {
    return completeRound(liveSession, liveRound, "paused_review", "outstanding_twin_question_unanswered");
  }

  if (areAllCanonicalTopicsClosed(liveSession) && !hasTrustedOutstandingTwinQuestion(liveSession, listConversationTurns(liveSession.id), liveRound)) {
    return completeRound(liveSession, liveRound, "paused_review", "objectives_completed");
  }

  return completeRound(liveSession, liveRound, "paused_review", "max_turns_reached");
}

export async function createPrechatInvitation(matchId, initiatorUserId, createSessionFn, options = {}) {
  const match = getMatchForUser(matchId, initiatorUserId);

  if (!match) {
    throw new Error("未找到可发起预沟通的匹配。");
  }

  const existing = getLatestOpenSessionForMatch(matchId);

  if (existing) {
    updatePrechatSession(existing.id, {
      control: mergeAutomationControl(existing, options)
    });
    return getPrechatSessionForUser(existing.id, initiatorUserId);
  }

  const counterpartyUserId = match.userAId === initiatorUserId ? match.userBId : match.userAId;
  return createSessionFn({
    matchId,
    initiatorUserId,
    counterpartyUserId,
    control: buildInitialSessionControl(options)
  });
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
  scheduleSessionAutomation(session.id, currentUserId, "accept_invitation");
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

async function runSessionRoundInternal(sessionId, currentUserId, options = {}) {
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

    if (isManualPauseActive(session)) {
      throw new Error("当前会话已被手动结束推进，请先继续推进后再恢复 Twin 对话。");
    }

    const detail = getSessionDetailForUser(sessionId, currentUserId);
    const automationIntent = options.automationIntent || deriveAutomationIntent(detail, options.trigger);
    const latestRound = getLatestRoundForSession(session.id);
    if (
      automationIntent.intent === "answer_outstanding_question" &&
      automationIntent.outstandingRecovery &&
      latestRound?.status !== "active"
    ) {
      return answerOutstandingTwinQuestion(
        sessionId,
        automationIntent.outstandingRecovery.sourceTurn.id,
        automationIntent.outstandingRecovery.targetUserId
      );
    }

    const roundStartSuppression = options.automationIntent
      ? shouldSuppressRoundStart(detail, automationIntent)
      : { suppress: false, reason: null };
    if (roundStartSuppression.suppress) {
      return {
        status: session.status,
        stopReason: "no_op",
        metadata: {
          round_start_suppressed: true,
          round_start_suppressed_reason: roundStartSuppression.reason,
          automation_intent: automationIntent.intent
        }
      };
    }

    const scopedSession = ensureSessionPreferredObjectiveScope(session, latestRound);
    const topics = buildObjectives(
      scopedSession,
      getCurrentTwin(session.initiatorUserId),
      getCurrentTwin(session.counterpartyUserId),
      listExtractedFacts(session.id)
    );
    const syncedSession = persistSessionTopicLedger(scopedSession, topics);
    const activeRound = latestRound?.status === "active" ? latestRound : null;
    const objectiveProgress = buildObjectiveProgress(
      syncedSession,
      topics,
      listExtractedFacts(syncedSession.id)
    );

    if (
      latestRound?.status === "completed" &&
      normalizeText(latestRound.stopReason) === "objectives_completed" &&
      allObjectivesConfirmed(objectiveProgress, {
        activeTopicKey: getScopedActiveTopicKey(syncedSession, latestRound, topics),
        hasOutstandingTwinQuestion: Boolean(
          detectOutstandingTwinQuestion(syncedSession, listConversationTurns(syncedSession.id), latestRound)
        ),
        allCanonicalTopicsClosed: areAllCanonicalTopicsClosed(syncedSession),
        scopedObjectiveKeys: getEffectiveScopedObjectiveKeys(syncedSession, latestRound, topics)
      })
    ) {
      return {
        status: syncedSession.status,
        stopReason: "no_op",
        metadata: {
          round_start_suppressed: true,
          round_start_suppressed_reason: "objectives_already_completed",
          automation_intent: automationIntent.intent
        }
      };
    }

    if (options.automationIntent && automationIntent.intent === "no_op") {
      return {
        status: syncedSession.status,
        stopReason: "no_op",
        metadata: {
          round_start_suppressed: true,
          round_start_suppressed_reason: automationIntent.reason || "no_automation_path",
          automation_intent: automationIntent.intent
        }
      };
    }

    if (activeRound) {
      return executeConversationLoop({
        session: getPrechatSessionById(session.id),
        round: syncRoundObjectiveSnapshot(activeRound, syncedSession, topics),
        speakerUserId:
          getTopicEntry(getSessionControl(syncedSession).automation.topicLedger, getSessionControl(syncedSession).automation.activeTopicKey)
            ?.pendingAnswerUserId || syncedSession.initiatorUserId,
        startingTurnNumber: getLatestTurnNumber(activeRound.id) + 1,
        trigger: options.trigger,
        automationIntent
      });
    }

    const roundNumber = session.currentRound + 1;
    const round = createPrechatRound({
      sessionId: session.id,
      roundNumber,
      objective: {
        topics,
        activeTopicKey: getSessionControl(syncedSession).automation.activeTopicKey,
        topicQueueSnapshot: getSessionControl(syncedSession).automation.topicQueueSnapshot
      }
    });
    const syncedRound = syncRoundObjectiveSnapshot(round, syncedSession, topics);

    updatePrechatSession(session.id, { status: "active", currentRound: roundNumber });
    return executeConversationLoop({
      session: getPrechatSessionById(session.id),
      round: syncedRound,
      speakerUserId: session.initiatorUserId,
      startingTurnNumber: 1,
      trigger: options.trigger,
      automationIntent
    });
}

export async function runSessionRound(sessionId, currentUserId, options = {}) {
  if (options.skipLock) {
    return runSessionRoundInternal(sessionId, currentUserId, options);
  }

  return withSessionAutomationLock(sessionId, () => runSessionRoundInternal(sessionId, currentUserId, options));
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
      approvedByUserId: currentUserId,
      approvalKind: "topic",
      resolutionSource: "approve_sensitive"
    }
  });

  const session = getPrechatSessionById(request.sessionId);
  if (!session) {
    throw new Error("未找到该敏感授权对应的会话。");
  }

  updatePrechatSession(session.id, {
    status: "active",
    control: buildSessionControlPatch(session, {
      sensitiveApprovalLedger: buildSensitiveApprovalLedgerPatch(session, request.topicCategory, {
        state: "approved",
        requestId: request.id,
        resolvedAt: nowIso(),
        targetUserId: request.targetUserId,
        requestedByUserId: request.requestingUserId,
        lastPromptText: request.metadata?.lastPromptText || request.questionText || null,
        resolutionSource: "approve_sensitive",
        promptIntent: request.metadata?.promptIntent || null
      })
    })
  });
  clearDeferredRetryState(session.id);
  await queueSessionAutomation(session.id, currentUserId, "approve_sensitive");
  return getSessionView(session.id, currentUserId);
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
      rejectedByUserId: currentUserId,
      approvalKind: "topic",
      resolutionSource: "reject_sensitive"
    }
  });

  const session = getPrechatSessionById(request.sessionId);
  if (!session) {
    throw new Error("未找到该敏感授权对应的会话。");
  }

  const skippedSession = skipSensitiveTopicForSession(session, request.topicCategory, "reject_sensitive");
  updatePrechatSession(skippedSession.id, { status: "active" });
  clearDeferredRetryState(skippedSession.id);
  await queueSessionAutomation(skippedSession.id, currentUserId, "reject_sensitive");
  return getSessionView(skippedSession.id, currentUserId);
}

export async function deleteMessageForCurrentUser(sessionId, turnId, currentUserId) {
  const session = getPrechatSessionForUser(sessionId, currentUserId);
  assertSessionParticipant(session, currentUserId);

  const turn = getConversationTurnById(turnId);
  ensureTurnBelongsToSession(turn, sessionId);
  assertOwnHumanTurn(turn, currentUserId);
  const metadata = assertTurnVisibleToUser(turn, currentUserId);

  if (metadata.deletedForUserIds.includes(currentUserId)) {
    return getSessionView(sessionId, currentUserId);
  }

  updateConversationTurn(turn.id, {
    metadata: {
      ...metadata,
      deletedForUserIds: [...metadata.deletedForUserIds, currentUserId]
    }
  });

  return getSessionView(sessionId, currentUserId);
}

export async function recallMessage(sessionId, turnId, currentUserId) {
  const session = getPrechatSessionForUser(sessionId, currentUserId);
  assertSessionParticipant(session, currentUserId);

  const turn = getConversationTurnById(turnId);
  ensureTurnBelongsToSession(turn, sessionId);
  assertOwnHumanTurn(turn, currentUserId);
  const metadata = assertTurnVisibleToUser(turn, currentUserId);

  if (metadata.recalled) {
    throw new Error("这条消息已经撤回了。");
  }

  if (Date.now() - new Date(turn.createdAt).getTime() > MESSAGE_RECALL_WINDOW_MS) {
    throw new Error("只能撤回自己 2 分钟内发送的真人消息。");
  }

  updateConversationTurn(turn.id, {
    metadata: {
      ...metadata,
      recalled: true,
      recalledAt: new Date().toISOString(),
      recalledByUserId: currentUserId
    }
  });

  return getSessionView(sessionId, currentUserId);
}

export async function editMessage(sessionId, turnId, currentUserId, content) {
  const session = getPrechatSessionForUser(sessionId, currentUserId);
  assertSessionParticipant(session, currentUserId);

  const turn = getConversationTurnById(turnId);
  ensureTurnBelongsToSession(turn, sessionId);
  assertOwnHumanTurn(turn, currentUserId);
  const metadata = assertTurnVisibleToUser(turn, currentUserId);

  if (metadata.recalled) {
    throw new Error("已撤回的消息不能修改。");
  }

  const trimmedContent = normalizeText(content);

  if (!trimmedContent) {
    throw new Error("请先输入修改后的消息内容。");
  }

  updateConversationTurn(turn.id, {
    content: trimmedContent,
    metadata: {
      ...metadata,
      edited: true,
      editedAt: new Date().toISOString()
    }
  });

  return getSessionView(sessionId, currentUserId);
}

export async function reactToMessage(sessionId, turnId, currentUserId, emoji) {
  const session = getPrechatSessionForUser(sessionId, currentUserId);
  assertSessionParticipant(session, currentUserId);

  const turn = getConversationTurnById(turnId);
  ensureTurnBelongsToSession(turn, sessionId);
  assertTurnVisibleToUser(turn, currentUserId);

  if (isSystemTurn(turn)) {
    throw new Error("系统消息不支持添加反应。");
  }

  toggleTurnReaction(turn, currentUserId, emoji);
  return getSessionView(sessionId, currentUserId);
}

export async function submitHumanInput(requestId, currentUserId, responseText, options = {}) {
  const request = getHumanInputRequestForUser(requestId, currentUserId);

  if (!request || request.status !== "pending") {
    throw new Error("未找到需要补充的人工问题。");
  }

  const session = getPrechatSessionById(request.sessionId);

  if (!session) {
    throw new Error("未找到该预沟通会话。");
  }

  if (!canSubmitHumanInput(session)) {
    throw new Error("当前至少一方处于“结束推进”。如需提交本人补充，请先恢复“继续推进”。");
  }

  const trimmedResponse = normalizeText(responseText);

  if (!trimmedResponse) {
    throw new Error("请先输入你希望发送的补充内容。");
  }

  const quotedPreview = getQuotedTurnPayload(request.sessionId, options.quotedTurnId, currentUserId);
  resolveHumanInputRequest(requestId, trimmedResponse, { resolvedByUserId: currentUserId });
  const round = getPrechatRound(request.roundId);
  const objectives = Array.isArray(round?.objective?.topics) ? round.objective.topics : [];
  const baseTurnNumber = getLatestTurnNumber(round.id) + 1;

  const humanTurn = addConversationTurn({
    sessionId: request.sessionId,
    roundId: request.roundId,
    turnNumber: baseTurnNumber,
    actorUserId: currentUserId,
    actorRole: `${participantRole(session, currentUserId)}_user`,
    content: trimmedResponse,
    metadata: {
      fromHumanInputRequestId: request.id,
      fieldKey: request.fieldKey,
      manualReview: request.fieldKey === "manual_review",
      quotedTurnId: quotedPreview?.turnId || null,
      quotedPreview
    }
  });

  const currentTwin = getCurrentTwin(currentUserId);
  const profilePatch = getTwinProfilePatchFromHumanInput(request.fieldKey, trimmedResponse);
  const nextTwinProfile = {
    ...(currentTwin?.twinProfile || {}),
    ...(profilePatch || {})
  };

  if (!currentTwin?.twinProfile?.displayName) {
    nextTwinProfile.displayName = currentTwin?.displayName || "未命名用户";
  }

  if (profilePatch || !currentTwin?.twinProfile?.displayName) {
    saveCurrentTwin(currentUserId, nextTwinProfile);
  }

  maybeReopenTopicFromHumanTurn(session, humanTurn, objectives, listExtractedFacts(request.sessionId));
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
  clearDeferredRetryState(request.sessionId);
  scheduleSessionAutomation(request.sessionId, currentUserId, "submit_human_input");
  return getPrechatSessionForUser(request.sessionId, currentUserId);
}

export async function sendManualMessage(sessionId, currentUserId, content, options = {}) {
  const session = getPrechatSessionForUser(sessionId, currentUserId);

  if (!session) {
    throw new Error("未找到该预沟通会话。");
  }

  if (["awaiting_counterparty_acceptance"].includes(session.status)) {
    throw new Error("当前状态下还不能发送真人消息。");
  }

  if (["blocked_risk", "rejected"].includes(session.status)) {
    throw new Error("当前会话已结束，无法继续发送消息。");
  }

  const trimmedContent = normalizeText(content);

  if (!trimmedContent) {
    throw new Error("请先输入要发送的内容。");
  }

  const manualPauseActive = isManualPauseActive(session);
  if (!canSendManualMessage(session, currentUserId)) {
    throw new Error("当前至少一方已结束推进；这一轮暂停期间你只剩 1 条真人消息额度，已用完。");
  }

  const currentRole = getManualPauseRole(session, currentUserId);
  const currentMessageCount = getManualMessageCount(session, currentUserId);
  const quotedPreview = getQuotedTurnPayload(session.id, options.quotedTurnId, currentUserId);
  let baseSessionForTopics = getPrechatSessionById(session.id) || session;

  let round = null;
  const rounds = listPrechatRounds(session.id);

  if (session.status === "completed") {
    const builtTopics = buildObjectives(
      baseSessionForTopics,
      getCurrentTwin(session.initiatorUserId),
      getCurrentTwin(session.counterpartyUserId),
      listExtractedFacts(session.id)
    );
    baseSessionForTopics = persistSessionTopicLedger(baseSessionForTopics, builtTopics);
    const roundNumber = session.currentRound + 1;
    round = createPrechatRound({
      sessionId: session.id,
      roundNumber,
      objective: {
        topics: builtTopics,
        activeTopicKey: getSessionControl(baseSessionForTopics).automation.activeTopicKey,
        topicQueueSnapshot: getSessionControl(baseSessionForTopics).automation.topicQueueSnapshot
      }
    });
    updatePrechatSession(session.id, { status: "active", currentRound: roundNumber });
  } else if (rounds.length) {
    round = rounds[rounds.length - 1];
  } else {
    const builtTopics = buildObjectives(
      baseSessionForTopics,
      getCurrentTwin(session.initiatorUserId),
      getCurrentTwin(session.counterpartyUserId),
      listExtractedFacts(session.id)
    );
    baseSessionForTopics = persistSessionTopicLedger(baseSessionForTopics, builtTopics);
    const roundNumber = 1;
    round = createPrechatRound({
      sessionId: session.id,
      roundNumber,
      objective: {
        topics: builtTopics,
        activeTopicKey: getSessionControl(baseSessionForTopics).automation.activeTopicKey,
        topicQueueSnapshot: getSessionControl(baseSessionForTopics).automation.topicQueueSnapshot
      }
    });
    updatePrechatSession(session.id, { status: "active", currentRound: roundNumber });
  }

  const turnNumber = getLatestTurnNumber(round.id) + 1;
  const manualTurn = addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber,
    actorUserId: currentUserId,
    actorRole: `${participantRole(session, currentUserId)}_user`,
    content: trimmedContent,
    metadata: {
      manualMessage: true,
      manualPauseActive,
      automationPending: !manualPauseActive,
      quotedTurnId: quotedPreview?.turnId || null,
      quotedPreview
    }
  });

  maybeReopenTopicFromHumanTurn(
    baseSessionForTopics,
    manualTurn,
    Array.isArray(round.objective?.topics) ? round.objective.topics : [],
    listExtractedFacts(session.id)
  );

  const nextPatch = {
    status: ["paused_review", "handoff_ready", "completed"].includes(session.status) ? "active" : session.status
  };

  if (manualPauseActive) {
    nextPatch.control = buildSessionControlPatch(session, {
      manualPause: {
        messageCountByRole: {
          [currentRole]: currentMessageCount + 1
        }
      }
    });
  }

  updatePrechatSession(session.id, nextPatch);
  if (!manualPauseActive) {
    clearDeferredRetryState(session.id);
    scheduleSessionAutomation(session.id, currentUserId, "manual_message");
  }
  return getPrechatSessionForUser(session.id, currentUserId);
}

export function getSessionView(sessionId, currentUserId) {
  let detail = getSessionDetailForUser(sessionId, currentUserId);

  if (!detail) {
    return null;
  }

  const hydratedSession = hydrateSensitiveApprovalLedgerFromRequests(detail.session, detail.sensitiveRequests || []);
  if (hydratedSession.id !== detail.session.id || hydratedSession.updatedAt !== detail.session.updatedAt) {
    detail = getSessionDetailForUser(sessionId, currentUserId);
  }

  return toSessionResponse(detail, currentUserId);
}

export async function getSessionViewWithAutoRecovery(sessionId, currentUserId) {
  syncSessionTopicLedgerIfNeeded(sessionId);
  reconcileSessionStatusFromLatestRound(sessionId, currentUserId);
  await autoRecoverPureModelFailurePausedSession(sessionId, currentUserId);
  await autoRecoverManualReviewSession(sessionId, currentUserId);
  await autoRecoverFirstTurnTopicGuardSession(sessionId, currentUserId);
  await autoRecoverInvalidClosedTopicPendingRequest(sessionId, currentUserId);
  await autoRecoverInvalidNextCandidateTopicPendingRequest(sessionId, currentUserId);
  await autoRecoverRepeatFalsePositivePendingRequest(sessionId, currentUserId);
  await autoRecoverMirrorQuestionFalsePositivePendingRequest(sessionId, currentUserId);
  await autoRecoverDuplicatedRecentQuestionFalsePositivePendingRequest(sessionId, currentUserId);
  await autoResolveGenericQualityPausePendingRequest(sessionId, currentUserId);
  await autoRecoverTopicGuardFalsePositivePendingRequest(sessionId, currentUserId);
  await autoRecoverPausedQuestionSession(sessionId, currentUserId);
  await autoRecoverSemanticMisalignmentSession(sessionId, currentUserId);
  maybeTriggerDeferredRetryOnSessionView(sessionId, currentUserId);
  const detail = getSessionDetailForUser(sessionId, currentUserId);
  if (detail && !shouldBlockAutomation(detail) && sessionNeedsAutomationBootstrap(detail)) {
    scheduleSessionAutomation(sessionId, currentUserId, "session_view");
  }
  return getSessionView(sessionId, currentUserId);
}

export async function applySessionDecision(sessionId, currentUserId, action) {
  const session = getPrechatSessionForUser(sessionId, currentUserId);

  if (!session) {
    throw new Error("未找到该预沟通会话。");
  }

  if (action === "reject") {
    updatePrechatSession(session.id, { status: "rejected" });
  } else if (action === "toggle_manual_pause") {
    const control = getSessionControl(session);
    const role = getManualPauseRole(session, currentUserId);
    const wasAnyPaused = isManualPauseActive(session);
    const isCurrentUserPaused = isUserManualPauseActive(session, currentUserId);
    const nextManualPause = {
      initiatorEnded: control.manualPause.initiatorEnded,
      counterpartyEnded: control.manualPause.counterpartyEnded,
      messageCountByRole: {
        initiator: control.manualPause.messageCountByRole.initiator,
        counterparty: control.manualPause.messageCountByRole.counterparty
      }
    };

    if (role === "initiator") {
      nextManualPause.initiatorEnded = !isCurrentUserPaused;
    } else {
      nextManualPause.counterpartyEnded = !isCurrentUserPaused;
    }

    const isAnyPausedNow = nextManualPause.initiatorEnded || nextManualPause.counterpartyEnded;

    if (!wasAnyPaused && isAnyPausedNow) {
      nextManualPause.messageCountByRole = {
        initiator: 0,
        counterparty: 0
      };
    }

    if (!isAnyPausedNow) {
      nextManualPause.messageCountByRole = {
        initiator: 0,
        counterparty: 0
      };
    }

    updatePrechatSession(session.id, {
      status:
        !isAnyPausedNow && ["paused_review", "handoff_ready", "completed"].includes(session.status)
          ? "active"
          : session.status,
      control: buildSessionControlPatch(session, {
        manualPause: nextManualPause
      })
    });

    if (wasAnyPaused && !isAnyPausedNow) {
      scheduleSessionAutomation(session.id, currentUserId, "resume_manual_pause");
    }
  } else {
    throw new Error("不支持的会话操作。");
  }

  return getPrechatSessionForUser(session.id, currentUserId);
}

export function __testOnlyBuildFactCard(profile, topicKey) {
  return buildFactCard(profile, topicKey);
}

export function __testOnlyBuildTopicAnswer(profile, topicKey) {
  return buildTopicAnswerV2(profile, topicKey);
}

export function __testOnlyApplyChineseQualityGuard(args) {
  return applyChineseQualityGuard(args);
}

export function __testOnlyBuildObjectiveProgress(session, objectives, facts = [], openQuestions = []) {
  return buildObjectiveProgress(session, objectives, facts, openQuestions);
}

export function __testOnlyRebuildTopicLedger(session, turns = [], facts = [], objectives = []) {
  return rebuildTopicLedgerFromSession(session, turns, facts, objectives);
}

export function __testOnlyDetectOutstandingTwinQuestion(session, turns = [], round = null) {
  return detectOutstandingTwinQuestion(session, turns, round);
}

export function __testOnlyGetLatestOutstandingTwinQuestionRecoveryForSession(sessionId, actorUserId) {
  return getLatestOutstandingTwinQuestionRecoveryForSession(sessionId, actorUserId);
}

export function __testOnlySanitizeFactsForPrompt(facts = [], context = {}) {
  return sanitizeFactsForPrompt(facts, context);
}

export function __testOnlyShouldRejectAnswerTopicMismatch(args) {
  return shouldRejectAnswerTopicMismatch(args);
}

export function __testOnlyBuildQuestionFingerprint(text, topicKey = null) {
  return buildQuestionFingerprint(text, topicKey);
}

export function __testOnlyAlignFinalTurnSemantics(result, context = {}) {
  return alignFinalTurnSemantics(result, context);
}

export function __testOnlyDetectOutstandingTwinQuestionSourceValidity(turn) {
  return isCarryoverSourceTurnValid(turn);
}

export function __testOnlyBuildCanonicalTurnOutcome(result, frame = {}, context = {}) {
  return buildCanonicalTurnOutcome(result, frame, context);
}

export function __testOnlyCanonicalizeHistoricalTwinTurn(turn, session, turns = []) {
  return canonicalizeHistoricalTwinTurn(turn, session, turns);
}

export function __testOnlyIsTrustedCanonicalTwinTurn(turn) {
  return isTrustedCanonicalTwinTurn(turn);
}

export function __testOnlyBuildSafeFollowupReply(args) {
  return buildSafeFollowupReply(args);
}

export function __testOnlyDerivePostAnswerContinuation(args) {
  return derivePostAnswerContinuation(args);
}

export function __testOnlyBuildTurnContextV2(args) {
  return buildTurnContextV2(args);
}

export function __testOnlyValidateTopicAwareTurnResult(args) {
  return validateTopicAwareTurnResult(args);
}

export function __testOnlyCollapseAdjacentDuplicateTwinTurns(turns = []) {
  return collapseAdjacentDuplicateTwinTurns(turns);
}

export function __testOnlyShouldSkipDuplicateTwinTurn(sessionId, candidate = {}, options = {}) {
  return shouldSkipDuplicateTwinTurn(sessionId, candidate, options);
}

export function __testOnlyBuildRoundProgressSnapshot(session, objectives = [], turns = [], round = null) {
  return buildRoundProgressSnapshot(session, objectives, turns, round);
}

export function __testOnlyDidRoundProgressAdvance(previousSnapshot = null, nextSnapshot = null) {
  return didRoundProgressAdvance(previousSnapshot, nextSnapshot);
}

export function __testOnlyBuildDeferredRetryState(session, options = {}) {
  return buildDeferredRetryState(session, options);
}

export function __testOnlyShouldExhaustDeferredRetry(deferredRetry) {
  return shouldExhaustDeferredRetry(deferredRetry);
}

export function sanitizeStageReportPayloadForViewer(payload, session, currentUserId, context = {}) {
  return sanitizeStageReportPayloadForResponse(payload, session, currentUserId, context);
}
