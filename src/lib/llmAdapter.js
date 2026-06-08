import {
  getSensitiveTopicKeys,
  getStageNextActionValues,
  getTurnRecommendationValues,
  validateManualQuestionClassification,
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

export const TURN_PROMPT_VERSION = "turn_cn_v14_2026_06_05";
export const STAGE_PROMPT_VERSION = "stage_cn_v3_counterparty_2026_06_08";
export const MANUAL_QUESTION_PROMPT_VERSION = "manual_question_cn_v1_2026_05_29";

const TURN_FALLBACK = {
  reply: "",
  reply_topic_key: null,
  question_topic_key: null,
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
  recommendation: "pause_review",
  model_output_failure: {
    kind: "turn_fallback",
    reason: "model_output_unstable"
  }
};

const STAGE_FALLBACK = {
  summary: "模型总结不可用，需要人工确认。",
  confirmed_facts: [],
  unresolved_questions: ["模型总结不可用，需要人工确认。"],
  risk_summary: [],
  next_action: "pause_review",
  handoff_ready: false,
  summary_by_role: null
};

const MANUAL_QUESTION_FALLBACK = {
  is_question: false,
  question_text: null,
  question_topic: null,
  can_answer_from_context: false,
  needs_sensitive_approval: false,
  sensitive_topic_category: null,
  needs_human_input: false,
  human_input_question: null
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
    reply_topic_key: String(payload.reply_topic_key || "").trim() || null,
    question_topic_key: String(payload.question_topic_key || "").trim() || null,
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
    handoff_ready: Boolean(payload.handoff_ready),
    summary_by_role:
      payload.summary_by_role && typeof payload.summary_by_role === "object"
        ? {
            initiator: String(payload.summary_by_role.initiator || "").trim() || null,
            counterparty: String(payload.summary_by_role.counterparty || "").trim() || null
          }
        : null
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
    reply: "字符串。必须是自然、简洁的简体中文完整句；如果 recommendation=continue，则 reply 不能为空。",
    reply_topic_key: "字符串或 null。表示本条 reply 主要在回答或推进哪个 topic，只允许 relationshipGoal / cities / marriageTimeline / childrenPreference / familyBoundary / financialView / unknown。",
    question_topic_key: "字符串或 null。若 reply 里包含一个新的追问，写这个追问对应的 topic；没有新追问就写 null。",
    is_sensitive_question: "布尔值。",
    sensitive_topic_category: `字符串或 null。只允许这些值：${getSensitiveTopicKeys().join("、")}`,
    needs_sensitive_approval: "布尔值。如果为 true，就把待审批的敏感问题原样写进 reply。",
    target_user_for_approval: "字符串或 null。常见值：listener / counterparty / self。",
    confirmed_facts: [
      {
        subjectUserId: "self | listener | 实际 user id",
        key: "事实字段名，例如 relationshipGoal",
        value: "事实内容",
        confidence: "0 到 1 的数字",
        status: "confirmed"
      }
    ],
    open_questions: ["还没有确认清楚的问题"],
    risk_flags: [
      {
        type: "风险类型，例如 money_request",
        severity: "low | medium | high",
        reason: "风险解释"
      }
    ],
    needs_human_input: {
      required: "布尔值。",
      field: "如果 required=true，写缺失字段名。",
      question: "如果 required=true，写需要向真人展示的具体问题。",
      target_user_for_input: "self | listener | counterparty"
    },
    recommendation: `只允许这些值：${getTurnRecommendationValues().join(" | ")}`
  };

  const answerThenAskExample = {
    reply:
      "在财务安排上，我更看重务实稳定，也会留意负债风险。婚后和父母的相处边界上，你更偏向怎样的安排？",
    reply_topic_key: "financialView",
    question_topic_key: "familyBoundary",
    is_sensitive_question: false,
    sensitive_topic_category: null,
    needs_sensitive_approval: false,
    target_user_for_approval: null,
    confirmed_facts: [
      {
        subjectUserId: "self",
        key: "financialView",
        value: "更看重务实稳定，也会留意负债风险",
        confidence: 0.9,
        status: "confirmed"
      }
    ],
    open_questions: ["婚后和父母的相处边界"],
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
    reply: "你好，我是雨涵的 Twin。看到我们都更重视认真长期关系，我想先确认一下，你现在更明确想进入怎样的长期关系？",
    reply_topic_key: "relationshipGoal",
    question_topic_key: "relationshipGoal",
    is_sensitive_question: false,
    sensitive_topic_category: null,
    needs_sensitive_approval: false,
    target_user_for_approval: null,
    confirmed_facts: [],
    open_questions: ["对方更明确想进入怎样的长期关系"],
    risk_flags: [],
    needs_human_input: {
      required: false,
      field: null,
      question: null,
      target_user_for_input: null
    },
    recommendation: "continue"
  };

  const badExamples = [
    "错误例：把对方的问题原样复述一遍，例如『你未来更倾向在上海还是杭州生活？』。",
    "错误例：对方上一条已经在提问，但你只说『你好，我是刘宇的 Twin。我想先确认一下，你未来更倾向长期在深圳还是广州生活？』，中间没有先回答对方问题。",
    "错误例：先完整寒暄或背景说明，再去回答问题，例如『你好，我是刘宇的 Twin。看到我们都很认真，我也想先了解一下……』之后才回答。",
    "错误例：整段会话已经出现过 Twin 消息后，又重复说『你好，我是沈特的 Twin。』。",
    "错误例：非首条 Twin 消息里先自我介绍再回答，例如『你好，我是沈特的 Twin。我这边更倾向上海。』。",
    "错误例：跨 round、恢复后或普通往返里再次说『我是X的 Twin』。",
    "错误例：把对方刚问的城市问题改写成自己的问题再问回去，例如『我想先确认一下，你未来更倾向长期在深圳还是广州生活？』。",
    "错误例：双方都已经表达过同一个 topic 的核心答案后，又把同一题换句话再问一次。",
    "错误例：当前 topic 在这条回复后已经足够关闭，却还继续追问同一个 topic。",
    "错误例：直接把原始字段硬拼成病句，例如『我这边长期更倾向在我可以接受生活。』。",
    "错误例：把半结构化片段直接塞进模板，例如『关系目标上，我这边是认真长期关系，希望以结婚为目标。你这边是？』。",
    "错误例：把不是城市的片段塞进『在X生活』，例如『我长期更倾向在我可以接受杭州生活。』。",
    "错误例：把片段当完整回答，例如『婚姻节奏上，我这边是认真长期关系，希望。』。",
    "错误例：把寒暄或即时印象写成婚姻节奏，例如『如果关系稳定，我更偏向按哈喽，感觉你很不错的节奏推进结婚。』。",
    "错误例：刚回答完又重复同一个问题，例如『我希望两年内推进结婚。你觉得结婚节奏呢？你更接受怎样的结婚节奏？』。"
  ];

  const goodExamples = [
    {
      topic: "financialView",
      naturalAnswerHint: "我在财务安排上更看重务实稳定，也不太接受隐性负债。",
      goodReply: "我在财务安排上更看重务实稳定，也不太接受隐性负债。婚后和父母的相处边界上，你更偏向怎样的安排？"
    },
    {
      topic: "childrenPreference",
      naturalAnswerHint: "如果关系稳定，我希望未来要孩子。",
      goodReply: "如果关系稳定，我希望未来要孩子。婚后更希望和父母保持怎样的边界？"
    },
    {
      topic: "childrenPreference",
      naturalAnswerHint: "关于孩子这件事，我目前倾向于未来要孩子。",
      goodReply: "关于孩子这件事，我目前倾向于未来要孩子。你这边对未来要不要孩子这件事，目前更偏向什么想法？"
    },
    {
      topic: "relationshipGoal",
      naturalAnswerHint: "我希望进入认真、长期的关系，也希望关系稳定后以结婚为目标。",
      goodReply: "我希望进入认真、长期的关系，也希望关系稳定后以结婚为目标。你未来更倾向长期在哪个城市生活？"
    }
  ];
  const turnFrameGuide = {
    reply_obligation: "listener_question | manual_question | carryover_twin_question | none。表示这条消息是否必须先回答一个已存在的问题。",
    reply_target: {
      text: "当前必须先回答的问题文本；没有就为 null。",
      topicKey: "当前必须先回答的问题 topic；没有就为 null。",
      askedByUserId: "提出这个必须先回答问题的用户。",
      sourceTurnId: "若来自上一条或 carryover，写来源 turn id。"
    },
    topic_plan: {
      activeTopicKey: "当前必须优先推进的 topic。",
      activeTopicState: "当前 topic ledger 状态。",
      canSwitchOnlyAfterClose: "固定视为 true。只有当前 topic 在本条后可关闭时，才允许切下一题。",
      nextCandidateTopicKey: "若当前 topic 可关闭，允许切入的下一个 topic。",
      closedTopicKeys: "已经关闭的 topic。",
      forbiddenTopicKeys: "当前这条回复绝对不能再问的 topic。"
    },
    answer_material: {
      topicKey: "当前最优回答素材对应的 topic。",
      source: "listener_question | manual_question | carryover_twin_question | active_topic | explicit_card。",
      normalizedSummary: "结构化摘要。",
      naturalAnswerHint: "可直接说出口的自然答案提示。"
    },
    recent_context: {
      recentQuestionFingerprints: "最近问题的归一指纹，用于识别重复 broad question。",
      recentlyConfirmedTopics: "最近确认完成的 topic。",
      unresolvedTwinQuestion: "最近还未闭合的 twin 问题。",
      latestResolvedTopic: "最近完成的 topic。"
    },
    conversation_rules: {
      isFirstTwinMessage: "是否为整段会话的第一条 Twin 消息。",
      maxFollowupQuestions: "固定为 1。",
      allowIdentityIntroOnce: "固定为 true。"
    }
  };

  return [
    {
      role: "system",
      content: [
        "你是同频里的 Twin-Twin 预沟通代理，只代表当前说话方的数字分身，不是用户本人。",
        `当前 turn prompt 版本：${TURN_PROMPT_VERSION}。`,
        "所有 reply 必须写成自然、完整、简洁的简体中文句子。",
        "本轮必须以 turn_frame 作为单一语义真相来决定如何说话。",
        "规则优先级固定为：1. 先满足 turn_frame.reply_obligation；2. 再判断 turn_frame.topic_plan.activeTopicKey 是否在本条后可关闭；3. 只有可关闭时才允许切 turn_frame.topic_plan.nextCandidateTopicKey；4. 全程最多一个新问题。",
        "默认对话策略：先回答必须先回答的那一题，再最多推进一个新的追问。",
        "只有整段会话里的第一条 Twin 消息允许带一次极短身份说明，例如『你好，我是刘星的 Twin。』。",
        "如果 conversation_state.is_first_twin_message=true，reply 开头必须先用一句极短身份说明，然后立刻进入内容，不允许寒暄扩写。",
        "如果当前是 opening，且 active_topic=relationshipGoal，首条消息必须先围绕 relationshipGoal 发起确认，不要直接把问题切到 cities、marriageTimeline 或别的 topic。",
        "如果 conversation_state.is_first_twin_message=false，禁止再次出现『你好，我是X的 Twin』『我是X的 Twin』『这里是X的 Twin』这类身份说明。",
        "如果 conversation_state.latest_turn_from_listener=true 且 conversation_state.latest_turn_is_question=true，那么 reply 的第一完整句必须先正面回答那个问题，不能直接进入你自己的新问题。",
        "如果 turn_frame.reply_obligation=listener_question / manual_question / carryover_twin_question，那么 reply 第一完整句必须先回答 turn_frame.reply_target.text，active_topic 不能覆盖这条义务。",
        "只有在 conversation_state.is_first_twin_message=true 时，上一条来自对方且是问题的场景才允许先用一句非常短的身份说明开头；否则必须直接回答。",
        "如果上一条来自对方且是问题，不允许只做身份说明就直接发起自己的问题；必须先回答，再最多追问一个新的问题。",
        "如果上一条来自对方且是问题，不允许把对方的问题改写后问回去，代替真正回答。",
        "如果 manual_question_mode=true，那么 reply 的第一句必须先直接回答 manual_question_text，不能跳过，也不能先转去问别的议题。",
        "如果 manual_question_mode=true 且现有 context 不足以安全回答，就必须设置 needs_human_input.required=true，不要猜测。",
        "如果 carryover_twin_question_mode=true，那么 reply 的第一句必须先直接回答 carryover_twin_question_text，不能跳过，也不能先转去问别的议题。",
        "如果 carryover_twin_question_mode=true 且现有 context 不足以安全回答，就必须设置 needs_human_input.required=true，不要猜测。",
        "如果 active_topic 存在，你这一条回复必须先处理 active_topic。",
        "如果 active_topic 尚未关闭，而你准备追加一个新问题，那么 question_topic_key 只能等于 active_topic。",
        "只有当当前 active_topic 在这条回复后已经足够关闭时，才允许把 follow-up question 切到 next_candidate_topic_key。",
        "如果当前 active_topic 在这条回复后已经足够关闭，禁止继续追问同一个 active_topic。",
        "如果当前 active_topic 在这条回复后已经足够关闭，允许自然切到 next_candidate_topic_key；这不算跳题。",
        "如果当前 broad topic 只完成了一侧回答，而 turn_frame.reply_obligation 正在要求你回答这个 topic，那么允许在回答后把同一个 broad topic 合法问回去一次，以补齐另一侧确认；这不算重复问答。",
        "只有当同一个 broad topic 双方都已经确认，或同一 speaker 已经问过且对方没有新回答时，才把 same-topic broad question 视为重复。",
        "禁止询问 closed_topic_keys 或 forbidden_topic_keys 里的任何 topic。",
        "reply_topic_key 和 question_topic_key 必须和你实际说的话一致，不能随便填。",
        "reply_topic_key 只描述回答段真正回答的是哪个 topic；question_topic_key 只描述最后那个追问对应的 topic。",
        "如果回答的是 A、最后追问的是 B，那么 reply_topic_key 必须是 A，question_topic_key 必须是 B，open_questions 也必须与最后那个问题文本一致。",
        "如果最终 reply 被重写成只有一个问题、没有回答段，那么 reply_topic_key 必须写 null，confirmed_facts 也必须为空。",
        "如果最终 reply 只有『你好，我是X的 Twin。』这一类身份说明再接一个问题，身份说明不算回答段；reply_topic_key 必须写 null，confirmed_facts 也必须为空。",
        "如果最终 reply 的问题文本被改写了，question_topic_key 和 open_questions 必须同时改成与最终问题完全一致的内容。",
        "如果最终 reply 只保留了回答段 topic=A，那么 confirmed_facts 里只允许保留 topic=A 的事实；不能残留别的 topic 的事实。",
        "如果某个 topic 已经在 closed_topic_keys 或 forbidden_topic_keys 里，绝对不能再问，哪怕你觉得换一种措辞也不行。",
        "错误例：文案最后在问『你现在更明确想进入怎样的长期关系？』，却把 question_topic_key 写成 cities。",
        "错误例：文案在回答城市偏好，却把 reply_topic_key 写成 relationshipGoal。",
        "错误例：最终 reply 里没有那个问题了，但 open_questions 还保留旧问题。",
        "错误例：最终文案只剩『你现在更明确想进入怎样的长期关系？』，reply_topic_key 却还是 marriageTimeline，confirmed_facts 也还是 financialView。",
        "错误例：cities 已经 closed，却又重新问『你这边未来长期更倾向在哪个城市生活？』。",
        "错误例：opening 的 active_topic 是 relationshipGoal，却直接问『看到我们都以认真长期关系为目标，我想先确认一下，你未来更倾向长期在上海还是杭州生活？』。",
        "禁止镜像复述、禁止原地复问、禁止重复自我介绍、禁止把对方刚问的问题改写后再问回去。",
        "禁止把字段值直接套进固定模板；如果原始值像备注、片段或半句，必须先整理成自然中文，再决定是否回答或追问。",
        "禁止把 rawValue、normalizedSummary、naturalAnswerHint 的局部片段硬拼进句子壳里，例如不能把『我可以接受…』『认真长期关系，希望…』『住得近』直接塞进固定模板。",
        "禁止输出『在X生活』这类句式，除非 X 明确是城市或地点名；如果 X 只是态度片段、偏好片段或半句话，必须改写。",
        "禁止把半结构化字段拼成缺主语、缺宾语、缺谓语的半句；宁可改写成完整自然句，也不要保留原始碎片。",
        "回答时优先参考 speaker_fact_cards 里的 normalizedSummary 和 naturalAnswerHint，不要生硬复读 rawValue。",
        "如果 speaker_fact_cards 里有 naturalAnswerHint，优先把它当作可直接说出口的答案，再决定是否追加一个新问题。",
        "如果当前 topic 的 speaker_fact_cards 没有可安全说出口的 naturalAnswerHint，不要自己套模板硬答；要么改写成更安全的泛化表达，要么触发 needs_human_input。",
        "如果 suggested_answer_material 可用，优先用它先把对方刚才的问题回答完整，然后再决定是否追加一个 follow-up question。",
        "优先读取 turn_frame.answer_material，不要让 active_topic 抢走对 turn_frame.reply_target 的回答优先级。",
        "写 confirmed_facts 时，value 必须是 topic-正确的事实，不要把寒暄、即时印象、聊天废话写成 marriageTimeline、relationshipGoal 等结构化事实。",
        "如果 recent_turns 里已经出现过同样的问法，就换到下一个未解决点，不要重复原句。",
        "一条 reply 最多只允许包含一个新问题。",
        "如果当前说话方缺少必要事实，就设置 needs_human_input.required=true，不要猜。",
        "如果下一个问题属于敏感问题，就把待审批的问题原样写进 reply，并设置 needs_sensitive_approval=true。",
        "只输出一个 JSON 对象；不要输出 markdown，不要输出解释文字，不要输出思维链。",
        "你会收到 turn_frame，它比 flat fields 更重要；当 turn_frame 与其他平铺字段看起来有冲突时，以 turn_frame 为准。",
        "你会收到这些关键上下文字段：",
        "- turn_frame：这条消息的 canonical context frame，是最重要的决策输入。",
        "- conversation_state：会话是否开始、上一条是否来自对方、上一条是否是问题。",
        "- conversation_state.is_first_twin_message：是否为整段会话中的第一条 Twin 消息；只有这时允许一次性身份介绍。",
        "- speaker_fact_cards：当前说话方可安全引用的事实卡片。",
        "- listener_fact_cards：对方已知事实卡片。",
        "- latest_listener_question_topic：对方上一条问题最可能对应的议题。",
        "- suggested_answer_material：优先用于这次回答的事实素材。",
        "- active_topic / active_topic_state：当前必须优先推进的唯一议题，以及它当前等待哪一侧回答。",
        "- closed_topic_keys：已经双边确认、当前禁止重开的议题。",
        "- forbidden_topic_keys：当前这条回复绝对不能问的议题。",
        "- next_candidate_topic_key：若当前议题已关闭，允许切入的下一个候选议题。",
        "- manual_question_mode / manual_question_text：真人消息里明确抛出的待回答问题。",
        "- carryover_twin_question_mode / carryover_twin_question_text：上一轮 Twin 留下、当前必须先回答的问题。",
        "turn_frame 结构说明：",
        JSON.stringify(turnFrameGuide, null, 2),
        "frame-first 正例：上一条问 marriageTimeline，当前先回答结婚节奏，再在当前 topic 可关闭后切 childrenPreference：",
        JSON.stringify(
          {
            turn_frame: {
              reply_obligation: "listener_question",
              reply_target: {
                text: "你希望多久内考虑结婚？",
                topicKey: "marriageTimeline"
              },
              topic_plan: {
                activeTopicKey: "marriageTimeline",
                canSwitchOnlyAfterClose: true,
                nextCandidateTopicKey: "childrenPreference"
              }
            },
            output: {
              reply: "如果关系稳定，我会希望在两年左右认真考虑结婚。关于孩子这件事，你未来更倾向怎样的安排？",
              reply_topic_key: "marriageTimeline",
              question_topic_key: "childrenPreference"
            }
          },
          null,
          2
        ),
        "frame-first 正例：上一条问 childrenPreference，当前先回答要不要孩子；如果这条后 childrenPreference 已闭合，再自然切 familyBoundary：",
        JSON.stringify(
          {
            turn_frame: {
              reply_obligation: "listener_question",
              reply_target: {
                text: "你对未来要不要孩子这件事，目前更偏向什么想法？",
                topicKey: "childrenPreference"
              },
              topic_plan: {
                activeTopicKey: "childrenPreference",
                canSwitchOnlyAfterClose: true,
                nextCandidateTopicKey: "familyBoundary"
              }
            },
            output: {
              reply: "关于孩子这件事，我目前倾向于未来要孩子。婚后和父母的相处边界上，你更偏向怎样的安排？",
              reply_topic_key: "childrenPreference",
              question_topic_key: "familyBoundary"
            }
          },
          null,
          2
        ),
        "frame-first 正例：active_topic=relationshipGoal，但 reply_obligation=cities 时，必须先答 cities，不能被 active_topic 覆盖：",
        JSON.stringify(
          {
            turn_frame: {
              reply_obligation: "listener_question",
              reply_target: {
                text: "你未来更倾向长期在哪个城市生活？",
                topicKey: "cities"
              },
              topic_plan: {
                activeTopicKey: "relationshipGoal",
                canSwitchOnlyAfterClose: true,
                nextCandidateTopicKey: "financialView"
              }
            },
            output: {
              reply: "我长期更倾向留在杭州，如果机会合适也能接受上海。等这个问题说清后，我也想进一步确认你现在更明确想进入怎样的长期关系？",
              reply_topic_key: "cities",
              question_topic_key: "relationshipGoal"
            }
          },
          null,
          2
        ),
        "frame-first 反例：上一条问 marriageTimeline，却回答 financialView。",
        "frame-first 反例：当前 topic 已经足够关闭，却把同一个 topic 换句话再问一次。",
        "frame-first 反例：上一条问 childrenPreference，当前已经明确回答要孩子，却因为 active_topic 还没显式关闭就把 familyBoundary 追问删掉。",
        "frame-first 反例：文案被 rewrite 成只有问题，但 metadata 还残留旧 topic 或旧 facts。",
        "frame-first 反例：双方都已经表达过 childrenPreference 后，还继续问『关于孩子这件事，你未来更倾向怎样的安排？』。",
        ...badExamples,
        "以下是把 naturalAnswerHint 直接用成自然中文回答的正例：",
        JSON.stringify(goodExamples, null, 2),
        "输出 JSON 结构如下：",
        JSON.stringify(schemaGuide, null, 2),
        "先回答、再推进一个新问题的正例：",
        JSON.stringify(answerThenAskExample, null, 2),
        "仅适用于首轮开场的正例：",
        JSON.stringify(openingExample, null, 2)
      ].join("\n")
    },
    {
      role: "user",
      content: [
        "下面是完整的本轮上下文 JSON。",
        "请基于这些上下文直接生成一个符合规则的 JSON 对象。",
        "如果你准备说的话已经在 recent_turns 里出现过，请先回答，再换到新的未解决点继续推进。",
        JSON.stringify(context, null, 2)
      ].join("\n")
    }
  ];
}

function buildStagePrompt(context) {
  const schemaGuide = {
    summary: "字符串。用简体中文按“议题：结论；议题：结论”的格式总结“对方用户”目前已经确认的画像信息，不要总结双方互动流程。",
    summary_by_role: {
      initiator: "字符串。站在 initiator 用户视角看到的‘对方总结’，只能写 counterparty 用户，格式必须是“议题：结论；议题：结论”。",
      counterparty: "字符串。站在 counterparty 用户视角看到的‘对方总结’，只能写 initiator 用户，格式必须是“议题：结论；议题：结论”。"
    },
    confirmed_facts: [
      {
        subjectUserId: "self | listener | 实际 user id",
        key: "事实字段名",
        value: "事实内容",
        confidence: "0 到 1 的数字",
        status: "confirmed"
      }
    ],
    unresolved_questions: ["仍未确认清楚的问题"],
    risk_summary: [
      {
        type: "风险类型",
        severity: "low | medium | high",
        reason: "风险解释"
      }
    ],
    next_action: `只允许这些值：${getStageNextActionValues().join(" | ")}`,
    handoff_ready: "布尔值。"
  };

  const example = {
    summary: "关系目标：认真长期关系；结婚节奏：关系稳定后倾向 1 到 2 年内推进。",
    summary_by_role: {
      initiator: "关系目标：认真长期关系；结婚节奏：关系稳定后倾向 1 到 2 年内推进。",
      counterparty: "关系目标：认真长期关系；结婚节奏：关系稳定后倾向 1 到 2 年内推进。"
    },
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
        "你负责生成‘对方用户总结’，不是流程总结。",
        `当前 stage prompt 版本：${STAGE_PROMPT_VERSION}。`,
        "必须只输出一个 JSON 对象，且所有自然语言内容都用简洁的简体中文。",
        "禁止在 summary、unresolved_questions、risk_summary.reason 中出现 Initiator、Counterparty、self、listener 这类英文角色标签。",
        "summary 和 summary_by_role 只能总结给定 frame 中的对方用户，禁止写双方互动、系统状态、暂停原因、回合进展、风险流程。",
        "summary 和 summary_by_role 必须统一使用“议题：结论；议题：结论”的格式，不要写自然段概述。",
        "禁止补充 frame 里没有的事实；未知项只能写进 unresolved_questions，不能写进 summary。",
        "如果需要指代双方，只能使用中文表达，例如“你 / 对方”或“发起方 / 另一方”。",
        "不要输出 markdown，不要输出 JSON 之外的解释文字。",
        "输出 JSON 结构如下：",
        JSON.stringify(schemaGuide, null, 2),
        "示例：",
        JSON.stringify(example, null, 2)
      ].join("\n")
    },
    {
      role: "user",
      content: ["下面是本轮上下文 JSON。请直接返回一个 JSON 对象。", JSON.stringify(context, null, 2)].join("\n")
    }
  ];
}

function buildManualQuestionPrompt(context) {
  const schemaGuide = {
    is_question: "布尔值。判断这条真人消息是否在向对方提问。",
    question_text: "字符串或 null。如果 is_question=true，提炼出需要回答的核心问题。",
    question_topic:
      "字符串或 null。只允许这些值：relationshipGoal | cities | marriageTimeline | childrenPreference | familyBoundary | financialView | unknown",
    can_answer_from_context: "布尔值。仅当现有 context 足够让对方 Twin 直接回答时才为 true。",
    needs_sensitive_approval: `布尔值。如果这条真人问题属于敏感问题，且需要先审批才允许回答，则为 true。敏感类别只允许：${getSensitiveTopicKeys().join("、")}`,
    sensitive_topic_category: "字符串或 null。若 needs_sensitive_approval=true，必须填写对应敏感类别。",
    needs_human_input: "布尔值。如果现有 context 不足，且需要被问方本人补充后才能回答，则为 true。",
    human_input_question: "字符串或 null。如果 needs_human_input=true，写成可以直接展示给被问方本人的自然中文问题。"
  };

  const exampleQuestion = {
    is_question: true,
    question_text: "你未来更倾向长期在哪个城市生活？",
    question_topic: "cities",
    can_answer_from_context: true,
    needs_sensitive_approval: false,
    sensitive_topic_category: null,
    needs_human_input: false,
    human_input_question: null
  };

  const exampleNeedsHumanInput = {
    is_question: true,
    question_text: "你希望多久内考虑结婚？",
    question_topic: "marriageTimeline",
    can_answer_from_context: false,
    needs_sensitive_approval: false,
    sensitive_topic_category: null,
    needs_human_input: true,
    human_input_question: "请直接说明你希望多久内考虑结婚。"
  };

  const exampleNotQuestion = {
    is_question: false,
    question_text: null,
    question_topic: null,
    can_answer_from_context: false,
    needs_sensitive_approval: false,
    sensitive_topic_category: null,
    needs_human_input: false,
    human_input_question: null
  };

  return [
    {
      role: "system",
      content: [
        "你负责理解 Twin-Twin 预沟通中的真人消息。",
        `当前 manual question prompt 版本：${MANUAL_QUESTION_PROMPT_VERSION}。`,
        "你的任务只有一个：判断这条真人消息是不是在向对方提问；如果是，再判断现有上下文是否足够让对方 Twin 直接回答。",
        "不要替对方真的生成回答内容；这里只做分类和分流判断。",
        "如果不是问题，is_question=false，其他字段尽量置空或 false。",
        "如果是问题，但问题涉及敏感类别，则 needs_sensitive_approval=true。",
        "如果是问题，但现有上下文不足以安全回答，则 needs_human_input=true，并为被问方本人生成一条可以直接看到的补充问题。",
        "只输出一个 JSON 对象；不要输出 markdown，不要输出解释。",
        "输出 JSON 结构如下：",
        JSON.stringify(schemaGuide, null, 2),
        "问题且可回答示例：",
        JSON.stringify(exampleQuestion, null, 2),
        "问题但需要本人补充示例：",
        JSON.stringify(exampleNeedsHumanInput, null, 2),
        "不是问题示例：",
        JSON.stringify(exampleNotQuestion, null, 2)
      ].join("\n")
    },
    {
      role: "user",
      content: ["下面是这条真人消息及其上下文 JSON。请直接返回一个 JSON 对象。", JSON.stringify(context, null, 2)].join("\n")
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

async function parseJsonResponse({ requestType, promptVersion, factory, normalizer, validator, telemetry = {} }) {
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
        prompt_version: promptVersion,
        started_at: startedAt,
        duration_ms: Date.now() - startedMs,
        attempt_count: attemptCount,
        used_repair: usedRepair,
        used_fallback: false,
        success: true,
        error_type: null,
        reply_quality_issue: null,
        rewrite_applied: false,
        rewrite_reason: null,
        rewrite_failed: false,
        ...telemetry
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
    prompt_version: promptVersion,
    started_at: startedAt,
    duration_ms: Date.now() - startedMs,
    attempt_count: attemptCount,
    used_repair: usedRepair,
    used_fallback: true,
    success: false,
    error_type: classifyError(lastError),
    reply_quality_issue: null,
    rewrite_applied: false,
    rewrite_reason: null,
    rewrite_failed: false,
    ...telemetry
  });

  throw lastError;
}

export async function generatePrechatTurn(context) {
  try {
    return await parseJsonResponse({
      requestType: "turn",
      promptVersion: TURN_PROMPT_VERSION,
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
      promptVersion: STAGE_PROMPT_VERSION,
      factory: () => callChatCompletions(buildStagePrompt(context), { maxTokens: 500 }),
      normalizer: normalizeStageSummary,
      validator: validateStageSummary
    });
  } catch {
    return { ...STAGE_FALLBACK };
  }
}

export async function classifyManualQuestion(context) {
  try {
    return await parseJsonResponse({
      requestType: "manual_question_classification",
      promptVersion: MANUAL_QUESTION_PROMPT_VERSION,
      factory: () => callChatCompletions(buildManualQuestionPrompt(context), { maxTokens: 260 }),
      normalizer: (payload) => ({
        is_question: Boolean(payload.is_question),
        question_text: String(payload.question_text || "").trim() || null,
        question_topic: payload.question_topic || null,
        can_answer_from_context: Boolean(payload.can_answer_from_context),
        needs_sensitive_approval: Boolean(payload.needs_sensitive_approval),
        sensitive_topic_category: payload.sensitive_topic_category || null,
        needs_human_input: Boolean(payload.needs_human_input),
        human_input_question: String(payload.human_input_question || "").trim() || null
      }),
      validator: validateManualQuestionClassification
    });
  } catch {
    return { ...MANUAL_QUESTION_FALLBACK };
  }
}

export function getLlmRuntimeConfig() {
  return { ...DEFAULTS };
}

export function __testOnlyRepairJson(text) {
  return repairJson(text);
}

export function __testOnlyBuildTurnPrompt(context) {
  return buildTurnPrompt(context);
}

export function __testOnlyBuildManualQuestionPrompt(context) {
  return buildManualQuestionPrompt(context);
}
