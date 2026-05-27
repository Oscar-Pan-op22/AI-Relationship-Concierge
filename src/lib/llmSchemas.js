import { SENSITIVE_TOPIC_CATEGORIES } from "./constants.js";

const SENSITIVE_TOPIC_KEYS = new Set(SENSITIVE_TOPIC_CATEGORIES.map((item) => item.key));
const TURN_RECOMMENDATIONS = new Set(["continue", "pause_review", "handoff_ready", "blocked_risk"]);
const STAGE_NEXT_ACTIONS = new Set(["continue", "pause_review", "handoff_ready", "blocked_risk"]);
const RISK_SEVERITIES = new Set(["low", "medium", "high"]);
const APPROVAL_TARGETS = new Set(["listener", "counterparty", "other", "target", "speaker", "self", "me"]);
const HUMAN_INPUT_TARGETS = new Set(["listener", "counterparty", "other", "target", "speaker", "self", "me"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clampConfidence(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function ensureEnum(value, allowedValues, fieldName) {
  if (!allowedValues.has(value)) {
    throw new Error(`schema_validation:${fieldName}`);
  }
}

function ensureOptionalEnum(value, allowedValues, fieldName) {
  if (value === null || value === undefined || value === "") {
    return;
  }

  ensureEnum(value, allowedValues, fieldName);
}

function validateFacts(facts, fieldName) {
  if (!Array.isArray(facts)) {
    throw new Error(`schema_validation:${fieldName}`);
  }

  for (const fact of facts) {
    if (!fact?.key || typeof fact.key !== "string") {
      throw new Error(`schema_validation:${fieldName}.key`);
    }

    fact.value = String(fact.value ?? "").trim();
    fact.confidence = clampConfidence(Number(fact.confidence ?? 0));
    fact.status = String(fact.status || "confirmed").trim() || "confirmed";
    fact.subjectUserId = fact.subjectUserId || null;
  }
}

function validateRiskFlags(riskFlags, fieldName) {
  if (!Array.isArray(riskFlags)) {
    throw new Error(`schema_validation:${fieldName}`);
  }

  for (const flag of riskFlags) {
    if (!flag?.type || typeof flag.type !== "string") {
      throw new Error(`schema_validation:${fieldName}.type`);
    }

    ensureEnum(flag.severity, RISK_SEVERITIES, `${fieldName}.severity`);
    flag.reason = String(flag.reason || "").trim();
  }
}

export function validateTurnPayload(payload) {
  if (!isPlainObject(payload)) {
    throw new Error("schema_validation:turn_payload");
  }

  payload.reply = String(payload.reply || "").trim();
  payload.is_sensitive_question = Boolean(payload.is_sensitive_question);
  payload.needs_sensitive_approval = Boolean(payload.needs_sensitive_approval);
  payload.sensitive_topic_category = payload.sensitive_topic_category || null;
  payload.target_user_for_approval =
    payload.target_user_for_approval || (payload.needs_sensitive_approval ? "listener" : null);

  ensureOptionalEnum(
    payload.sensitive_topic_category,
    SENSITIVE_TOPIC_KEYS,
    "turn_payload.sensitive_topic_category"
  );
  ensureOptionalEnum(
    payload.target_user_for_approval,
    APPROVAL_TARGETS,
    "turn_payload.target_user_for_approval"
  );

  validateFacts(payload.confirmed_facts || [], "turn_payload.confirmed_facts");
  validateRiskFlags(payload.risk_flags || [], "turn_payload.risk_flags");

  if (!Array.isArray(payload.open_questions)) {
    throw new Error("schema_validation:turn_payload.open_questions");
  }

  payload.open_questions = payload.open_questions.map((item) => String(item || "").trim()).filter(Boolean);

  if (!isPlainObject(payload.needs_human_input)) {
    throw new Error("schema_validation:turn_payload.needs_human_input");
  }

  payload.needs_human_input.required = Boolean(payload.needs_human_input.required);

  if (payload.needs_human_input.required) {
    payload.needs_human_input.field =
      String(payload.needs_human_input.field || "").trim() || "manual_review";
    payload.needs_human_input.question =
      String(payload.needs_human_input.question || "").trim() || "模型输出不可用，需要人工确认。";
    payload.needs_human_input.target_user_for_input =
      payload.needs_human_input.target_user_for_input || "self";
    ensureEnum(
      payload.needs_human_input.target_user_for_input,
      HUMAN_INPUT_TARGETS,
      "turn_payload.needs_human_input.target_user_for_input"
    );
  } else {
    payload.needs_human_input.field = payload.needs_human_input.field || null;
    payload.needs_human_input.question = payload.needs_human_input.question || null;
    payload.needs_human_input.target_user_for_input =
      payload.needs_human_input.target_user_for_input || null;
    ensureOptionalEnum(
      payload.needs_human_input.target_user_for_input,
      HUMAN_INPUT_TARGETS,
      "turn_payload.needs_human_input.target_user_for_input"
    );
  }

  payload.recommendation = payload.recommendation || "pause_review";
  ensureEnum(payload.recommendation, TURN_RECOMMENDATIONS, "turn_payload.recommendation");

  return payload;
}

export function validateStageSummary(payload) {
  if (!isPlainObject(payload)) {
    throw new Error("schema_validation:stage_summary");
  }

  payload.summary = String(payload.summary || "").trim() || "模型总结不可用，需要人工确认。";
  validateFacts(payload.confirmed_facts || [], "stage_summary.confirmed_facts");
  validateRiskFlags(payload.risk_summary || [], "stage_summary.risk_summary");

  if (!Array.isArray(payload.unresolved_questions)) {
    throw new Error("schema_validation:stage_summary.unresolved_questions");
  }

  payload.unresolved_questions = payload.unresolved_questions
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  payload.next_action = payload.next_action || "pause_review";
  ensureEnum(payload.next_action, STAGE_NEXT_ACTIONS, "stage_summary.next_action");
  payload.handoff_ready = Boolean(payload.handoff_ready);

  return payload;
}

export function getTurnRecommendationValues() {
  return [...TURN_RECOMMENDATIONS];
}

export function getStageNextActionValues() {
  return [...STAGE_NEXT_ACTIONS];
}

export function getSensitiveTopicKeys() {
  return [...SENSITIVE_TOPIC_KEYS];
}
