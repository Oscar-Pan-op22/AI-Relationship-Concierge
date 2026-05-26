function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeList(value) {
  return String(value || "")
    .split(/[\n,，、；;]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function detectGoalBucket(value) {
  const text = normalizeText(value);

  if (!text) {
    return "unknown";
  }

  if (
    ["认真", "长期", "结婚", "稳定", "serious", "long-term", "marriage"].some((keyword) =>
      text.includes(keyword)
    )
  ) {
    return "serious";
  }

  if (["随缘", "了解", "慢慢", "casual", "explore"].some((keyword) => text.includes(keyword))) {
    return "exploratory";
  }

  return "unknown";
}

function detectChildrenBucket(value) {
  const text = normalizeText(value);

  if (!text) {
    return "unknown";
  }

  if (["不要孩子", "丁克", "childfree", "no children"].some((keyword) => text.includes(keyword))) {
    return "no_children";
  }

  if (["要孩子", "想要孩子", "生育", "want children", "kids"].some((keyword) => text.includes(keyword))) {
    return "wants_children";
  }

  if (["都可以", "再看", "开放", "open"].some((keyword) => text.includes(keyword))) {
    return "open";
  }

  return "unknown";
}

function detectTimelineBucket(value) {
  const text = normalizeText(value);

  if (!text) {
    return "unknown";
  }

  if (["1年内", "一年内", "within a year"].some((keyword) => text.includes(keyword))) {
    return "within_1_year";
  }

  if (
    ["2年内", "两年内", "1到2年", "1-2年", "one to two years"].some((keyword) =>
      text.includes(keyword)
    )
  ) {
    return "one_to_two_years";
  }

  if (["不着急", "以后再说", "开放", "open"].some((keyword) => text.includes(keyword))) {
    return "open_ended";
  }

  return "unknown";
}

function detectFamilyBucket(value) {
  const text = normalizeText(value);

  if (!text) {
    return "unknown";
  }

  if (["独立小家庭", "独立居住", "小家庭", "independent"].some((keyword) => text.includes(keyword))) {
    return "independent";
  }

  if (["父母参与", "同住", "听父母", "family led"].some((keyword) => text.includes(keyword))) {
    return "family_led";
  }

  return "unknown";
}

function detectFinancialBucket(value) {
  const text = normalizeText(value);

  if (!text) {
    return "unknown";
  }

  if (["务实", "稳定", "practical", "stable"].some((keyword) => text.includes(keyword))) {
    return "practical";
  }

  if (["高消费", "面子", "奢侈", "status"].some((keyword) => text.includes(keyword))) {
    return "status_spending";
  }

  return "unknown";
}

function detectCommunicationBucket(value) {
  const text = normalizeText(value);

  if (!text) {
    return "unknown";
  }

  if (["直接", "坦诚", "clear", "direct"].some((keyword) => text.includes(keyword))) {
    return "direct";
  }

  if (["稳定", "持续", "steady"].some((keyword) => text.includes(keyword))) {
    return "steady";
  }

  if (["慢热", "低频", "slow burn"].some((keyword) => text.includes(keyword))) {
    return "slow_burn";
  }

  return "unknown";
}

function scoreBucket(left, right, weight) {
  if (left === "unknown" || right === "unknown") {
    return weight * 0.35;
  }

  if (left === right) {
    return weight;
  }

  return weight * 0.15;
}

function sharedCities(left, right) {
  const leftCities = new Set(normalizeList(left).map((item) => item.toLowerCase()));
  const rightCities = normalizeList(right).map((item) => item.toLowerCase());

  return rightCities.filter((item) => leftCities.has(item));
}

function buildTwinLabel(profile) {
  const goal = detectGoalBucket(profile.relationshipGoal);
  const family = detectFamilyBucket(profile.familyBoundary);
  const finance = detectFinancialBucket(profile.financialView);
  const parts = [];

  if (goal === "serious") {
    parts.push("认真长期导向");
  } else if (goal === "exploratory") {
    parts.push("先了解观察型");
  }

  if (family === "independent") {
    parts.push("独立小家庭偏好");
  } else if (family === "family_led") {
    parts.push("家庭参与度较高");
  }

  if (finance === "practical") {
    parts.push("务实稳定型");
  } else if (finance === "status_spending") {
    parts.push("消费观偏外显");
  }

  return parts.length ? parts.join(" · ") : "资料待进一步完善";
}

function buildPublicSummary(profile) {
  const pieces = [];

  if (profile.relationshipGoal) {
    pieces.push(`关系目标：${profile.relationshipGoal}`);
  }

  if (profile.cities) {
    pieces.push(`偏好城市：${profile.cities}`);
  }

  if (profile.communicationStyle) {
    pieces.push(`沟通风格：${profile.communicationStyle}`);
  }

  return pieces.join("；") || "当前 Twin 资料还在完善中。";
}

export function buildPublicTwinSnapshot(twin) {
  return {
    userId: twin.userId,
    twinVersionId: twin.twinVersionId,
    twinVersionNumber: twin.twinVersionNumber,
    displayName: twin.displayName,
    relationshipGoal: twin.twinProfile.relationshipGoal || "",
    cities: twin.twinProfile.cities || "",
    profileLabel: buildTwinLabel(twin.twinProfile),
    summary: buildPublicSummary(twin.twinProfile)
  };
}

export function scoreUserMatch(currentTwin, counterpartTwin) {
  const me = currentTwin.twinProfile;
  const other = counterpartTwin.twinProfile;
  let score = 0;
  const reasons = [];

  score += scoreBucket(detectGoalBucket(me.relationshipGoal), detectGoalBucket(other.relationshipGoal), 22);
  score += scoreBucket(detectTimelineBucket(me.marriageTimeline), detectTimelineBucket(other.marriageTimeline), 14);
  score += scoreBucket(detectChildrenBucket(me.childrenPreference), detectChildrenBucket(other.childrenPreference), 14);
  score += scoreBucket(detectFamilyBucket(me.familyBoundary), detectFamilyBucket(other.familyBoundary), 14);
  score += scoreBucket(detectFinancialBucket(me.financialView), detectFinancialBucket(other.financialView), 12);
  score += scoreBucket(
    detectCommunicationBucket(me.communicationStyle),
    detectCommunicationBucket(other.communicationStyle),
    14
  );

  const cityOverlap = sharedCities(me.cities, other.cities);

  if (cityOverlap.length) {
    score += 10;
    reasons.push(`共享城市偏好：${cityOverlap.join("、")}`);
  } else if (normalizeList(me.cities).length && normalizeList(other.cities).length) {
    score += 3;
    reasons.push("城市偏好暂未重叠，需要后续确认迁移意愿。");
  } else {
    score += 5;
  }

  const rounded = Math.max(0, Math.min(100, Math.round(score)));
  const label =
    rounded >= 82
      ? "优先进入预沟通"
      : rounded >= 68
        ? "值得进入预沟通"
        : rounded >= 52
          ? "需要先补充信息"
          : "当前不优先";

  return {
    score: rounded,
    label,
    summary: buildPublicSummary(other),
    profileLabel: buildTwinLabel(other),
    reasons
  };
}
