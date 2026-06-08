import {
  escapeHtml,
  fetchJson,
  localizeDisplayText,
  logout,
  requireAuth
} from "./common.js";

const matchesList = document.querySelector("#matches-list");
const statusText = document.querySelector("#matches-status");
const logoutButton = document.querySelector("#logout-button");

function setStatus(state, message) {
  statusText.dataset.state = state;
  statusText.textContent = message;
}

function renderMatches(matches) {
  if (!matches.length) {
    matchesList.innerHTML = `
      <article class="stack-item">
        <p>当前还没有可发起预沟通的对象。你可以等待更多用户完成 Twin 建档，或先去“所有会话”查看已开始的预沟通。</p>
      </article>
    `;
    return;
  }

  matchesList.innerHTML = matches
    .map(
      (match) => `
        <article class="stack-item">
          <header>
            <strong>${escapeHtml(match.counterpart.displayName)}</strong>
            <span class="pill ok">${escapeHtml(String(match.score))} 分</span>
          </header>
          <p><strong>资料标签：</strong>${escapeHtml(localizeDisplayText(match.counterpart.profileLabel, "未填写"))}</p>
          <p><strong>关系目标：</strong>${escapeHtml(localizeDisplayText(match.counterpart.relationshipGoal, "未填写"))}</p>
          <p><strong>偏好城市：</strong>${escapeHtml(localizeDisplayText(match.counterpart.cities, "未填写"))}</p>
          <p><strong>简介：</strong>${escapeHtml(localizeDisplayText(match.counterpart.summary, "暂无简介"))}</p>
          <p><strong>匹配判断：</strong>${escapeHtml(localizeDisplayText(match.scoreLabel, "暂无"))}</p>
          <p><strong>推荐理由：</strong>${escapeHtml((match.reasons || []).map((item) => localizeDisplayText(item)).filter(Boolean).join("；") || "暂无")}</p>
          <div class="page-actions">
            <button class="primary-button" type="button" data-match-id="${escapeHtml(match.id)}">发起预沟通邀请</button>
          </div>
        </article>
      `
    )
    .join("");
}

async function loadMatches() {
  setStatus("saving", "正在加载可发起对象...");
  const { matches } = await fetchJson("/api/matches");
  renderMatches(matches);
  setStatus("saved", `已加载 ${matches.length} 个可发起对象`);
}

matchesList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-match-id]");

  if (!button) {
    return;
  }

  try {
    setStatus("saving", "正在发起预沟通邀请...");
    const { session } = await fetchJson(
      `/api/matches/${encodeURIComponent(button.dataset.matchId)}/invite-prechat`,
      {
        method: "POST"
      }
    );
    window.location.href = `/prechat-session.html?sessionId=${encodeURIComponent(session.id)}`;
  } catch (error) {
    setStatus("error", `邀请失败：${error.message}`);
  }
});

logoutButton.addEventListener("click", () => logout());

const auth = await requireAuth();
if (auth) {
  await loadMatches();
}
