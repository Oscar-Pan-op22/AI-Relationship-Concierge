import { escapeHtml, fetchJson, requireAuth, renderEmptyState } from "./common.js";

const reportShell = document.querySelector("#report-shell");
const reportHeroText = document.querySelector("#report-hero-text");
const reportProfileText = document.querySelector("#report-profile-text");

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
  const selfItems = (report.realitySummary?.selfReality || []).map(
    (item) => `${item.label}：${item.valueLabel}`
  );

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
      <h3>数据库 shortlist</h3>
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
                      <p><strong>亮点：</strong>${escapeHtml((candidate.highlights || []).join("；") || "暂无")}</p>
                      <p><strong>现实条件：</strong>${escapeHtml(realityLine || "暂无")}</p>
                      <p><strong>推荐理由：</strong>${escapeHtml((candidate.matchedReasons || []).join("；") || "暂无")}</p>
                      <p><strong>需要留意：</strong>${escapeHtml((candidate.cautionPoints || []).join("；") || "当前没有明显结构性风险。")}</p>
                      <p><strong>下一阶段重点：</strong>${escapeHtml((candidate.nextPhaseFocus || []).join("；") || "暂无")}</p>
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
        初筛报告生成后，系统会自动为真实用户匹配对象发起 Twin-Twin 非敏感预沟通。
      </p>
      <div class="meta-grid">
        <article class="stack-item">
          <strong>已自动发起</strong>
          <p>${escapeHtml(String(overview.totalSessions))} 个会话</p>
        </article>
        <article class="stack-item">
          <strong>进行中</strong>
          <p>${escapeHtml(String(overview.activeCount))} 个</p>
        </article>
        <article class="stack-item">
          <strong>待对方接受</strong>
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
                        <span class="pill ${escapeHtml(item.status === "active" ? "ok" : item.status === "awaiting_counterparty_acceptance" ? "medium" : "low")}">${escapeHtml(item.status)}</span>
                      </header>
                      <p><strong>标签：</strong>${escapeHtml(item.counterpart.profileLabel || "暂无")}</p>
                      <p><strong>状态：</strong>${escapeHtml(item.scoreLabel || "暂无")}</p>
                      <p><strong>理由：</strong>${escapeHtml((item.reasons || []).join("；") || "暂无")}</p>
                      <div class="page-actions">
                        <a class="secondary-button link-button" href="/prechat-session.html?sessionId=${encodeURIComponent(item.sessionId)}">查看会话</a>
                      </div>
                    </article>
                  `
                )
                .join("")
            : `<article class="stack-item"><p>当前还没有可自动发起的真实用户预沟通对象。请先让另一位用户完成 Twin 建档。</p></article>`
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

function renderReport(report) {
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
      现实条件排除：${escapeHtml(String(report.overview.excludedByRealityCount))} 人
      · 下一阶段就绪：${escapeHtml(String(report.overview.nextPhaseReadyCount))} 人
    </p>
    ${
      topCandidate
        ? `<p class="summary">当前 Top 1 推荐为 ${escapeHtml(topCandidate.displayName)}，匹配分 ${escapeHtml(String(topCandidate.matchScore))}。</p>`
        : ""
    }

    <div class="report-grid">
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

const reportId = new URL(window.location.href).searchParams.get("reportId");

await requireAuth();

if (!reportId) {
  renderError("缺少 reportId。请返回首页重新生成匹配报告。");
} else {
  try {
    const { report } = await fetchJson(`/api/reports/${encodeURIComponent(reportId)}`);
    const versionText = report.twinVersionNumber
      ? `${report.twinSummary.displayName} · v${report.twinVersionNumber}`
      : report.twinSummary.displayName;

    reportHeroText.textContent = report.overview.headline;
    reportProfileText.textContent = versionText;
    renderReport(report);
  } catch (error) {
    renderError(error.message);
  }
}
