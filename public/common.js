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

  if (target) {
    target.textContent = user ? `${user.displayName} · ${user.email}` : "未登录";
  }
}

function getInboxNavLinks(root = document) {
  return [...root.querySelectorAll('a[href="/inbox.html"]')];
}

function ensureSessionsNavLinks(root = document) {
  const navs = [...root.querySelectorAll(".nav-links")];

  navs.forEach((nav) => {
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
    } else {
      badge.hidden = true;
      badge.style.display = "none";
      badge.dataset.count = "0";
      badge.textContent = "";
      badge.removeAttribute("aria-label");
    }
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

const FACT_KEY_LABELS = {
  relationshipGoal: "关系目标",
  cities: "长期城市安排",
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

export function getPrechatStatusLabel(status) {
  return PRECHAT_STATUS_LABELS[status] || status || "未知状态";
}

export function getPrechatStatusTone(status) {
  return PRECHAT_STATUS_TONES[status] || "low";
}

function normalizeFactCards(root = document) {
  const sidebars = [...root.querySelectorAll(".messenger-sidebar")];

  sidebars.forEach((sidebar) => {
    const compactLists = [...sidebar.querySelectorAll(".summary-card .stack-list.compact-list")];
    if (!compactLists.length) {
      return;
    }

    const seen = new Set();

    compactLists.forEach((list) => {
      [...list.querySelectorAll(".stack-item")].forEach((item) => {
        const title = item.querySelector("header strong");
        const badge = item.querySelector("header .pill");
        const body = item.querySelector("p");

        if (!title || !body) {
          return;
        }

        const rawKey = String(title.textContent || "").trim();
        const mappedKey = FACT_KEY_LABELS[rawKey];
        const looksLikeFactKey = Boolean(mappedKey) || /^[a-z][a-zA-Z]+$/u.test(rawKey);

        if (!looksLikeFactKey) {
          return;
        }

        title.textContent = mappedKey || rawKey;

        if (badge) {
          const confidenceMatch = String(badge.textContent || "").match(/([0-9]+(?:\.[0-9]+)?)/u);
          if (confidenceMatch) {
            badge.textContent = `置信度 ${confidenceMatch[1]}`;
          }
        }

        const signature = `${title.textContent}::${String(body.textContent || "").trim()}`;
        if (seen.has(signature)) {
          item.remove();
          return;
        }

        seen.add(signature);
      });
    });
  });
}

function normalizeStageReportCards(root = document) {
  [...root.querySelectorAll(".messenger-sidebar .summary-card .stack-item p")].forEach((node) => {
    const text = String(node.textContent || "");

    if (!text.includes("下一步")) {
      return;
    }

    const match = text.match(/(continue|pause_review|handoff_ready|blocked_risk)/u);
    if (!match) {
      return;
    }

    const label = NEXT_ACTION_LABELS[match[1]] || match[1];
    node.innerHTML = `<strong>下一步：</strong>${label}`;
  });
}

function stripSessionStatusUi(root = document) {
  root.querySelectorAll(".messenger-sidebar .status-stack").forEach((node) => {
    node.closest(".summary-card")?.remove();
  });

  root.querySelectorAll(".chat-panel-head .chat-panel-identity-copy p").forEach((node) => {
    node.remove();
  });

  root.querySelectorAll(".chat-panel-head .chat-panel-badges").forEach((node) => {
    node.remove();
  });
}

export function normalizePrechatAutoUi(root = document) {
  if (!root?.querySelectorAll) {
    return;
  }

  ensureSessionsNavLinks(root);
  stripSessionStatusUi(root);
  normalizeFactCards(root);
  normalizeStageReportCards(root);

  root.querySelectorAll('[data-action="run-round"]').forEach((button) => {
    button.remove();
  });

  root.querySelectorAll(".chat-inline-notice").forEach((node) => {
    const text = String(node.textContent || "");

    if (text.includes("启动一轮预沟通")) {
      node.textContent = "预沟通已进入自动推进模式，系统正在等待首轮 Twin-Twin 消息。";
    }
  });
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const observer = new MutationObserver(() => {
    normalizePrechatAutoUi(document);
  });

  window.addEventListener("DOMContentLoaded", () => {
    ensureSessionsNavLinks(document);
    normalizePrechatAutoUi(document);
    observer.observe(document.body, { childList: true, subtree: true });
  });
}
