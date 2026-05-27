import {
  getSensitiveTopicKeys,
  getStageNextActionValues,
  getTurnRecommendationValues,
  validateStageSummary,
  validateTurnPayload
} from "./llmSchemas.js";
import { writeLlmTelemetry } from "./llmTelemetry.js";

const DEFAULTS = {
  provider: process.env.LLM_PROVIDER || "vllm_openai",
  baseUrl: (process.env.LLM_BASE_URL || "http://100.91.101.3:8003/v1").replace(/\/$/, ""),
  model: process.env.LLM_MODEL || "Qwen3.6-35B-A3B-FP8",
  apiKey: process.env.LLM_API_KEY || "EMPTY",
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 15000),
  maxRetries: Number(process.env.LLM_MAX_RETRIES || 1)
};

const TURN_FALLBACK = {
  reply: "",
  is_sensitive_question: false,
  sensitive_topic_category: null,
  needs_sensitive_approval: false,
  target_user_for_approval: null,
  confirmed_facts: [],
  open_questions: ["模型输出不可用，需要人工确认。"],
  risk_flags: [],
  needs_human_input: {
    required: true,
    field: "manual_review",
    question: "模型输出不可用，需要人工确认。",
    target_user_for_input: "self"
  },
  recommendation: "pause_review"
};

const STAGE_FALLBACK = {
  summary: "模型总结不可用，需要人工确认。",
  confirmed_facts: [],
  unresolved_questions: ["模型总结不可用，需要人工确认。"],
  risk_summary: [],
  next_action: "pause_review",
  handoff_ready: false
};

function extractJsonCandidate(text) {
  const trimmed = String(text || "").trim();

  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

function repairJson(text) {
  return extractJsonCandidate(text).replace(/```json/giu, "").replace(/```/gu, "").trim();
}

function normalizeFact(fact) {
  return {
    subjectUserId: fact.subjectUserId || null,
    key: String(fact.key || "").trim(),
    value: String(fact.value ?? "").trim(),
    confidence: Number(fact.confidence ?? 0),
    status: fact.status || "confirmed"
  };
}

function normalizeRiskFlag(flag) {
  return {
    type: String(flag.type || "unknown").trim(),
    severity: String(flag.severity || "medium").trim(),
    reason: String(flag.reason || "").trim()
  };
}

function normalizeTurnPayload(payload) {
  return {
    reply: String(payload.reply || "").trim(),
    is_sensitive_question: Boolean(payload.is_sensitive_question),
    sensitive_topic_category: payload.sensitive_topic_category || null,
    needs_sensitive_approval: Boolean(payload.needs_sensitive_approval),
    target_user_for_approval: payload.target_user_for_approval || null,
    confirmed_facts: Array.isArray(payload.confirmed_facts)
      ? payload.confirmed_facts.filter((fact) => fact?.key).map(normalizeFact)
      : [],
    open_questions: Array.isArray(payload.open_questions)
      ? payload.open_questions.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    risk_flags: Array.isArray(payload.risk_flags) ? payload.risk_flags.map(normalizeRiskFlag) : [],
    needs_human_input: {
      required: Boolean(payload.needs_human_input?.required),
      field: payload.needs_human_input?.field || null,
      question: payload.needs_human_input?.question || null,
      target_user_for_input: payload.needs_human_input?.target_user_for_input || null
    },
    recommendation: payload.recommendation || "pause_review"
  };
}

function normalizeStageSummary(payload) {
  return {
    summary: String(payload.summary || STAGE_FALLBACK.summary).trim(),
    confirmed_facts: Array.isArray(payload.confirmed_facts)
      ? payload.confirmed_facts.filter((fact) => fact?.key).map(normalizeFact)
      : [],
    unresolved_questions: Array.isArray(payload.unresolved_questions)
      ? payload.unresolved_questions.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    risk_summary: Array.isArray(payload.risk_summary) ? payload.risk_summary.map(normalizeRiskFlag) : [],
    next_action: payload.next_action || "pause_review",
    handoff_ready: Boolean(payload.handoff_ready)
  };
}

function classifyError(error) {
  const message = String(error?.message || "");

  if (error?.name === "AbortError") {
    return "timeout";
  }

  if (error instanceof SyntaxError) {
    return "json_parse_error";
  }

  if (message.startsWith("schema_validation:")) {
    return message;
  }

  if (message.includes("LLM 请求失败")) {
    return "llm_request_error";
  }

  return error?.name || "unknown_error";
}

function buildTurnPrompt(context) {
  const schemaGuide = {
    reply: "String. Must be concise Simplified Chinese. If recommendation=continue, reply must not be empty.",
    is_sensitive_question: "Boolean.",
    sensitive_topic_category: `String or null. Allowed values only: ${getSensitiveTopicKeys().join(", ")}`,
    needs_sensitive_approval:
      "Boolean. If true, put the exact sensitive question into reply and wait for approval before it is sent.",
    target_user_for_approval: "String or null. Common values: listener / counterparty / self.",
    confirmed_facts: [
      {
        subjectUserId: "self | listener | actual user id",
        key: "fact key, for example relationshipGoal",
        value: "fact value",
        confidence: "number between 0 and 1",
        status: "confirmed"
      }
    ],
    open_questions: ["remaining unanswered questions"],
    risk_flags: [
      {
        type: "risk type, for example money_request",
        severity: "low | medium | high",
        reason: "risk explanation"
      }
    ],
    needs_human_input: {
      required: "Boolean.",
      field: "If required=true, provide the missing field name.",
      question: "If required=true, provide the exact question that should be surfaced to the human user.",
      target_user_for_input: "self | listener | counterparty"
    },
    recommendation: `Allowed values only: ${getTurnRecommendationValues().join(" | ")}`
  };

  const answerThenAskExample = {
    reply:
      "对，我也是以认真长期关系为目标。长期生活城市我更偏向上海，你这边会更坚定留在上海，还是杭州也可以接受？",
    is_sensitive_question: false,
    sensitive_topic_category: null,
    needs_sensitive_approval: false,
    target_user_for_approval: null,
    confirmed_facts: [
      {
        subjectUserId: "self",
        key: "relationshipGoal",
        value: "认真长期关系",
        confidence: 0.9,
        status: "confirmed"
      }
    ],
    open_questions: ["对方长期生活城市偏好"],
    risk_flags: [],
    needs_human_input: {
      required: false,
      field: null,
      question: null,
      target_user_for_input: null
    },
    recommendation: "continue"
  };

  const openingExample = {
    reply: "你好，我是雨涵的 Twin。看到我们都以认真长期关系为目标，我想先确认一下，你未来更倾向长期在上海还是杭州生活？",
    is_sensitive_question: false,
    sensitive_topic_category: null,
    needs_sensitive_approval: false,
    target_user_for_approval: null,
    confirmed_facts: [],
    open_questions: ["对方长期生活城市偏好"],
    risk_flags: [],
    needs_human_input: {
      required: false,
      field: null,
      question: null,
      target_user_for_input: null
    },
    recommendation: "continue"
  };

  return [
    {
      role: "system",
      content: [
        "You are one side of a Twin-to-Twin prechat conversation inside 同频. You are not the human user.",
        "Always write the reply field in concise Simplified Chinese.",
        "Your job is to move the conversation forward. Do not mirror, echo, or repeat the previous message.",
        "Default turn flow: first answer the other side's latest message, then ask at most one new follow-up question.",
        "If conversation_state.latest_turn_from_listener=true and conversation_state.latest_turn_is_question=true, the first sentence of reply must answer that question explicitly.",
        "When the latest listener message asks about a concrete topic such as city, marriage timeline, children, family boundary, or financial view, answer with the speaker's own twinProfile information instead of re-asking the same topic.",
        "Do not repeat the self-introduction after the conversation has already started.",
        "Do not send the same or near-identical wording that already appears in recent_turns.",
        "Never paraphrase the listener's latest question as your own reply. A reply that only mirrors the latest question is invalid.",
        "Do not ask the same question again if recent_turns already asked it and there is no new information.",
        "If both sides already clearly share a fact, acknowledge it briefly and move to the next unresolved point instead of restating it.",
        "Ask no more than one question in a single reply.",
        "If a needed fact about the current speaker is missing, set needs_human_input.required=true instead of guessing.",
        "If the next question is sensitive, put the exact question into reply and set needs_sensitive_approval=true.",
        "Output exactly one JSON object. No markdown. No prose outside JSON. No chain-of-thought.",
        "Use these context signals carefully:",
        "- conversation_state.conversation_started",
        "- conversation_state.latest_turn_from_listener",
        "- conversation_state.latest_turn_is_question",
        "- conversation_state.last_speaker_message",
        "- conversation_state.last_listener_message",
        "JSON schema:",
        JSON.stringify(schemaGuide, null, 2),
        "Example when answering first and then asking one new follow-up:",
        JSON.stringify(answerThenAskExample, null, 2),
        "Example only for the very first opening turn:",
        JSON.stringify(openingExample, null, 2)
      ].join("\n")
    },
    {
      role: "user",
      content: [
        "Below is the full turn context JSON.",
        "Important: if your planned wording already appears in recent_turns, change strategy and move to the next unresolved point.",
        "Return exactly one JSON object that follows the schema.",
        JSON.stringify(context, null, 2)
      ].join("\n")
    }
  ];
}

function buildStagePrompt(context) {
  const schemaGuide = {
    summary: "String. Brief Simplified Chinese summary of this round.",
    confirmed_facts: [
      {
        subjectUserId: "self | listener | actual user id",
        key: "fact key",
        value: "fact value",
        confidence: "number between 0 and 1",
        status: "confirmed"
      }
    ],
    unresolved_questions: ["remaining unresolved questions"],
    risk_summary: [
      {
        type: "risk type",
        severity: "low | medium | high",
        reason: "risk explanation"
      }
    ],
    next_action: `Allowed values only: ${getStageNextActionValues().join(" | ")}`,
    handoff_ready: "Boolean."
  };

  const example = {
    summary: "双方都明确以认真长期关系为目标，但还需要继续确认长期城市安排。",
    confirmed_facts: [
      {
        subjectUserId: "counterparty",
        key: "relationshipGoal",
        value: "认真长期关系",
        confidence: 0.91,
        status: "confirmed"
      }
    ],
    unresolved_questions: ["婚后城市安排"],
    risk_summary: [],
    next_action: "continue",
    handoff_ready: false
  };

  return [
    {
      role: "system",
      content: [
        "You summarize a Twin-to-Twin prechat round.",
        "Always output exactly one JSON object in concise Simplified Chinese.",
        "No markdown. No prose outside JSON. No chain-of-thought.",
        "JSON schema:",
        JSON.stringify(schemaGuide, null, 2),
        "Example:",
        JSON.stringify(example, null, 2)
      ].join("\n")
    },
    {
      role: "user",
      content: ["Below is the round context JSON. Return exactly one JSON object.", JSON.stringify(context, null, 2)].join(
        "\n"
      )
    }
  ];
}

async function requestWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callChatCompletions(messages, { maxTokens = 500 } = {}) {
  const response = await requestWithTimeout(
    `${DEFAULTS.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DEFAULTS.apiKey}`
      },
      body: JSON.stringify({
        model: DEFAULTS.model,
        messages,
        temperature: 0.2,
        max_tokens: maxTokens,
        response_format: { type: "json_object" }
      })
    },
    DEFAULTS.timeoutMs
  );

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload?.error?.message || payload?.error || `LLM 请求失败：${response.status}`);
  }

  return payload?.choices?.[0]?.message?.content || "";
}

async function parseJsonResponse({ requestType, factory, normalizer, validator }) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let lastError = null;
  let usedRepair = false;
  let attemptCount = 0;

  for (let attempt = 0; attempt <= DEFAULTS.maxRetries; attempt += 1) {
    attemptCount = attempt + 1;

    try {
      const rawText = await factory();
      const rawTrimmed = String(rawText || "").trim();
      const repaired = repairJson(rawText);

      if (repaired !== rawTrimmed) {
        usedRepair = true;
      }

      const normalized = normalizer(JSON.parse(repaired));
      const validated = validator(normalized);

      writeLlmTelemetry({
        adapter_name: "VllmOpenAIAdapter",
        provider: DEFAULTS.provider,
        endpoint: `${DEFAULTS.baseUrl}/chat/completions`,
        model: DEFAULTS.model,
        request_type: requestType,
        started_at: startedAt,
        duration_ms: Date.now() - startedMs,
        attempt_count: attemptCount,
        used_repair: usedRepair,
        used_fallback: false,
        success: true,
        error_type: null
      });

      return validated;
    } catch (error) {
      lastError = error;
    }
  }

  writeLlmTelemetry({
    adapter_name: "VllmOpenAIAdapter",
    provider: DEFAULTS.provider,
    endpoint: `${DEFAULTS.baseUrl}/chat/completions`,
    model: DEFAULTS.model,
    request_type: requestType,
    started_at: startedAt,
    duration_ms: Date.now() - startedMs,
    attempt_count: attemptCount,
    used_repair: usedRepair,
    used_fallback: true,
    success: false,
    error_type: classifyError(lastError)
  });

  throw lastError;
}

export async function generatePrechatTurn(context) {
  try {
    return await parseJsonResponse({
      requestType: "turn",
      factory: () => callChatCompletions(buildTurnPrompt(context), { maxTokens: 500 }),
      normalizer: normalizeTurnPayload,
      validator: validateTurnPayload
    });
  } catch {
    return { ...TURN_FALLBACK };
  }
}

export async function summarizeStage(context) {
  try {
    return await parseJsonResponse({
      requestType: "stage_summary",
      factory: () => callChatCompletions(buildStagePrompt(context), { maxTokens: 500 }),
      normalizer: normalizeStageSummary,
      validator: validateStageSummary
    });
  } catch {
    return { ...STAGE_FALLBACK };
  }
}

export function getLlmRuntimeConfig() {
  return { ...DEFAULTS };
}

export function __testOnlyRepairJson(text) {
  return repairJson(text);
}
