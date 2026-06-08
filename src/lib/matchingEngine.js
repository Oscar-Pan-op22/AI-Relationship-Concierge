import crypto from "node:crypto";
import {
  CANDIDATE_RISK_DEFS,
  DIMENSION_DEFS,
  PRIORITY_LABELS,
  PRIORITY_ORDER,
  REALITY_FIELD_DEFS,
  REALITY_MODE_LABELS,
  REALITY_OPTION_LABELS,
  REPORT_BAND_LABELS,
  SENSITIVE_TOPIC_CATEGORIES,
  STATUS_LABELS,
  VALUE_LABELS
} from "./constants.js";
import { MOCK_CANDIDATE_POOL } from "./mockCandidatePool.js";

export const REPORT_SCHEMA_VERSION = 6;

const CATEGORY_LABELS = Object.fromEntries(
  SENSITIVE_TOPIC_CATEGORIES.map((item) => [item.key, item.label])
);

const BAND_RANK = {
  hold: 0,
  weak: 1,
  "needs-clarification": 2,
  promising: 3,
  strong: 4
};

const LEGACY_TEXT_REPLACEMENTS = [
  ["銆", "、"],
  ["锛", "，"],
  ["璁ょ湡", "认真"],
  ["闀挎湡", "长期"],
  ["缁撳", "结婚"],
  ["鍏崇郴", "关系"],
  ["鍏堜簡瑙", "先了解"],
  ["闅忕紭", "随缘"],
  ["鎯宠瀛╁瓙", "想要孩子"],
  ["鐙珛灏忓搴", "独立小家庭"],
  ["鐖舵瘝", "父母"],
  ["鍔″疄", "务实"],
  ["绋冲畾", "稳定"],
  ["娑堣垂", "消费"],
  ["鐩存帴", "直接"],
  ["鍧﹁瘹", "坦诚"],
  ["鏄庣‘", "明确"],
  ["涓€骞村唴", "一年内"],
  ["涓€鍒", "一到"],
  ["涓ゅ勾鍐", "两年内"],
  ["涓婃捣", "上海"],
  ["鏉窞", "杭州"],
  ["娣卞湷", "深圳"],
  ["鑻忓窞", "苏州"],
  ["宸插疄鍚", "已实名"],
  ["鍩虹璁よ瘉", "基础认证"],
  ["鐙敓瀛愬コ", "独生子女"],
  ["鏈夊厔寮熷濡", "有兄弟姐妹"],
  ["鏃犺溅", "无车"],
  ["鏈夎溅", "有车"],
  ["鏈夋埧鏈夎捶", "有房有贷"],
  ["鏈夋埧鏃犺捶", "有房无贷"],
  ["鐙珛绉熸埧", "独立租房"],
  ["涓庣埗姣嶅悓浣", "与父母同住"]
];

const CITY_ALIASES = {
  "上海": "上海",
  shanghai: "上海",
  "杭州": "杭州",
  hangzhou: "杭州",
  "佹澀宸?": "杭州",
  "澀宸?": "杭州",
  "深圳": "深圳",
  shenzhen: "深圳",
  "苏州": "苏州",
  suzhou: "苏州"
};

function repairLegacyText(value) {
  let repaired = String(value || "");

  for (const [broken, fixed] of LEGACY_TEXT_REPLACEMENTS) {
    repaired = repaired.split(broken).join(fixed);
  }

  return repaired;
}

function normalizeWhitespace(value) {
  return repairLegacyText(value)
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeText(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function normalizeCityName(value) {
  const normalized = normalizeWhitespace(value).replace(/市$/u, "");
  return CITY_ALIASES[normalized.toLowerCase()] || normalized;
}

function asArray(value) {
  return normalizeWhitespace(value)
    .split(/[\n,，、；;/]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueStrings(items) {
  return [...new Set(items.filter(Boolean))];
}

function includesAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

function optionLabelFor(fieldKey, value) {
  return REALITY_OPTION_LABELS[fieldKey]?.[value] || "未提供";
}

function inferRelationshipGoal(text) {
  const normalized = normalizeText(text);

  if (!normalized) {
    return { value: "unknown", label: VALUE_LABELS.relationshipGoal.unknown };
  }

  if (
    includesAny(normalized, [
      "认真",
      "长期",
      "结婚",
      "稳定关系",
      "以结婚为目标",
      "认真发展",
      "serious",
      "marriage",
      "long-term"
    ])
  ) {
    return { value: "serious", label: VALUE_LABELS.relationshipGoal.serious };
  }

  if (
    includesAny(normalized, [
      "先了解",
      "先聊聊",
      "随缘",
      "慢慢看",
      "轻松接触",
      "看感觉",
      "exploratory",
      "casual",
      "see where it goes"
    ])
  ) {
    return { value: "exploratory", label: VALUE_LABELS.relationshipGoal.exploratory };
  }

  return { value: "unknown", label: VALUE_LABELS.relationshipGoal.unknown };
}

function inferTimeline(text) {
  const normalized = normalizeText(text);

  if (!normalized) {
    return { value: "unknown", label: VALUE_LABELS.marriageTimeline.unknown };
  }

  if (
    /((1|一)\s*年内)|(一年内)|(半年内)|(尽快)|(马上结婚)|(within a year)/u.test(normalized)
  ) {
    return { value: "within_1_year", label: VALUE_LABELS.marriageTimeline.within_1_year };
  }

  if (
    /((1|一)\s*(到|-|~|至)\s*(2|二)\s*年)|(1-2年)|(一到两年)|(两年内)|(one to two years)/u.test(
      normalized
    )
  ) {
    return { value: "one_to_two_years", label: VALUE_LABELS.marriageTimeline.one_to_two_years };
  }

  if (
    includesAny(normalized, [
      "不着急",
      "以后再说",
      "先相处",
      "开放",
      "看情况",
      "later",
      "open ended"
    ])
  ) {
    return { value: "open_ended", label: VALUE_LABELS.marriageTimeline.open_ended };
  }

  return { value: "unknown", label: VALUE_LABELS.marriageTimeline.unknown };
}

function inferChildrenPreference(text) {
  const normalized = normalizeText(text);

  if (!normalized) {
    return { value: "unknown", label: VALUE_LABELS.childrenPreference.unknown };
  }

  if (
    includesAny(normalized, [
      "不要孩子",
      "不想要孩子",
      "不想生孩子",
      "明确不生",
      "丁克",
      "childfree",
      "no children"
    ])
  ) {
    return { value: "no_children", label: VALUE_LABELS.childrenPreference.no_children };
  }

  if (
    includesAny(normalized, [
      "想要孩子",
      "希望未来要孩子",
      "未来要孩子",
      "想生孩子",
      "希望生育",
      "want children",
      "kids"
    ])
  ) {
    return { value: "wants_children", label: VALUE_LABELS.childrenPreference.wants_children };
  }

  if (
    includesAny(normalized, ["都可以", "开放", "再看", "以后再决定", "open to it", "later decision"])
  ) {
    return { value: "open", label: VALUE_LABELS.childrenPreference.open };
  }

  return { value: "unknown", label: VALUE_LABELS.childrenPreference.unknown };
}

function inferFamilyBoundary(text) {
  const normalized = normalizeText(text);

  if (!normalized) {
    return { value: "unknown", label: VALUE_LABELS.familyBoundary.unknown };
  }

  if (
    includesAny(normalized, [
      "独立小家庭",
      "婚后独立",
      "独立",
      "两个人决定",
      "有边界",
      "independent",
      "nuclear family"
    ])
  ) {
    return { value: "independent", label: VALUE_LABELS.familyBoundary.independent };
  }

  if (
    includesAny(normalized, [
      "和父母住",
      "听家里",
      "父母决定",
      "父母参与很多",
      "family-led",
      "parents involved"
    ])
  ) {
    return { value: "family_led", label: VALUE_LABELS.familyBoundary.family_led };
  }

  return { value: "unknown", label: VALUE_LABELS.familyBoundary.unknown };
}

function inferFinancialView(text) {
  const normalized = normalizeText(text);

  if (!normalized) {
    return { value: "unknown", label: VALUE_LABELS.financialView.unknown };
  }

  if (
    includesAny(normalized, [
      "务实",
      "稳定",
      "理性消费",
      "储蓄",
      "量入为出",
      "practical",
      "stable"
    ])
  ) {
    return { value: "practical", label: VALUE_LABELS.financialView.practical };
  }

  if (
    includesAny(normalized, ["高消费", "面子", "奢侈", "luxury", "flashy", "冲动消费"])
  ) {
    return { value: "status_spending", label: VALUE_LABELS.financialView.status_spending };
  }

  return { value: "unknown", label: VALUE_LABELS.financialView.unknown };
}

function inferCommunicationStyle(text) {
  const normalized = normalizeText(text);

  if (!normalized) {
    return { value: "unknown", label: VALUE_LABELS.communicationStyle.unknown };
  }

  if (includesAny(normalized, ["直接", "坦诚", "明确", "清晰", "direct", "clear"])) {
    return { value: "direct", label: VALUE_LABELS.communicationStyle.direct };
  }

  if (
    includesAny(normalized, ["稳定回复", "持续联系", "稳定沟通", "consistent", "steady", "有回应"])
  ) {
    return { value: "steady", label: VALUE_LABELS.communicationStyle.steady };
  }

  if (
    includesAny(normalized, ["慢热", "低频", "慢慢来", "被动", "slow burn", "low frequency"])
  ) {
    return { value: "slow_burn", label: VALUE_LABELS.communicationStyle.slow_burn };
  }

  return { value: "unknown", label: VALUE_LABELS.communicationStyle.unknown };
}

function compareValues(userFact, candidateFact) {
  if (!userFact?.value || userFact.value === "unknown") {
    return { status: "unclear", reason: "用户在这个维度上的偏好还不够明确。" };
  }

  if (!candidateFact?.value || candidateFact.value === "unknown") {
    return { status: "unclear", reason: "候选人在这个维度上的资料还不够完整。" };
  }

  if (userFact.value === candidateFact.value) {
    return { status: "aligned", reason: "双方在这个维度上基本一致。" };
  }

  const softPairs = new Set([
    "within_1_year|one_to_two_years",
    "one_to_two_years|within_1_year",
    "one_to_two_years|open_ended",
    "open_ended|one_to_two_years",
    "wants_children|open",
    "open|wants_children",
    "direct|steady",
    "steady|direct",
    "steady|slow_burn",
    "slow_burn|steady"
  ]);

  if (softPairs.has(`${userFact.value}|${candidateFact.value}`)) {
    return { status: "mixed", reason: "方向接近，但节奏或明确程度还有差异。" };
  }

  return { status: "conflict", reason: "双方在这个维度上存在明显冲突。" };
}

function buildUserFacts(profile) {
  const preferredCities = profile.cities.map(normalizeCityName).filter(Boolean);

  return {
    relationshipGoal: inferRelationshipGoal(`${profile.relationshipGoal}\n${profile.selfSummary}`),
    cityPlan: {
      value: preferredCities.length ? preferredCities.map((item) => item.toLowerCase()) : ["unknown"],
      label: preferredCities.length ? preferredCities.join("、") : "未明确"
    },
    marriageTimeline: inferTimeline(`${profile.marriageTimeline}\n${profile.selfSummary}`),
    childrenPreference: inferChildrenPreference(
      `${profile.childrenPreference}\n${profile.selfSummary}`
    ),
    familyBoundary: inferFamilyBoundary(`${profile.familyBoundary}\n${profile.selfSummary}`),
    financialView: inferFinancialView(`${profile.financialView}\n${profile.selfSummary}`),
    communicationStyle: inferCommunicationStyle(
      `${profile.communicationStyle}\n${profile.selfSummary}`
    )
  };
}

function buildCandidateFacts(candidate) {
  return {
    relationshipGoal: {
      value: candidate.relationshipGoal,
      label:
        VALUE_LABELS.relationshipGoal[candidate.relationshipGoal] ||
        VALUE_LABELS.relationshipGoal.unknown
    },
    cityPlan: {
      value: normalizeCityName(candidate.city).toLowerCase(),
      label: normalizeCityName(candidate.city)
    },
    marriageTimeline: {
      value: candidate.marriageTimeline,
      label:
        VALUE_LABELS.marriageTimeline[candidate.marriageTimeline] ||
        VALUE_LABELS.marriageTimeline.unknown
    },
    childrenPreference: {
      value: candidate.childrenPreference,
      label:
        VALUE_LABELS.childrenPreference[candidate.childrenPreference] ||
        VALUE_LABELS.childrenPreference.unknown
    },
    familyBoundary: {
      value: candidate.familyBoundary,
      label:
        VALUE_LABELS.familyBoundary[candidate.familyBoundary] ||
        VALUE_LABELS.familyBoundary.unknown
    },
    financialView: {
      value: candidate.financialView,
      label:
        VALUE_LABELS.financialView[candidate.financialView] ||
        VALUE_LABELS.financialView.unknown
    },
    communicationStyle: {
      value: candidate.communicationStyle,
      label:
        VALUE_LABELS.communicationStyle[candidate.communicationStyle] ||
        VALUE_LABELS.communicationStyle.unknown
    }
  };
}

function buildMatrix(userFacts, candidateFacts) {
  return DIMENSION_DEFS.map((dimension) => {
    let comparison;

    if (dimension.key === "cityPlan") {
      if (!userFacts.cityPlan.value.length || userFacts.cityPlan.value[0] === "unknown") {
        comparison = { status: "unclear", reason: "用户还没有明确偏好城市。" };
      } else if (!candidateFacts.cityPlan.value) {
        comparison = { status: "unclear", reason: "候选人的城市信息还不完整。" };
      } else if (userFacts.cityPlan.value.includes(candidateFacts.cityPlan.value)) {
        comparison = {
          status: "aligned",
          reason: "候选人所在城市落在用户偏好城市范围内。"
        };
      } else {
        comparison = {
          status: "mixed",
          reason: "当前城市不在偏好列表里，但仍可视情况做跨城评估。"
        };
      }
    } else {
      comparison = compareValues(userFacts[dimension.key], candidateFacts[dimension.key]);
    }

    return {
      key: dimension.key,
      label: dimension.label,
      weight: dimension.weight,
      userPosition: userFacts[dimension.key].label,
      candidatePosition: candidateFacts[dimension.key].label,
      status: comparison.status,
      statusLabel: STATUS_LABELS[comparison.status],
      reason: comparison.reason
    };
  });
}

function computeScore(matrix) {
  let weightedPoints = 0;
  let totalWeight = 0;

  for (const item of matrix) {
    totalWeight += item.weight;

    if (item.status === "aligned") {
      weightedPoints += item.weight;
    } else if (item.status === "mixed") {
      weightedPoints += item.weight * 0.6;
    } else if (item.status === "unclear") {
      weightedPoints += item.weight * 0.45;
    }
  }

  return Math.round((weightedPoints / totalWeight) * 100);
}

function detectHardStopMatches(profile, candidate) {
  if (!profile.hardStops.length) {
    return [];
  }

  const candidateText = normalizeText(
    [
      candidate.displayName,
      candidate.city,
      candidate.occupation,
      candidate.summary,
      candidate.searchableText,
      candidate.highlights.join(" ")
    ].join("\n")
  );

  return profile.hardStops.filter((item) => candidateText.includes(normalizeText(item)));
}

function evaluateMustHaves(profile, candidate) {
  if (!profile.mustHaves.length) {
    return [];
  }

  const candidateText = normalizeText(
    [candidate.summary, candidate.searchableText, candidate.highlights.join(" ")].join("\n")
  );

  return profile.mustHaves.filter((item) => !candidateText.includes(normalizeText(item)));
}

function buildCandidateRisks(candidate, hardStopMatches) {
  const risks = candidate.riskTags.map((tag) => {
    const def = CANDIDATE_RISK_DEFS[tag];

    return {
      code: tag,
      label: def.label,
      severity: def.severity,
      severityLabel: def.severityLabel,
      whyItMatters: def.whyItMatters
    };
  });

  for (const hardStop of hardStopMatches) {
    risks.push({
      code: "hard_stop_overlap",
      label: "可能触碰用户硬性雷区",
      severity: "high",
      severityLabel: "高风险",
      whyItMatters: `候选人资料可能与用户雷区“${hardStop}”重合，进入下一阶段前需要先核实。`
    });
  }

  return risks;
}

function deriveCandidateBand(score, risks) {
  const hasHighRisk = risks.some((risk) => risk.severity === "high");

  if (hasHighRisk) {
    return {
      key: "hold",
      label: REPORT_BAND_LABELS.hold,
      summary: "当前风险过高，不建议直接进入下一阶段。"
    };
  }

  if (score >= 80) {
    return {
      key: "strong",
      label: REPORT_BAND_LABELS.strong,
      summary: "整体匹配度高，适合优先进入下一阶段。"
    };
  }

  if (score >= 65) {
    return {
      key: "promising",
      label: REPORT_BAND_LABELS.promising,
      summary: "整体有推进价值，但还需要确认少数关键信息。"
    };
  }

  if (score >= 50) {
    return {
      key: "needs-clarification",
      label: REPORT_BAND_LABELS["needs-clarification"],
      summary: "存在较多待确认项，建议先补齐信息。"
    };
  }

  return {
    key: "weak",
    label: REPORT_BAND_LABELS.weak,
    summary: "与当前用户画像差距较大，不建议优先推进。"
  };
}

function capBandAtNeedsClarification(band) {
  if (BAND_RANK[band.key] <= BAND_RANK["needs-clarification"]) {
    return band;
  }

  return {
    key: "needs-clarification",
    label: REPORT_BAND_LABELS["needs-clarification"],
    summary: "命中了结构化必须条件的缺口，建议先补齐现实信息再决定。"
  };
}

function normalizeSelfReality(rawReality) {
  const normalized = {};

  for (const field of REALITY_FIELD_DEFS) {
    const rawValue = normalizeWhitespace(rawReality?.[field.key]);
    const allowedValues = new Set(field.options.map((option) => option.value));
    normalized[field.key] = allowedValues.has(rawValue) ? rawValue : "";
  }

  return normalized;
}

function normalizePartnerRealityPreferences(rawPreferences) {
  const normalized = {};

  for (const field of REALITY_FIELD_DEFS) {
    const raw = rawPreferences?.[field.key] || {};
    const mode = Object.hasOwn(REALITY_MODE_LABELS, raw.mode) ? raw.mode : "ignore";
    const allowedValues = new Set(field.options.map((option) => option.value));
    const values = uniqueStrings(Array.isArray(raw.values) ? raw.values : []).filter((value) =>
      allowedValues.has(value)
    );

    normalized[field.key] = { mode, values };
  }

  return normalized;
}

export function normalizeTwinProfile(raw) {
  return {
    displayName: normalizeWhitespace(raw.displayName),
    relationshipGoal: normalizeWhitespace(raw.relationshipGoal),
    cities: asArray(raw.cities).map(normalizeCityName),
    mustHaves: asArray(raw.mustHaves),
    hardStops: asArray(raw.hardStops),
    communicationStyle: normalizeWhitespace(raw.communicationStyle),
    marriageTimeline: normalizeWhitespace(raw.marriageTimeline),
    childrenPreference: normalizeWhitespace(raw.childrenPreference),
    familyBoundary: normalizeWhitespace(raw.familyBoundary),
    financialView: normalizeWhitespace(raw.financialView),
    selfSummary: normalizeWhitespace(raw.selfSummary),
    authorizedSensitiveTopics: Array.isArray(raw.authorizedSensitiveTopics)
      ? raw.authorizedSensitiveTopics.filter((key) => CATEGORY_LABELS[key])
      : [],
    selfReality: normalizeSelfReality(raw.selfReality || {}),
    partnerRealityPreferences: normalizePartnerRealityPreferences(
      raw.partnerRealityPreferences || {}
    )
  };
}

function buildRealitySummary(profile) {
  const selfReality = REALITY_FIELD_DEFS.filter((field) => profile.selfReality[field.key]).map(
    (field) => ({
      key: field.key,
      label: field.label,
      value: profile.selfReality[field.key],
      valueLabel: optionLabelFor(field.key, profile.selfReality[field.key])
    })
  );

  const partnerPreferences = REALITY_FIELD_DEFS.filter((field) => {
    const preference = profile.partnerRealityPreferences[field.key];
    return preference.mode !== "ignore" && preference.values.length > 0;
  }).map((field) => {
    const preference = profile.partnerRealityPreferences[field.key];

    return {
      key: field.key,
      label: field.label,
      mode: preference.mode,
      modeLabel: REALITY_MODE_LABELS[preference.mode],
      values: preference.values,
      valueLabels: preference.values.map((value) => optionLabelFor(field.key, value))
    };
  });

  return {
    selfReality,
    partnerPreferences
  };
}

function buildSuggestedCompletions(profile) {
  return REALITY_FIELD_DEFS.filter((field) => !profile.selfReality[field.key]).map((field) => ({
    key: field.key,
    label: field.label,
    reason: field.suggestionReason
  }));
}

function evaluateRealityMatch(field, preference, candidateValue) {
  if (preference.mode === "ignore" || !preference.values.length) {
    return null;
  }

  const candidateValueLabel = candidateValue ? optionLabelFor(field.key, candidateValue) : "未提供";
  const targetLabel = preference.values.map((value) => optionLabelFor(field.key, value)).join("、");
  const matched = preference.values.includes(candidateValue);

  if (preference.mode === "prefer") {
    return {
      key: field.key,
      label: field.label,
      mode: preference.mode,
      modeLabel: REALITY_MODE_LABELS[preference.mode],
      status: matched ? "matched" : "missed",
      summary: matched
        ? `现实偏好命中：对方的“${field.label}”符合你的加分偏好（${candidateValueLabel}）。`
        : `现实偏好未命中：你偏好“${field.label}”为 ${targetLabel}，当前候选人为 ${candidateValueLabel}。`,
      nextStep: `继续确认“${field.label}”在真实互动中的稳定性。`,
      scoreDelta: matched ? 4 : -2
    };
  }

  if (preference.mode === "require") {
    return {
      key: field.key,
      label: field.label,
      mode: preference.mode,
      modeLabel: REALITY_MODE_LABELS[preference.mode],
      status: matched ? "matched" : "requirement_mismatch",
      summary: matched
        ? `现实硬条件满足：对方的“${field.label}”命中了你的必须条件（${candidateValueLabel}）。`
        : `现实硬条件未满足：你要求“${field.label}”为 ${targetLabel}，当前候选人为 ${candidateValueLabel}。`,
      nextStep: `进入下一阶段前，必须再次确认“${field.label}”。`,
      scoreDelta: matched ? 5 : -16,
      isRequirementMismatch: !matched
    };
  }

  if (preference.mode === "reject") {
    return {
      key: field.key,
      label: field.label,
      mode: preference.mode,
      modeLabel: REALITY_MODE_LABELS[preference.mode],
      status: matched ? "hard_stop" : "safe",
      summary: matched
        ? `现实排除项命中：你不接受“${field.label}”为 ${targetLabel}，当前候选人命中排除条件。`
        : `现实排除项未命中：对方的“${field.label}”没有落在你的不接受范围内。`,
      nextStep: "无需继续在该项上追问。",
      scoreDelta: 0,
      isHardStop: matched
    };
  }

  return null;
}

function buildRealityFindings(profile, candidate) {
  const findings = [];
  let scoreDelta = 0;
  let hasRequirementMismatch = false;
  let blockedByReality = false;

  for (const field of REALITY_FIELD_DEFS) {
    const preference = profile.partnerRealityPreferences[field.key];
    const finding = evaluateRealityMatch(field, preference, candidate[field.key]);

    if (!finding) {
      continue;
    }

    findings.push(finding);
    scoreDelta += finding.scoreDelta;
    hasRequirementMismatch ||= Boolean(finding.isRequirementMismatch);
    blockedByReality ||= Boolean(finding.isHardStop);
  }

  return {
    findings,
    scoreDelta,
    hasRequirementMismatch,
    blockedByReality
  };
}

function buildCandidateRealitySummary(candidate) {
  return REALITY_FIELD_DEFS.map((field) => ({
    key: field.key,
    label: field.label,
    value: candidate[field.key],
    valueLabel: optionLabelFor(field.key, candidate[field.key])
  }));
}

function buildCandidateReasons(matrix, realityFindings) {
  const aligned = matrix.filter((item) => item.status === "aligned").map((item) => item.label);
  const reasons = aligned.slice(0, 3).map((label) => `在“${label}”上与用户画像较一致。`);

  for (const finding of realityFindings) {
    if (finding.mode === "prefer" && finding.status === "matched") {
      reasons.push(finding.summary);
    }

    if (finding.mode === "require" && finding.status === "matched") {
      reasons.push(finding.summary);
    }
  }

  return uniqueStrings(reasons).slice(0, 4);
}

function buildCandidateCautions(matrix, risks, unresolvedMustHaves, realityFindings) {
  const cautions = [];

  for (const item of matrix) {
    if (item.status === "mixed" || item.status === "conflict") {
      cautions.push(`${item.label}：${item.reason}`);
    }
  }

  for (const risk of risks) {
    cautions.push(`${risk.label}：${risk.whyItMatters}`);
  }

  for (const finding of realityFindings) {
    if (finding.status === "missed" || finding.status === "requirement_mismatch") {
      cautions.push(finding.summary);
    }
  }

  for (const mustHave of unresolvedMustHaves.slice(0, 2)) {
    cautions.push(`用户“必须满足项”中的“${mustHave}”还没有从候选人资料中得到确认。`);
  }

  return uniqueStrings(cautions).slice(0, 5);
}

function buildNextPhaseFocus(matrix, unresolvedMustHaves, authorizedTopics, realityFindings) {
  const focus = [];

  for (const item of matrix) {
    if (item.status === "unclear" || item.status === "mixed") {
      focus.push(`下一阶段优先确认“${item.label}”。`);
    }
  }

  for (const finding of realityFindings) {
    if (finding.status === "missed" || finding.status === "requirement_mismatch") {
      focus.push(finding.nextStep || `继续核实“${finding.label}”。`);
    }
  }

  for (const mustHave of unresolvedMustHaves.slice(0, 2)) {
    focus.push(`验证用户必须满足项：“${mustHave}”。`);
  }

  const authorizedLabels = authorizedTopics.map((topic) => CATEGORY_LABELS[topic]).filter(Boolean);
  if (authorizedLabels.length) {
    focus.push(`如进入下一阶段，可在已授权范围内核实：${authorizedLabels.join("、")}。`);
  }

  return uniqueStrings(focus).slice(0, 5);
}

function buildProfileGaps(profile, userFacts) {
  const gaps = [];

  if (userFacts.relationshipGoal.value === "unknown") {
    gaps.push({
      dimension: "关系目标",
      priority: "high",
      priorityLabel: PRIORITY_LABELS.high,
      reason: "系统还无法稳定判断你究竟是强长期导向，还是更偏轻量探索。"
    });
  }

  if (!profile.cities.length) {
    gaps.push({
      dimension: "偏好城市",
      priority: "high",
      priorityLabel: PRIORITY_LABELS.high,
      reason: "没有偏好城市会显著削弱初筛质量。"
    });
  }

  if (userFacts.marriageTimeline.value === "unknown") {
    gaps.push({
      dimension: "结婚时间预期",
      priority: "medium",
      priorityLabel: PRIORITY_LABELS.medium,
      reason: "结婚节奏不明确，会影响系统判断哪些候选人值得优先推进。"
    });
  }

  if (userFacts.childrenPreference.value === "unknown") {
    gaps.push({
      dimension: "孩子与生育态度",
      priority: "medium",
      priorityLabel: PRIORITY_LABELS.medium,
      reason: "是否希望未来要孩子，是后续筛选与敏感议题核实的重要前提。"
    });
  }

  if (!profile.mustHaves.length) {
    gaps.push({
      dimension: "必须满足项",
      priority: "medium",
      priorityLabel: PRIORITY_LABELS.medium,
      reason: "建议至少填写 2 到 3 条明确要求，便于系统做更强筛选。"
    });
  }

  if (!profile.selfSummary) {
    gaps.push({
      dimension: "补充画像",
      priority: "low",
      priorityLabel: PRIORITY_LABELS.low,
      reason: "补充你最看重的关系逻辑，有助于后续 Twin 的解释更贴近本人。"
    });
  }

  return gaps.sort(
    (left, right) => PRIORITY_ORDER.indexOf(left.priority) - PRIORITY_ORDER.indexOf(right.priority)
  );
}

function buildProfileLabel(userFacts) {
  const parts = [];

  if (userFacts.relationshipGoal.value === "serious") {
    parts.push("长期关系导向");
  } else if (userFacts.relationshipGoal.value === "exploratory") {
    parts.push("慢观察导向");
  }

  if (userFacts.familyBoundary.value === "independent") {
    parts.push("独立小家庭偏好");
  } else if (userFacts.familyBoundary.value === "family_led") {
    parts.push("家庭参与度敏感");
  }

  if (userFacts.financialView.value === "practical") {
    parts.push("务实稳定型");
  } else if (userFacts.financialView.value === "status_spending") {
    parts.push("消费观要求明确");
  }

  return parts.length ? parts.slice(0, 3).join(" · ") : "待补充画像";
}

function buildTwinSummary(profile, userFacts, realitySummary) {
  const displayName = profile.displayName || "未命名用户";
  const profileLabel = buildProfileLabel(userFacts);
  const preferredCities = profile.cities.length ? profile.cities.join("、") : "未明确";
  const realityAnchors = realitySummary.selfReality
    .slice(0, 3)
    .map((item) => `${item.label}：${item.valueLabel}`);

  return {
    displayName,
    profileLabel,
    summary:
      `${displayName} 的 Twin 已生成，当前更偏向“${userFacts.relationshipGoal.label}”，` +
      `偏好城市集中在 ${preferredCities}，结婚节奏为 ${userFacts.marriageTimeline.label}。`,
    anchors: [
      `关系目标：${userFacts.relationshipGoal.label}`,
      `偏好城市：${preferredCities}`,
      `结婚节奏：${userFacts.marriageTimeline.label}`,
      `孩子态度：${userFacts.childrenPreference.label}`,
      `家庭边界：${userFacts.familyBoundary.label}`,
      `财务观：${userFacts.financialView.label}`,
      `沟通风格：${userFacts.communicationStyle.label}`,
      ...realityAnchors
    ],
    mustHaves: profile.mustHaves,
    hardStops: profile.hardStops,
    authorizedTopics: profile.authorizedSensitiveTopics.map((key) => CATEGORY_LABELS[key]).filter(Boolean)
  };
}

function buildShortlist(profile, userFacts, candidatePool) {
  const evaluated = [];
  let excludedByRealityCount = 0;

  for (const candidate of candidatePool) {
    const candidateFacts = buildCandidateFacts(candidate);
    const matrix = buildMatrix(userFacts, candidateFacts);
    const unresolvedMustHaves = evaluateMustHaves(profile, candidate);
    const hardStopMatches = detectHardStopMatches(profile, candidate);
    const risks = buildCandidateRisks(candidate, hardStopMatches);
    const baseScore = computeScore(matrix);
    const hardStopPenalty = hardStopMatches.length * 15;
    const mustHavePenalty = Math.min(unresolvedMustHaves.length, 2) * 4;
    const realityResult = buildRealityFindings(profile, candidate);

    if (realityResult.blockedByReality) {
      excludedByRealityCount += 1;
      continue;
    }

    const finalScore = Math.max(
      0,
      Math.min(100, baseScore - hardStopPenalty - mustHavePenalty + realityResult.scoreDelta)
    );
    let band = deriveCandidateBand(finalScore, risks);

    if (realityResult.hasRequirementMismatch) {
      band = capBandAtNeedsClarification(band);
    }

    evaluated.push({
      candidateId: candidate.id,
      displayName: candidate.displayName,
      age: candidate.age,
      city: candidate.city,
      occupation: candidate.occupation,
      verificationLevel: candidate.verificationLevel,
      trustLevel: candidate.trustLevel,
      summary: candidate.summary,
      matchScore: finalScore,
      matchBandKey: band.key,
      matchBandLabel: band.label,
      statusSummary: band.summary,
      highlights: candidate.highlights,
      matchedReasons: buildCandidateReasons(matrix, realityResult.findings),
      cautionPoints: buildCandidateCautions(
        matrix,
        risks,
        unresolvedMustHaves,
        realityResult.findings
      ),
      nextPhaseFocus: buildNextPhaseFocus(
        matrix,
        unresolvedMustHaves,
        profile.authorizedSensitiveTopics,
        realityResult.findings
      ),
      unresolvedMustHaves,
      matrix,
      risks,
      hardStopMatches,
      realityFindings: realityResult.findings,
      realitySummary: buildCandidateRealitySummary(candidate)
    });
  }

  return {
    shortlist: evaluated.sort((left, right) => right.matchScore - left.matchScore).slice(0, 4),
    excludedByRealityCount
  };
}

function buildRealityPreferenceFindings(shortlist) {
  return shortlist
    .filter((candidate) => candidate.realityFindings.length)
    .map((candidate) => ({
      candidateId: candidate.candidateId,
      displayName: candidate.displayName,
      findings: candidate.realityFindings.map((finding) => ({
        key: finding.key,
        label: finding.label,
        mode: finding.mode,
        modeLabel: finding.modeLabel,
        status: finding.status,
        summary: finding.summary
      }))
    }));
}

function buildOverallNextSteps(profileGaps, suggestedCompletions, shortlist) {
  const nextSteps = [];
  const readyCount = shortlist.filter((candidate) => candidate.matchBandKey === "strong").length;
  const topCandidate = shortlist[0];

  if (profileGaps.some((gap) => gap.priority === "high")) {
    nextSteps.push("先补齐高优先级用户画像字段，再进入更精确的数据库匹配。");
  }

  if (suggestedCompletions.length) {
    nextSteps.push("可以继续补充现实条件层的选填字段，让下一轮 shortlist 更贴近真实可推进性。");
  }

  if (readyCount > 0 && topCandidate) {
    nextSteps.push(`可优先从 ${topCandidate.displayName} 开启下一阶段的 Twin 预沟通。`);
  } else if (topCandidate) {
    nextSteps.push(`当前可先围绕 ${topCandidate.displayName} 补齐关键信息，再决定是否推进。`);
  } else {
    nextSteps.push("当前没有足够合适的 shortlist，建议先补充画像并重新匹配。");
  }

  nextSteps.push("下一阶段不再手动录入候选人，而是由 Twin 面向 shortlist 对象做预沟通和信息核实。");
  nextSteps.push("敏感问题仅在已授权类别内推进，并保留逐步确认与人工把关。");

  return uniqueStrings(nextSteps);
}

export function buildMatchReport(payload, options = {}) {
  const twinProfile = normalizeTwinProfile(payload.twinProfile || {});
  const candidatePool =
    Array.isArray(options.candidatePool) && options.candidatePool.length
      ? options.candidatePool
      : MOCK_CANDIDATE_POOL;
  const userFacts = buildUserFacts(twinProfile);
  const profileGaps = buildProfileGaps(twinProfile, userFacts);
  const realitySummary = buildRealitySummary(twinProfile);
  const suggestedCompletions = buildSuggestedCompletions(twinProfile);
  const { shortlist, excludedByRealityCount } = buildShortlist(
    twinProfile,
    userFacts,
    candidatePool
  );
  const twinSummary = buildTwinSummary(twinProfile, userFacts, realitySummary);
  const candidatePoolSize = candidatePool.length;
  const nextPhaseReadyCount = shortlist.filter((candidate) => candidate.matchBandKey === "strong").length;

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    phase: "phase_1_matching_shortlist",
    phaseLabel: "用户单侧建档与数据库初筛",
    twinProfile,
    twinSummary,
    profileGaps,
    realitySummary,
    realityPreferenceFindings: buildRealityPreferenceFindings(shortlist),
    suggestedCompletions,
    shortlist,
    overview: {
      candidatePoolSize,
      shortlistCount: shortlist.length,
      nextPhaseReadyCount,
      excludedByRealityCount,
      headline: `已在候选池 ${candidatePoolSize} 人中完成初筛，产出 ${shortlist.length} 位 shortlist 候选人。`
    },
    nextSteps: buildOverallNextSteps(profileGaps, suggestedCompletions, shortlist)
  };
}
