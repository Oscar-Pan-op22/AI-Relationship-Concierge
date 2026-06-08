export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function fetchJson(url, options) {
  const response = await fetch(url, options);
  let payload = {};

  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const error = new Error(payload.error || "请求失败。");
    error.statusCode = response.status;
    throw error;
  }

  return payload;
}

export async function requireAuth() {
  try {
    const { user, twin } = await fetchJson("/api/auth/me");
    setCurrentUser(user);
    await refreshInboxBadge();
    return { user, twin };
  } catch (error) {
    if (error.statusCode === 401) {
      window.location.href = "/auth.html";
      return null;
    }

    throw error;
  }
}

export function formatDateTime(value) {
  if (!value) {
    return "未记录";
  }

  return new Date(value).toLocaleString();
}

export function renderEmptyState(title, body, eyebrow = "同频") {
  return `
    <div class="empty-state">
      <p class="eyebrow">${escapeHtml(eyebrow)}</p>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(body)}</p>
    </div>
  `;
}

export function setCurrentUser(user) {
  const target = document.querySelector("[data-current-user]");

  if (!target) {
    return;
  }

  target.textContent = user ? `${user.displayName} · ${user.email}` : "未登录";
}

function getInboxNavLinks(root = document) {
  return [...root.querySelectorAll('a[href="/inbox.html"]')];
}

function ensureSessionsNavLinks(root = document) {
  const navs = [...root.querySelectorAll(".nav-links")];

  navs.forEach((nav) => {
    if (!nav.querySelector('a[href="/reports.html"]')) {
      const reportsLink = document.createElement("a");
      reportsLink.className = "secondary-button link-button";
      reportsLink.href = "/reports.html";
      reportsLink.textContent = "匹配报告";

      const matchesLink = nav.querySelector('a[href="/matches.html"]');
      if (matchesLink) {
        matchesLink.textContent = "可发起对象";
        nav.insertBefore(reportsLink, matchesLink);
      } else {
        const logoutButton = nav.querySelector("#logout-button, button");
        if (logoutButton) {
          nav.insertBefore(reportsLink, logoutButton);
        } else {
          nav.appendChild(reportsLink);
        }
      }
    }

    if (nav.querySelector('a[href="/sessions.html"]')) {
      return;
    }

    const sessionsLink = document.createElement("a");
    sessionsLink.className = "secondary-button link-button";
    sessionsLink.href = "/sessions.html";
    sessionsLink.textContent = "所有会话";

    const inboxLink = nav.querySelector('a[href="/inbox.html"]');
    if (inboxLink) {
      nav.insertBefore(sessionsLink, inboxLink);
      return;
    }

    const logoutButton = nav.querySelector("#logout-button, button");
    if (logoutButton) {
      nav.insertBefore(sessionsLink, logoutButton);
      return;
    }

    nav.appendChild(sessionsLink);
  });
}

function applyInboxBadge(count, root = document) {
  getInboxNavLinks(root).forEach((link) => {
    link.classList.add("nav-inbox-link");

    let badge = link.querySelector(".nav-inbox-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "nav-inbox-badge";
      link.appendChild(badge);
    }

    if (count > 0) {
      badge.hidden = false;
      badge.style.display = "inline-flex";
      badge.dataset.count = String(count);
      badge.textContent = String(Math.min(count, 99));
      badge.setAttribute("aria-label", `待办事项 ${count} 项`);
      return;
    }

    badge.hidden = true;
    badge.style.display = "none";
    badge.dataset.count = "0";
    badge.textContent = "";
    badge.removeAttribute("aria-label");
  });
}

export async function refreshInboxBadge(explicitCount = null) {
  try {
    const count =
      explicitCount == null ? ((await fetchJson("/api/inbox")).items || []).length : Number(explicitCount) || 0;
    applyInboxBadge(count);
    return count;
  } catch {
    applyInboxBadge(0);
    return 0;
  }
}

export async function logout() {
  await fetchJson("/api/auth/logout", { method: "POST" });
  window.location.href = "/auth.html";
}

const PRECHAT_STATUS_LABELS = {
  invited: "已发起邀请",
  awaiting_counterparty_acceptance: "等待对方接受",
  active: "预沟通进行中",
  pending_sensitive_approval: "等待敏感问题授权",
  paused_review: "等待查看阶段结论",
  pending_human_input: "等待人工补充信息",
  handoff_ready: "可以进入真人接手",
  blocked_risk: "因风险已暂停",
  rejected: "已结束推进",
  completed: "已完成"
};

const PRECHAT_STATUS_TONES = {
  invited: "medium",
  awaiting_counterparty_acceptance: "medium",
  active: "ok",
  pending_sensitive_approval: "sensitive",
  paused_review: "low",
  pending_human_input: "medium",
  handoff_ready: "ok",
  blocked_risk: "sensitive",
  rejected: "low",
  completed: "ok"
};

const SENSITIVE_TOPIC_LABELS = {
  finance_and_debt: "财务与负债",
  family_boundaries: "家庭边界",
  marriage_and_housing_logistics: "婚姻与居住规划",
  fertility_and_children: "生育与孩子",
  physical_and_mental_health: "身心健康",
  relationship_history: "感情经历",
  lifestyle_and_risk_habits: "生活方式与风险习惯"
};

const TOPIC_KEY_LABELS = {
  relationshipGoal: "关系目标",
  cities: "长期生活城市",
  cityPlan: "城市与生活规划",
  marriageTimeline: "结婚节奏",
  childrenPreference: "孩子与生育态度",
  familyBoundary: "家庭边界",
  financialView: "财务观",
  communicationStyle: "沟通风格",
  incomeBand: "收入区间",
  incomeStability: "收入稳定性",
  debtLevel: "负债压力",
  housingStatus: "住房状态",
  vehicleStatus: "车辆状态",
  siblingStructure: "兄弟姐妹结构",
  parentCareBurden: "父母照护压力",
  postMaritalLivingPreference: "婚后居住取向"
};

const NEXT_ACTION_LABELS = {
  continue: "继续自动推进",
  pause_review: "暂停并等待查看阶段结论",
  handoff_ready: "进入真人接手",
  blocked_risk: "因风险暂停"
};

const STOP_REASON_LABELS = {
  objectives_completed: "阶段结论已形成",
  outstanding_twin_question_unanswered: "仍有 Twin 问题待处理",
  max_turns_reached: "已达到轮次上限",
  paused_review: "预沟通已暂停",
  pending_human_input: "等待人工补充信息",
  pending_sensitive_approval: "等待敏感问题授权",
  blocked_risk: "因风险已暂停",
  auto_start_failed: "自动启动失败"
};

const REALITY_VALUE_LABELS = {
  undisclosed: "暂不披露",
  below_15k: "1.5 万以下",
  "15k_to_30k": "1.5 万到 3 万",
  "30k_to_50k": "3 万到 5 万",
  "50k_plus": "5 万以上",
  stable: "稳定",
  variable: "波动较大",
  currently_adjusting: "当前处于调整期",
  none_or_low: "几乎没有或压力较低",
  mortgage_or_car_loan_only: "主要是房贷 / 车贷",
  manageable_consumer_debt: "有可控的消费负债",
  high_pressure: "负债压力较高",
  renting_independently: "独立租房",
  own_with_loan: "有房有贷",
  own_without_loan: "有房无贷",
  living_with_parents: "目前与父母同住",
  not_fixed: "居住状态未固定",
  none: "无车",
  own: "有车",
  shared_family_vehicle: "家庭共用车辆",
  only_child: "独生子女",
  has_siblings: "有兄弟姐妹",
  low: "较低",
  medium: "中等",
  high: "较高",
  independent_home: "希望独立小家庭",
  near_parents: "可接受住得近但不同住",
  can_live_with_parents: "可接受与父母同住",
  prefer_with_parents: "更倾向与父母同住"
};

const TECHNICAL_TEXT_LABELS = {
  ...PRECHAT_STATUS_LABELS,
  ...SENSITIVE_TOPIC_LABELS,
  ...TOPIC_KEY_LABELS,
  ...NEXT_ACTION_LABELS,
  ...STOP_REASON_LABELS,
  ...REALITY_VALUE_LABELS,
  forbidden_topic_keys: "禁止追问议题",
  closed_topic_keys: "已关闭议题",
  reply_topic_key: "回复议题",
  question_topic_key: "追问议题",
  emitted_reply_topic_key: "最终回复议题",
  emitted_question_topic_key: "最终追问议题",
  emitted_question_text: "最终追问文本",
  active_topic: "当前议题",
  active_topic_state: "当前议题状态",
  next_candidate_topic_key: "下一候选议题",
  activeTopicKey: "当前议题",
  lastClosedTopicKey: "最近关闭议题",
  topicLedger: "议题账本",
  topicQueueSnapshot: "议题队列快照",
  topicCategory: "敏感议题",
  fieldKey: "字段",
  stopReason: "暂停原因",
  pauseKind: "暂停类型",
  reviewKind: "查看类型",
  human_input_request: "人工补充信息",
  sensitive_request: "敏感议题授权",
  session_review: "阶段结论提醒",
  session_pause: "会话暂停提醒",
  manual_review: "模型异常兜底",
  report_plan: "报告计划",
  direct_invite: "直接邀请",
  pending: "待处理",
  approved: "已批准",
  skipped: "已跳过",
  skipped_by_profile: "画像未授权，已跳过",
  not_requested: "未申请",
  not_started: "未开始",
  waiting_initiator: "等待发起方",
  waiting_counterparty: "等待对方",
  reopened_by_human: "人工重开",
  closed: "已关闭",
  confirmed: "已确认",
  outstanding_twin_question: "Twin 问题待处理",
  generic_paused_review: "普通暂停",
  automation_stuck_active_round_paused: "自动推进已暂停"
};

const SORTED_TECHNICAL_TEXT_ENTRIES = Object.entries(TECHNICAL_TEXT_LABELS).sort(
  (left, right) => right[0].length - left[0].length
);

function replaceTechnicalTokens(text) {
  return SORTED_TECHNICAL_TEXT_ENTRIES.reduce((result, [token, label]) => {
    if (!token || token === label || !result.includes(token)) {
      return result;
    }

    return result.replaceAll(token, label);
  }, text);
}

export function localizeDisplayText(value, fallback = "") {
  const text = String(value ?? "").trim();

  if (!text) {
    return fallback;
  }

  return replaceTechnicalTokens(text);
}

export function localizeDisplayList(values, fallback = "暂无", separator = "、") {
  const items = Array.isArray(values)
    ? values.map((item) => localizeDisplayText(item)).filter(Boolean)
    : [];

  return items.length ? items.join(separator) : fallback;
}

export function getPrechatStatusLabel(status) {
  return PRECHAT_STATUS_LABELS[status] || localizeDisplayText(status, "未知状态");
}

export function getPrechatStatusTone(status) {
  return PRECHAT_STATUS_TONES[status] || "low";
}

export function getSensitiveTopicLabel(topicKey) {
  return SENSITIVE_TOPIC_LABELS[topicKey] || localizeDisplayText(topicKey, "未知议题");
}

export function getTopicKeyLabel(topicKey) {
  return TOPIC_KEY_LABELS[topicKey] || localizeDisplayText(topicKey, "未知议题");
}

export function getNextActionLabel(action) {
  return NEXT_ACTION_LABELS[action] || localizeDisplayText(action, "继续自动推进");
}

export function getStopReasonLabel(reason) {
  return STOP_REASON_LABELS[reason] || localizeDisplayText(reason, "未知原因");
}

export function getFieldKeyLabel(fieldKey) {
  if (fieldKey === "manual_review") {
    return "模型异常兜底";
  }

  return TOPIC_KEY_LABELS[fieldKey] || localizeDisplayText(fieldKey, "未知字段");
}

export function localizeStructuredValue(value) {
  const text = String(value ?? "").trim();

  if (!text) {
    return "";
  }

  return REALITY_VALUE_LABELS[text] || localizeDisplayText(text);
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.addEventListener("DOMContentLoaded", () => {
    ensureSessionsNavLinks(document);
  });
}
