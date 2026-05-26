import { escapeHtml, fetchJson, logout, requireAuth } from "./common.js";

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
        <p>还没有可展示的双边匹配。请先在另一个账号里也完成 Twin 建档。</p>
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
          <p><strong>资料标签：</strong>${escapeHtml(match.counterpart.profileLabel)}</p>
          <p><strong>关系目标：</strong>${escapeHtml(match.counterpart.relationshipGoal || "未填写")}</p>
          <p><strong>偏好城市：</strong>${escapeHtml(match.counterpart.cities || "未填写")}</p>
          <p><strong>简介：</strong>${escapeHtml(match.counterpart.summary)}</p>
          <p><strong>匹配判断：</strong>${escapeHtml(match.scoreLabel)}</p>
          <p><strong>推荐理由：</strong>${escapeHtml((match.reasons || []).join("；") || "暂无")}</p>
          <div class="page-actions">
            ${
              match.openSession
                ? `<a class="secondary-button link-button" href="/prechat-session.html?sessionId=${encodeURIComponent(match.openSession.id)}">查看会话</a>`
                : `<button class="primary-button" type="button" data-match-id="${escapeHtml(match.id)}">发起预沟通邀请</button>`
            }
          </div>
        </article>
      `
    )
    .join("");
}

async function loadMatches() {
  setStatus("saving", "正在加载匹配列表...");
  const { matches } = await fetchJson("/api/matches");
  renderMatches(matches);
  setStatus("saved", `已加载 ${matches.length} 个匹配对象。`);
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

await requireAuth();
await loadMatches();
