import {
  escapeHtml,
  fetchJson,
  formatDateTime,
  localizeDisplayText,
  logout,
  renderEmptyState,
  requireAuth
} from "./common.js";

const reportsList = document.querySelector("#reports-list");
const reportsStatus = document.querySelector("#reports-status");
const logoutButton = document.querySelector("#logout-button");

function setStatus(state, message) {
  reportsStatus.dataset.state = state;
  reportsStatus.textContent = message;
}

function renderReports(reports) {
  if (!reports.length) {
    reportsList.innerHTML = `
      <article class="history-item">
        <p>当前还没有匹配报告。请先回到“我的 Twin”页生成第一份报告。</p>
      </article>
    `;
    return;
  }

  reportsList.innerHTML = reports
    .map(
      (report) => `
        <article class="history-item">
          <header>
            <strong>${escapeHtml(localizeDisplayText(report.overview?.headline, report.id))}</strong>
            <span class="pill low">${escapeHtml(formatDateTime(report.createdAt))}</span>
          </header>
          <p>${escapeHtml(localizeDisplayText(report.twinSummary?.summary, "暂无摘要。"))}</p>
          <div class="pair">
            <span>shortlist：${escapeHtml(String(report.overview?.shortlistCount ?? 0))} 人</span>
            <span>下一阶段就绪：${escapeHtml(String(report.overview?.nextPhaseReadyCount ?? 0))} 人</span>
          </div>
          <div class="page-actions">
            <a class="secondary-button link-button" href="/report.html?reportId=${encodeURIComponent(report.id)}">打开结果页</a>
          </div>
        </article>
      `
    )
    .join("");
}

async function loadReports() {
  setStatus("saving", "正在加载匹配报告...");

  const { reports } = await fetchJson("/api/reports");
  renderReports(reports);
  setStatus("saved", `已加载 ${reports.length} 份匹配报告`);
}

logoutButton?.addEventListener("click", () => logout());

const auth = await requireAuth();

if (auth) {
  try {
    await loadReports();
  } catch (error) {
    reportsList.innerHTML = renderEmptyState("无法加载匹配报告", error.message, "匹配报告");
    setStatus("error", `加载失败：${error.message}`);
  }
}
