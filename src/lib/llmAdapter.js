const DEFAULTS = {
  provider: process.env.LLM_PROVIDER || "vllm_openai",
  baseUrl: (process.env.LLM_BASE_URL || "http://100.91.101.3:8003/v1").replace(/\/$/, ""),
  model: process.env.LLM_MODEL || "claude-3-5-sonnet-20241022",
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
  open_questions: ["模型输出不可用，需要人工确认"],
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
  return extractJsonCandidate(text)
    .replace(/```json/giu, "")
    .replace(/```/gu, "")
    .trim();
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
    risk_summary: Array.isArray(payload.risk_summary)
      ? payload.risk_summary.map(normalizeRiskFlag)
      : [],
    next_action: payload.next_action || "pause_review",
    handoff_ready: Boolean(payload.handoff_ready)
  };
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

function buildTurnPrompt(context) {
  return [
    {
      role: "system",
      content:
        "你是同频应用里的 Twin 预沟通代理。你不是用户本人。你只能围绕给定目标议题推进。必须只输出 JSON，不得输出解释文字。敏感问题一旦需要授权，reply 里放原始问题文本，并把 needs_sensitive_approval 设为 true。"
    },
    {
      role: "user",
      content: JSON.stringify(context)
    }
  ];
}

function buildStagePrompt(context) {
  return [
    {
      role: "system",
      content:
        "你负责生成 Twin-Twin 预沟通的阶段总结。必须只输出 JSON，不得输出解释文字。"
    },
    {
      role: "user",
      content: JSON.stringify(context)
    }
  ];
}

async function parseJsonResponse(factory, normalizer) {
  let lastError = null;

  for (let attempt = 0; attempt <= DEFAULTS.maxRetries; attempt += 1) {
    try {
      const rawText = await factory();
      const repaired = repairJson(rawText);
      return normalizer(JSON.parse(repaired));
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export async function generatePrechatTurn(context) {
  try {
    return await parseJsonResponse(
      () => callChatCompletions(buildTurnPrompt(context), { maxTokens: 500 }),
      normalizeTurnPayload
    );
  } catch {
    return { ...TURN_FALLBACK };
  }
}

export async function summarizeStage(context) {
  try {
    return await parseJsonResponse(
      () => callChatCompletions(buildStagePrompt(context), { maxTokens: 500 }),
      normalizeStageSummary
    );
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
