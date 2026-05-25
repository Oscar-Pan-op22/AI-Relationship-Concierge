import crypto from "node:crypto";
import {
  DIMENSION_DEFS,
  PRIORITY_ORDER,
  RISK_RULES,
  SENSITIVE_TOPIC_CATEGORIES
} from "./constants.js";

const CATEGORY_LABELS = Object.fromEntries(
  SENSITIVE_TOPIC_CATEGORIES.map((item) => [item.key, item.label])
);

const STATUS_LABELS = {
  aligned: "匹配",
  mixed: "部分匹配",
  unclear: "待确认",
  conflict: "明显冲突"
};

const SEVERITY_LABELS = {
  high: "高风险",
  medium: "中风险",
  low: "低风险"
};

const PRIORITY_LABELS = {
  high: "高优先级",
  medium: "中优先级",
  low: "低优先级"
};

const SENSITIVITY_LABELS = {
  sensitive: "敏感",
  standard: "常规"
};

const FIT_BAND_LABELS = {
  Hold: "建议放缓",
  Strong: "高度匹配",
  Promising: "值得推进",
  "Needs clarification": "先澄清再推进",
  Weak: "匹配度偏弱"
};

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function asArray(value) {
  return normalizeWhitespace(value)
    .split(/[\n,，、;；]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeText(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function includesAny(text, keywords) {
  return keywords.find((keyword) => text.includes(keyword.toLowerCase())) || null;
}

function uniqueStrings(items) {
  return [...new Set(items.filter(Boolean))];
}

function inferRelationshipGoal(text) {
  const normalized = normalizeText(text);
  if (!normalized) return { value: "unknown", label: "未明确", evidence: "" };
  if (
    includesAny(normalized, [
      "结婚",
      "认真",
      "长期",
      "稳定关系",
      "serious",
      "marriage",
      "long-term"
    ])
  ) {
    return { value: "serious", label: "认真长期 / 以结婚为目标", evidence: text };
  }
  if (includesAny(normalized, ["先聊聊", "随缘", "casual", "see where it goes", "轻松"])) {
    return { value: "exploratory", label: "先了解看看 / 低承诺", evidence: text };
  }
  return { value: "unknown", label: "未明确", evidence: text };
}

function inferTimeline(text) {
  const normalized = normalizeText(text);
  if (!normalized) return { value: "unknown", label: "未明确", evidence: "" };
  if (includesAny(normalized, ["一年内", "尽快结婚", "马上结婚", "within a year"])) {
    return { value: "within_1_year", label: "希望 1 年内", evidence: text };
  }
  if (includesAny(normalized, ["两年内", "1-2年", "一两年", "one to two years"])) {
    return { value: "one_to_two_years", label: "希望 1 到 2 年内", evidence: text };
  }
  if (includesAny(normalized, ["不着急", "随缘", "later", "open ended", "看感觉"])) {
    return { value: "open_ended", label: "节奏开放 / 不着急", evidence: text };
  }
  return { value: "unknown", label: "未明确", evidence: text };
}

function inferChildrenPreference(text) {
  const normalized = normalizeText(text);
  if (!normalized) return { value: "unknown", label: "未明确", evidence: "" };
  if (includesAny(normalized, ["想要孩子", "生育", "要小孩", "want children", "kids"])) {
    return { value: "wants_children", label: "希望未来要孩子", evidence: text };
  }
  if (includesAny(normalized, ["不要孩子", "丁克", "childfree", "no children"])) {
    return { value: "no_children", label: "明确不要孩子", evidence: text };
  }
  if (includesAny(normalized, ["都可以", "再看", "open to it", "later decision"])) {
    return { value: "open", label: "开放 / 暂未决定", evidence: text };
  }
  return { value: "unknown", label: "未明确", evidence: text };
}

function inferFamilyBoundary(text) {
  const normalized = normalizeText(text);
  if (!normalized) return { value: "unknown", label: "未明确", evidence: "" };
  if (includesAny(normalized, ["独立", "小家庭", "边界", "independent", "nuclear family"])) {
    return { value: "independent", label: "偏独立小家庭", evidence: text };
  }
  if (includesAny(normalized, ["和父母住", "父母决定", "听家里", "family-led", "parents involved"])) {
    return { value: "family_led", label: "父母参与度较高", evidence: text };
  }
  return { value: "unknown", label: "未明确", evidence: text };
}

function inferFinancialView(text) {
  const normalized = normalizeText(text);
  if (!normalized) return { value: "unknown", label: "未明确", evidence: "" };
  if (includesAny(normalized, ["理性消费", "稳定", "存钱", "务实", "practical", "stable"])) {
    return { value: "practical", label: "偏务实稳定", evidence: text };
  }
  if (includesAny(normalized, ["高消费", "面子", "奢侈", "luxury", "flashy"])) {
    return { value: "status_spending", label: "偏高消费或面子驱动", evidence: text };
  }
  return { value: "unknown", label: "未明确", evidence: text };
}

function inferCommunicationStyle(text) {
  const normalized = normalizeText(text);
  if (!normalized) return { value: "unknown", label: "未明确", evidence: "" };
  if (includesAny(normalized, ["直接", "坦诚", "直说", "direct", "clear"])) {
    return { value: "direct", label: "直接清晰", evidence: text };
  }
  if (includesAny(normalized, ["稳定回复", "稳定联系", "consistent", "steady"])) {
    return { value: "steady", label: "稳定持续", evidence: text };
  }
  if (includesAny(normalized, ["慢热", "被动", "slow burn", "low frequency"])) {
    return { value: "slow_burn", label: "慢热 / 低频沟通", evidence: text };
  }
  return { value: "unknown", label: "未明确", evidence: text };
}

function inferDimension(key, text) {
  switch (key) {
    case "relationshipGoal":
      return inferRelationshipGoal(text);
    case "marriageTimeline":
      return inferTimeline(text);
    case "childrenPreference":
      return inferChildrenPreference(text);
    case "familyBoundary":
      return inferFamilyBoundary(text);
    case "financialView":
      return inferFinancialView(text);
    case "communicationStyle":
      return inferCommunicationStyle(text);
    default:
      return { value: "unknown", label: "未明确", evidence: text };
  }
}

function inferCityPlan(text, preferredCities) {
  const normalized = normalizeText(text);
  const cities = preferredCities.map((city) => city.toLowerCase());
  const match = cities.find((city) => normalized.includes(city));
  if (match) {
    return { value: match, label: match, evidence: text };
  }
  return { value: "unknown", label: "未明确", evidence: text };
}

function compareInferredValues(userFact, candidateFact) {
  if (!userFact?.value || userFact.value === "unknown") {
    return { status: "unclear", reason: "用户自己的偏好描述还不够明确。" };
  }

  if (!candidateFact?.value || candidateFact.value === "unknown") {
    return { status: "unclear", reason: "候选人现有材料不足，无法下稳定判断。" };
  }

  if (userFact.value === candidateFact.value) {
    return { status: "aligned", reason: "当前证据显示双方在这项维度上比较一致。" };
  }

  const softPairs = new Set([
    "within_1_year|one_to_two_years",
    "one_to_two_years|within_1_year",
    "open|wants_children",
    "wants_children|open",
    "open_ended|one_to_two_years",
    "one_to_two_years|open_ended"
  ]);

  if (softPairs.has(`${userFact.value}|${candidateFact.value}`)) {
    return { status: "mixed", reason: "方向接近，但节奏或确定性仍有差异。" };
  }

  return { status: "conflict", reason: "当前信息显示这项维度存在明显冲突。" };
}

function evaluateMustHaves(userMustHaves, candidateText) {
  const normalizedCandidateText = normalizeText(candidateText);
  const unresolved = [];
  for (const mustHave of userMustHaves) {
    const normalized = mustHave.toLowerCase();
    if (!normalizedCandidateText.includes(normalized)) {
      unresolved.push(mustHave);
    }
  }
  return unresolved;
}

function detectHardStopMatches(hardStops, candidateText) {
  const normalizedCandidateText = normalizeText(candidateText);
  return hardStops.filter((item) => normalizedCandidateText.includes(item.toLowerCase()));
}

function buildRiskSignals(candidateText, candidateProfile, hardStopMatches) {
  const normalized = normalizeText(candidateText);
  const risks = [];

  for (const rule of RISK_RULES) {
    const matchedKeyword = includesAny(normalized, rule.keywords);
    if (matchedKeyword) {
      risks.push({
        code: rule.code,
        label: rule.label,
        severity: rule.severity,
        severityLabel: SEVERITY_LABELS[rule.severity],
        evidence: `命中关键词：${matchedKeyword}`,
        whyItMatters: rule.whyItMatters
      });
    }
  }

  if (!candidateProfile.city || !candidateProfile.occupation || !candidateProfile.relationshipGoal) {
    risks.push({
      code: "incomplete_basics",
      label: "基础信息不完整",
      severity: "low",
      severityLabel: SEVERITY_LABELS.low,
      evidence: "城市、职业或关系目标至少有一项不清晰。",
      whyItMatters: "基础信息过薄，会降低早期判断的可信度。"
    });
  }

  for (const hardStop of hardStopMatches) {
    risks.push({
      code: "hard_stop_overlap",
      label: "可能触碰用户硬性雷区",
      severity: "high",
      severityLabel: SEVERITY_LABELS.high,
      evidence: `候选人材料可能与用户雷区重合：${hardStop}`,
      whyItMatters: "这已触及用户明确声明的不可接受项，继续投入前必须核实。"
    });
  }

  return risks;
}

function makeExtractedFacts(twinProfile, candidateProfile, inferredCandidate, unresolvedMustHaves, hardStopMatches) {
  return {
    twinFacts: [
      { label: "关系目标", value: twinProfile.relationshipGoal || "未明确" },
      { label: "偏好城市", value: twinProfile.cities.join("、") || "未明确" },
      { label: "必须满足项", value: twinProfile.mustHaves.join("、") || "未填写" },
      { label: "硬性雷区", value: twinProfile.hardStops.join("、") || "未填写" },
      { label: "结婚时间预期", value: twinProfile.marriageTimeline || "未明确" },
      { label: "孩子与生育态度", value: twinProfile.childrenPreference || "未明确" }
    ],
    candidateFacts: [
      { label: "候选人名称", value: candidateProfile.displayName || "未命名候选人" },
      { label: "城市", value: candidateProfile.city || "未明确" },
      { label: "职业", value: candidateProfile.occupation || "未明确" },
      { label: "关系目标信号", value: inferredCandidate.relationshipGoal.label },
      { label: "结婚节奏信号", value: inferredCandidate.marriageTimeline.label },
      { label: "孩子态度信号", value: inferredCandidate.childrenPreference.label },
      { label: "沟通风格信号", value: inferredCandidate.communicationStyle.label }
    ],
    unresolvedMustHaves,
    hardStopMatches
  };
}

function computeCompatibilityMatrix(twinProfile, candidateProfile, candidateText) {
  const userFacts = {
    relationshipGoal: inferRelationshipGoal(twinProfile.relationshipGoal),
    cityPlan: {
      value: twinProfile.cities.length ? twinProfile.cities.map((item) => item.toLowerCase()).join("|") : "unknown",
      label: twinProfile.cities.length ? twinProfile.cities.join("、") : "未明确",
      evidence: twinProfile.cities.join("、")
    },
    marriageTimeline: inferTimeline(twinProfile.marriageTimeline),
    childrenPreference: inferChildrenPreference(twinProfile.childrenPreference),
    familyBoundary: inferFamilyBoundary(twinProfile.familyBoundary),
    financialView: inferFinancialView(twinProfile.financialView),
    communicationStyle: inferCommunicationStyle(twinProfile.communicationStyle)
  };

  const candidateFacts = {
    relationshipGoal: inferRelationshipGoal(
      `${candidateProfile.relationshipGoal}\n${candidateProfile.profileText}\n${candidateProfile.notes}`
    ),
    cityPlan: inferCityPlan(`${candidateProfile.city}\n${candidateProfile.profileText}`, twinProfile.cities),
    marriageTimeline: inferTimeline(candidateText),
    childrenPreference: inferChildrenPreference(candidateText),
    familyBoundary: inferFamilyBoundary(candidateText),
    financialView: inferFinancialView(candidateText),
    communicationStyle: inferCommunicationStyle(`${candidateProfile.chatSummary}\n${candidateProfile.notes}`)
  };

  const matrix = DIMENSION_DEFS.map((dimension) => {
    const comparison =
      dimension.key === "cityPlan"
        ? candidateFacts.cityPlan.value === "unknown"
          ? { status: "unclear", reason: "候选人的长期城市规划还不够明确。" }
          : userFacts.cityPlan.value.includes(candidateFacts.cityPlan.value)
            ? { status: "aligned", reason: "候选人所在城市落在用户当前偏好城市范围内。" }
            : { status: "mixed", reason: "候选人的城市与当前偏好城市不完全一致。" }
        : compareInferredValues(userFacts[dimension.key], candidateFacts[dimension.key]);

    return {
      key: dimension.key,
      label: dimension.label,
      weight: dimension.weight,
      sensitive: dimension.sensitive,
      userPosition: userFacts[dimension.key].label,
      candidatePosition: candidateFacts[dimension.key].label,
      status: comparison.status,
      statusLabel: STATUS_LABELS[comparison.status],
      reason: comparison.reason
    };
  });

  return { matrix, userFacts, candidateFacts };
}

function computeCompatibilityScore(matrix) {
  let weightedPoints = 0;
  let totalWeight = 0;

  for (const item of matrix) {
    totalWeight += item.weight;
    if (item.status === "aligned") weightedPoints += item.weight;
    if (item.status === "mixed") weightedPoints += item.weight * 0.6;
    if (item.status === "unclear") weightedPoints += item.weight * 0.45;
  }

  return Math.round((weightedPoints / totalWeight) * 100);
}

function getFitBand(score, risks) {
  const severeRiskCount = risks.filter((risk) => risk.severity === "high").length;
  if (severeRiskCount > 0) return "Hold";
  if (score >= 80) return "Strong";
  if (score >= 65) return "Promising";
  if (score >= 50) return "Needs clarification";
  return "Weak";
}

function buildMissingInformation(matrix, twinProfile, candidateProfile, unresolvedMustHaves) {
  const missing = [];

  for (const item of matrix) {
    if (item.status === "unclear") {
      const priority = ["关系目标", "结婚时间预期", "孩子与生育态度"].includes(item.label)
        ? "high"
        : "medium";
      missing.push({
        dimension: item.label,
        priority,
        priorityLabel: PRIORITY_LABELS[priority],
        reason: item.reason
      });
    }

    if (item.status === "conflict") {
      missing.push({
        dimension: item.label,
        priority: "high",
        priorityLabel: PRIORITY_LABELS.high,
        reason: "这项维度已经出现冲突信号，继续推进前应先明确确认。"
      });
    }
  }

  if (!candidateProfile.age) {
    missing.push({
      dimension: "年龄与人生阶段",
      priority: "medium",
      priorityLabel: PRIORITY_LABELS.medium,
      reason: "候选人的年龄信息还不够清晰。"
    });
  }

  for (const mustHave of unresolvedMustHaves) {
    missing.push({
      dimension: `必须满足项核实：${mustHave}`,
      priority: "medium",
      priorityLabel: PRIORITY_LABELS.medium,
      reason: "现有材料还不能确认这项用户明确要求。"
    });
  }

  return missing.sort((left, right) => {
    return PRIORITY_ORDER.indexOf(left.priority) - PRIORITY_ORDER.indexOf(right.priority);
  });
}

function buildNextSteps(score, risks, missingInformation) {
  const nextSteps = [];
  const highRisks = risks.filter((risk) => risk.severity === "high");

  if (highRisks.length > 0) {
    nextSteps.push("在高风险信号被核实或排除之前，先放缓情绪投入。");
    nextSteps.push("暂时不要推进金钱往来、证件信息交换或脱离平台的高承诺动作。");
  } else if (score >= 75) {
    nextSteps.push("如果剩余关键问题能澄清，这个对象值得继续进行低压力接触。");
  } else if (score >= 55) {
    nextSteps.push("建议先补齐核心兼容性问题，再决定是否安排更高投入的见面。");
  } else {
    nextSteps.push("目前更适合作为探索对象，不建议在冲突未解决前继续加深投入。");
  }

  if (missingInformation.some((item) => item.priority === "high")) {
    nextSteps.push("优先把高优先级问题问清楚，再决定是否继续推进。");
  }

  if (!highRisks.length && score >= 65) {
    nextSteps.push("如果后续回答保持一致，可以考虑安排一次轻量、低压力的见面。");
  }

  return uniqueStrings(nextSteps);
}

function classifyQuestionCategory(dimensionKey) {
  switch (dimensionKey) {
    case "financialView":
      return "finance_and_debt";
    case "familyBoundary":
      return "family_boundaries";
    case "marriageTimeline":
    case "cityPlan":
      return "marriage_and_housing_logistics";
    case "childrenPreference":
      return "fertility_and_children";
    default:
      return null;
  }
}

function makeQuestionDraft(item) {
  switch (item.key) {
    case "relationshipGoal":
      return "我想把彼此节奏先对齐一下，你现在更偏向认真推进长期关系，还是先轻松了解看看？";
    case "cityPlan":
      return "我比较在意之后的城市和生活安排，你对长期在哪个城市发展会比较明确吗？";
    case "marriageTimeline":
      return "想提前把节奏聊清楚一点，如果关系顺利发展，你更希望在什么时间范围内认真考虑结婚？";
    case "childrenPreference":
      return "如果未来关系顺利发展，你对要不要孩子、以及大概什么时候考虑，会有比较明确的想法吗？";
    case "familyBoundary":
      return "我会比较在意两个人和原生家庭之间的边界感，你理想中父母会在多大程度上参与婚后决定？";
    case "financialView":
      return "我比较看重两个人对消费和责任的看法一致，你平时会更偏向稳健规划，还是更重体验和即时消费？";
    case "communicationStyle":
      return "我想确认一下相处节奏，你更喜欢直接说清楚，还是慢慢观察、频率低一点的沟通方式？";
    default:
      return "我想先把关键预期对齐一下，你愿意聊聊这个问题吗？";
  }
}

function buildQuestionPack(matrix, authorizedTopics) {
  const pack = [];

  for (const item of matrix) {
    if (!["unclear", "conflict", "mixed"].includes(item.status)) {
      continue;
    }

    const category = classifyQuestionCategory(item.key);
    const isSensitive = Boolean(category);
    const authorized = !isSensitive || authorizedTopics.includes(category);
    const sensitivity = isSensitive ? "sensitive" : "standard";

    pack.push({
      dimension: item.label,
      sensitivity,
      sensitivityLabel: SENSITIVITY_LABELS[sensitivity],
      topicCategory: category,
      topicLabel: category ? CATEGORY_LABELS[category] : "常规议题",
      allowedByCurrentConsent: authorized,
      draft: makeQuestionDraft(item),
      note: authorized
        ? "当前阶段可以作为手动提问草稿使用。"
        : "这属于敏感议题，但用户当前尚未授权该类别。"
    });
  }

  return pack;
}

function buildSummary(candidateName, fitBand, score, risks, missingInformation) {
  const riskLead =
    risks.filter((risk) => risk.severity === "high").length > 0
      ? "当前存在高风险信号，建议明显放缓推进节奏。"
      : risks.length > 0
        ? "目前存在一些需要留意的风险点，但还不到立即终止的程度。"
        : "从当前材料来看，暂未检测到明显的高风险关键词。";

  const gapLead =
    missingInformation.length > 0
      ? `接下来最需要补齐的是“${missingInformation[0].dimension}”这一项。`
      : "主要核心维度已经有初步覆盖。";

  return `${candidateName || "该候选人"}当前整体判断为“${FIT_BAND_LABELS[fitBand]}”，综合匹配分为 ${score} / 100。${riskLead}${gapLead}`;
}

function normalizeTwinProfile(raw) {
  return {
    displayName: normalizeWhitespace(raw.displayName),
    relationshipGoal: normalizeWhitespace(raw.relationshipGoal),
    cities: asArray(raw.cities),
    mustHaves: asArray(raw.mustHaves),
    hardStops: asArray(raw.hardStops),
    communicationStyle: normalizeWhitespace(raw.communicationStyle),
    marriageTimeline: normalizeWhitespace(raw.marriageTimeline),
    childrenPreference: normalizeWhitespace(raw.childrenPreference),
    familyBoundary: normalizeWhitespace(raw.familyBoundary),
    financialView: normalizeWhitespace(raw.financialView),
    selfSummary: normalizeWhitespace(raw.selfSummary),
    authorizedSensitiveTopics: Array.isArray(raw.authorizedSensitiveTopics)
      ? raw.authorizedSensitiveTopics
      : []
  };
}

function normalizeCandidateProfile(raw) {
  return {
    displayName: normalizeWhitespace(raw.displayName),
    age: normalizeWhitespace(raw.age),
    city: normalizeWhitespace(raw.city),
    occupation: normalizeWhitespace(raw.occupation),
    relationshipGoal: normalizeWhitespace(raw.relationshipGoal),
    profileText: normalizeWhitespace(raw.profileText),
    chatSummary: normalizeWhitespace(raw.chatSummary),
    notes: normalizeWhitespace(raw.notes)
  };
}

export function buildScreeningReport(payload) {
  const twinProfile = normalizeTwinProfile(payload.twinProfile || {});
  const candidateProfile = normalizeCandidateProfile(payload.candidateProfile || {});
  const candidateText = normalizeWhitespace(
    [
      candidateProfile.city,
      candidateProfile.occupation,
      candidateProfile.relationshipGoal,
      candidateProfile.profileText,
      candidateProfile.chatSummary,
      candidateProfile.notes
    ].join("\n")
  );

  const { matrix, candidateFacts } = computeCompatibilityMatrix(
    twinProfile,
    candidateProfile,
    candidateText
  );
  const unresolvedMustHaves = evaluateMustHaves(twinProfile.mustHaves, candidateText);
  const hardStopMatches = detectHardStopMatches(twinProfile.hardStops, candidateText);
  const risks = buildRiskSignals(candidateText, candidateProfile, hardStopMatches);
  const score = computeCompatibilityScore(matrix);
  const fitBand = getFitBand(score, risks);
  const missingInformation = buildMissingInformation(
    matrix,
    twinProfile,
    candidateProfile,
    unresolvedMustHaves
  );
  const nextSteps = buildNextSteps(score, risks, missingInformation);
  const questionPack = buildQuestionPack(matrix, twinProfile.authorizedSensitiveTopics);
  const extractedFacts = makeExtractedFacts(
    twinProfile,
    candidateProfile,
    candidateFacts,
    unresolvedMustHaves,
    hardStopMatches
  );

  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    phase: "phase_1_due_diligence",
    twinProfile,
    candidateProfile,
    summary: buildSummary(candidateProfile.displayName, fitBand, score, risks, missingInformation),
    compatibilityScore: score,
    fitBand,
    fitBandLabel: FIT_BAND_LABELS[fitBand],
    compatibilityMatrix: matrix,
    riskSignals: risks,
    missingInformation,
    nextSteps,
    questionPack,
    extractedFacts
  };
}
