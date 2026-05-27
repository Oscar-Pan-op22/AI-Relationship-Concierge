import {
  escapeHtml,
  fetchJson,
  getPrechatStatusLabel,
  getPrechatStatusTone,
  renderEmptyState,
  requireAuth
} from "./common.js";

const reportShell = document.querySelector("#report-shell");
const reportHeroText = document.querySelector("#report-hero-text");
const reportProfileText = document.querySelector("#report-profile-text");

const OBJECTIVE_OPTIONS = [
  { key: "relationshipGoal", label: "关系目标" },
  { key: "cities", label: "长期生活城市" },
  { key: "marriageTimeline", label: "结婚节奏" },
  { key: "childrenPreference", label: "孩子与生育态度" },
  { key: "familyBoundary", label: "家庭边界" },
  { key: "financialView", label: "财务观" }
];

function renderPill(tone, label) {
  return `<span class="pill ${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
}

function renderSimpleList(items, fallback) {
  if (!items.length) {
    return `<p class="summary compact">${escapeHtml(fallback)}</p>`;
  }

  return `<ul class="plain-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderTwinSummary(report) {
  return `
    <section class="report-section">
      <h3>Twin 画像摘要</h3>
      <div class="report-topline">
        <span class="badge promising">${escapeHtml(report.twinSummary.profileLabel)}</span>
      </div>
      <p class="summary">${escapeHtml(report.twinSummary.summary)}</p>
      ${renderSimpleList(report.twinSummary.anchors || [], "当前还没有足够的画像锚点。")}
    </section>
  `;
}

function renderRealitySummary(report) {
  const selfItems = (report.realitySummary?.selfReality || []).map((item) => `${item.label}：${item.valueLabel}`);

  return `
    <section class="report-section">
      <h3>现实条件摘要</h3>
      <div class="subsection">
        <strong>我的现实情况</strong>
        ${renderSimpleList(selfItems, "这次还没有填写结构化现实条件。")}
      </div>
    </section>
  `;
}

function renderShortlist(report) {
  const shortlist = report.shortlist || [];

  return `
    <section class="report-section">
      <h3>Phase 1 初筛 shortlist</h3>
      <div class="stack-list">
        ${
          shortlist.length
            ? shortlist
                .map((candidate) => {
                  const realityLine = (candidate.realitySummary || [])
                    .map((item) => `${item.label}：${item.valueLabel}`)
                    .join(" / ");

                  return `
                    <article class="stack-item">
                      <header>
                        <strong>${escapeHtml(candidate.displayName)} · ${escapeHtml(String(candidate.age))} 岁 · ${escapeHtml(candidate.city)}</strong>
                        ${renderPill(candidate.matchBandKey, candidate.matchBandLabel)}
                      </header>
                      <p><strong>职业：</strong>${escapeHtml(candidate.occupation)} · <strong>认证：</strong>${escapeHtml(candidate.verificationLevel)}</p>
                      <p><strong>匹配分：</strong>${escapeHtml(String(candidate.matchScore))}/100</p>
                      <p><strong>候选摘要：</strong>${escapeHtml(candidate.summary)}</p>
                      <p><strong>亮点：</strong>${escapeHtml((candidate.highlights || []).join("、") || "暂无")}</p>
                      <p><strong>现实条件：</strong>${escapeHtml(realityLine || "暂无")}</p>
                      <p><strong>推荐理由：</strong>${escapeHtml((candidate.matchedReasons || []).join("、") || "暂无")}</p>
                      <p><strong>需要留意：</strong>${escapeHtml((candidate.cautionPoints || []).join("、") || "当前没有明显结构性风险。")}</p>
                      <p><strong>下一阶段重点：</strong>${escapeHtml((candidate.nextPhaseFocus || []).join("、") || "暂无")}</p>
                    </article>
                  `;
                })
                .join("")
            : `<article class="stack-item"><p>当前没有 shortlist 结果。</p></article>`
        }
      </div>
    </section>
  `;
}

function renderPrechatPlanner(matches, twin) {
  const goals = twin?.twinProfile?.prechatGoals || {};
  const selectedMatchIds = new Set(goals.selectedMatchIds || []);
  const selectedObjectiveKeys = new Set(
    Array.isArray(goals.selectedObjectiveKeys) && goals.selectedObjectiveKeys.length
      ? goals.selectedObjectiveKeys
      : OBJECTIVE_OPTIONS.map((item) => item.key)
  );

  return `
    <section class="report-section">
      <h3>预沟通确认</h3>
      <p class="summary">
        先由你筛选要进入 Twin-Twin 预沟通的对象，并确认这一轮优先核实的目标。确认后系统会自动推进非敏感预沟通，你不需要再手动点“继续一轮”。
      </p>
      ${
        matches.length
          ? `
            <form id="prechat-plan-form" class="stack-list">
              <article class="stack-item">
                <header><strong>选择预沟通对象</strong></header>
                <div class="plain-list">
                  ${matches
                    .map(
                      (match) => `
                        <label>
                          <input
                            type="checkbox"
                            name="matchId"
                            value="${escapeHtml(match.id)}"
                            ${selectedMatchIds.has(match.id) ? "checked" : ""}
                          />
                          ${escapeHtml(match.counterpart.displayName)} · ${escapeHtml(match.counterpart.profileLabel || "待补充画像")}
                        </label>
                      `
                    )
                    .join("")}
                </div>
              </article>
              <article class="stack-item">
                <header><strong>确认预沟通目标</strong></header>
                <div class="plain-list">
                  ${OBJECTIVE_OPTIONS.map(
                    (item) => `
                      <label>
                        <input
                          type="checkbox"
                          name="objectiveKey"
                          value="${escapeHtml(item.key)}"
                          ${selectedObjectiveKeys.has(item.key) ? "checked" : ""}
                        />
                        ${escapeHtml(item.label)}
                      </label>
                    `
                  ).join("")}
                </div>
              </article>
              <div class="page-actions">
                <button class="primary-button" type="submit">确认目标并自动开始预沟通</button>
              </div>
            </form>
          `
          : `<article class="stack-item"><p>当前还没有可进入真实预沟通的平台注册对象。请先让另一位用户完成 Twin 建档。</p></article>`
      }
    </section>
  `;
}

function renderPrechatOverview(report) {
  const overview = report.prechatOverview || {
    totalSessions: 0,
    activeCount: 0,
    waitingAcceptanceCount: 0,
    waitingSensitiveApprovalCount: 0,
    pausedCount: 0,
    handoffReadyCount: 0,
    items: []
  };

  return `
    <section class="report-section">
      <h3>预沟通控制台</h3>
      <p class="summary">
        这里展示已经确认并启动的 Twin-Twin 预沟通。进入会话后，系统会自动推进，只有敏感授权、人工补充或风险暂停时才需要你介入。
      </p>
      <div class="meta-grid">
        <article class="stack-item">
          <strong>已启动</strong>
          <p>${escapeHtml(String(overview.totalSessions))} 个会话</p>
        </article>
        <article class="stack-item">
          <strong>进行中</strong>
          <p>${escapeHtml(String(overview.activeCount))} 个</p>
        </article>
        <article class="stack-item">
          <strong>等对方接受</strong>
          <p>${escapeHtml(String(overview.waitingAcceptanceCount))} 个</p>
        </article>
        <article class="stack-item">
          <strong>待敏感授权</strong>
          <p>${escapeHtml(String(overview.waitingSensitiveApprovalCount))} 个</p>
        </article>
      </div>
      <div class="stack-list">
        ${
          overview.items.length
            ? overview.items
                .map(
                  (item) => `
                    <article class="stack-item">
                      <header>
                        <strong>${escapeHtml(item.counterpart.displayName)}</strong>
                        <span class="pill ${escapeHtml(getPrechatStatusTone(item.status))}">${escapeHtml(getPrechatStatusLabel(item.status))}</span>
                      </header>
                      <p><strong>标签：</strong>${escapeHtml(item.counterpart.profileLabel || "暂无")}</p>
                      <p><strong>匹配判断：</strong>${escapeHtml(item.scoreLabel || "暂无")}</p>
                      <p><strong>理由：</strong>${escapeHtml((item.reasons || []).join("、") || "暂无")}</p>
                      <div class="page-actions">
                        <a class="secondary-button link-button" href="/prechat-session.html?sessionId=${encodeURIComponent(item.sessionId)}">查看会话</a>
                      </div>
                    </article>
                  `
                )
                .join("")
            : `<article class="stack-item"><p>你还没有确认任何 Twin-Twin 预沟通计划。</p></article>`
        }
      </div>
    </section>
  `;
}

function renderProfileGaps(report) {
  const gaps = report.profileGaps || [];

  return `
    <section class="report-section">
      <h3>用户画像缺口</h3>
      <div class="stack-list">
        ${
          gaps.length
            ? gaps
                .map(
                  (gap) => `
                    <article class="stack-item">
                      <header>
                        <strong>${escapeHtml(gap.dimension)}</strong>
                        ${renderPill(gap.priority, gap.priorityLabel)}
                      </header>
                      <p>${escapeHtml(gap.reason)}</p>
                    </article>
                  `
                )
                .join("")
            : `<article class="stack-item"><p>当前画像已经具备基础匹配条件，没有明显高优先级缺口。</p></article>`
        }
      </div>
    </section>
  `;
}

function renderSuggestedCompletions(report) {
  const items = report.suggestedCompletions || [];

  return `
    <section class="report-section">
      <h3>建议补充的信息</h3>
      <div class="stack-list">
        ${
          items.length
            ? items
                .map(
                  (item) => `
                    <article class="stack-item">
                      <header>
                        <strong>${escapeHtml(item.label)}</strong>
                        ${renderPill("low", "选填建议")}
                      </header>
                      <p>${escapeHtml(item.reason)}</p>
                    </article>
                  `
                )
                .join("")
            : `<article class="stack-item"><p>这次已经补充了较完整的结构化现实条件。</p></article>`
        }
      </div>
    </section>
  `;
}

function renderReport(report, matches, twin) {
  const topCandidate = report.shortlist?.[0];

  reportShell.classList.remove("empty");
  reportShell.innerHTML = `
    <div class="report-topline">
      <p class="eyebrow">生成时间：${escapeHtml(new Date(report.createdAt).toLocaleString())}</p>
      <span class="badge promising">${escapeHtml(report.phaseLabel)}</span>
    </div>
    <div class="score">${escapeHtml(String(report.overview.shortlistCount))} 人</div>
    <p class="summary">${escapeHtml(report.overview.headline)}</p>
    <p class="summary">
      现实条件排除：${escapeHtml(String(report.overview.excludedByRealityCount))} 人 · 下一阶段就绪：${escapeHtml(String(report.overview.nextPhaseReadyCount))} 人
    </p>
    ${
      topCandidate
        ? `<p class="summary">当前 Top 1 推荐为 ${escapeHtml(topCandidate.displayName)}，匹配分 ${escapeHtml(String(topCandidate.matchScore))}。</p>`
        : ""
    }

    <div class="report-grid">
      ${renderPrechatPlanner(matches, twin)}
      ${renderPrechatOverview(report)}
      ${renderTwinSummary(report)}
      ${renderRealitySummary(report)}
      ${renderShortlist(report)}
      ${renderProfileGaps(report)}
      ${renderSuggestedCompletions(report)}
      <section class="report-section">
        <h3>下一步建议</h3>
        <ul class="plain-list">
          ${(report.nextSteps || []).map((step) => `<li>${escapeHtml(step)}</li>`).join("")}
        </ul>
      </section>
    </div>
  `;
}

function renderError(message) {
  reportShell.classList.add("empty");
  reportShell.innerHTML = renderEmptyState("无法打开匹配结果", message, "报告不可用");
}

async function loadReportView(reportId) {
  const [{ report }, { matches }, { twin }] = await Promise.all([
    fetchJson(`/api/reports/${encodeURIComponent(reportId)}`),
    fetchJson("/api/matches"),
    fetchJson("/api/twin")
  ]);

  const versionText = report.twinVersionNumber
    ? `${report.twinSummary.displayName} · v${report.twinVersionNumber}`
    : report.twinSummary.displayName;

  reportHeroText.textContent = report.overview.headline;
  reportProfileText.textContent = versionText;
  renderReport(report, matches, twin);
  bindPlannerForm(reportId);
}

function bindPlannerForm(reportId) {
  const form = document.querySelector("#prechat-plan-form");

  if (!form) {
    return;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const data = new FormData(form);
    const matchIds = data.getAll("matchId").map((item) => String(item));
    const objectiveKeys = data.getAll("objectiveKey").map((item) => String(item));
    const button = form.querySelector('button[type="submit"]');

    try {
      if (button) {
        button.disabled = true;
        button.textContent = "正在确认并启动...";
      }

      await fetchJson("/api/prechat/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchIds, objectiveKeys })
      });

      await loadReportView(reportId);
    } catch (error) {
      window.alert(error.message);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "确认目标并自动开始预沟通";
      }
    }
  });
}

const reportId = new URL(window.location.href).searchParams.get("reportId");

await requireAuth();

if (!reportId) {
  renderError("缺少 reportId。请返回首页重新生成匹配报告。");
} else {
  try {
    await loadReportView(reportId);
  } catch (error) {
    renderError(error.message);
  }
}
