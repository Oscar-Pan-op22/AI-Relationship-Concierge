const samplePayload = {
  twinProfile: {
    displayName: "雨涵",
    relationshipGoal: "认真长期关系，希望以结婚为目标",
    cities: "上海，杭州",
    mustHaves: "情绪稳定，认真发展，能直接沟通",
    hardStops: "早期借钱，赌博，结婚意愿模糊",
    communicationStyle: "直接、稳定回复、不喜欢拉扯",
    marriageTimeline: "如果匹配，希望 1 到 2 年内考虑结婚",
    childrenPreference: "希望未来要孩子，但不想马上进入生育阶段",
    familyBoundary: "尊重父母，但婚后更偏独立小家庭",
    financialView: "务实稳定，不接受隐性负债文化",
    selfSummary: "更重视平稳一致，而不是一开始就情绪很强烈。不希望花几个月去猜对方到底想不想认真发展。",
    authorizedSensitiveTopics: [
      "finance_and_debt",
      "family_boundaries",
      "marriage_and_housing_logistics",
      "fertility_and_children"
    ]
  },
  candidateProfile: {
    displayName: "林予安",
    age: "30",
    city: "上海",
    occupation: "产品经理",
    relationshipGoal: "想找认真长期关系",
    profileText:
      "长期在上海工作，希望关系稳定发展，最终以结婚为目标。觉得家庭重要，但两个人应该有自己的小家庭空间。",
    chatSummary:
      "回复比较稳定，表达直接。提到未来可以要孩子，但现在不着急，想先把关系基础打稳。",
    notes: "整体给人的感觉比较温和克制。提到消费习惯偏务实，也希望长期留在上海发展。"
  }
};

const form = document.querySelector("#screening-form");
const reportShell = document.querySelector("#report-shell");
const historyList = document.querySelector("#history-list");
const statusText = document.querySelector("#status-text");
const sampleButton = document.querySelector("#sample-button");
const topicContainer = document.querySelector("#topic-checkboxes");

let reportCache = [];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "请求失败。");
  }
  return payload;
}

function collectPayload() {
  const data = new FormData(form);
  const checkedTopics = [...form.querySelectorAll('input[name="topic"]:checked')].map(
    (input) => input.value
  );

  return {
    twinProfile: {
      displayName: data.get("twinDisplayName"),
      relationshipGoal: data.get("twinRelationshipGoal"),
      cities: data.get("twinCities"),
      mustHaves: data.get("twinMustHaves"),
      hardStops: data.get("twinHardStops"),
      communicationStyle: data.get("twinCommunicationStyle"),
      marriageTimeline: data.get("twinMarriageTimeline"),
      childrenPreference: data.get("twinChildrenPreference"),
      familyBoundary: data.get("twinFamilyBoundary"),
      financialView: data.get("twinFinancialView"),
      selfSummary: data.get("twinSelfSummary"),
      authorizedSensitiveTopics: checkedTopics
    },
    candidateProfile: {
      displayName: data.get("candidateDisplayName"),
      age: data.get("candidateAge"),
      city: data.get("candidateCity"),
      occupation: data.get("candidateOccupation"),
      relationshipGoal: data.get("candidateRelationshipGoal"),
      profileText: data.get("candidateProfileText"),
      chatSummary: data.get("candidateChatSummary"),
      notes: data.get("candidateNotes")
    }
  };
}

function fillForm(payload) {
  form.elements.twinDisplayName.value = payload.twinProfile.displayName;
  form.elements.twinRelationshipGoal.value = payload.twinProfile.relationshipGoal;
  form.elements.twinCities.value = payload.twinProfile.cities;
  form.elements.twinMustHaves.value = payload.twinProfile.mustHaves;
  form.elements.twinHardStops.value = payload.twinProfile.hardStops;
  form.elements.twinCommunicationStyle.value = payload.twinProfile.communicationStyle;
  form.elements.twinMarriageTimeline.value = payload.twinProfile.marriageTimeline;
  form.elements.twinChildrenPreference.value = payload.twinProfile.childrenPreference;
  form.elements.twinFamilyBoundary.value = payload.twinProfile.familyBoundary;
  form.elements.twinFinancialView.value = payload.twinProfile.financialView;
  form.elements.twinSelfSummary.value = payload.twinProfile.selfSummary;

  form.elements.candidateDisplayName.value = payload.candidateProfile.displayName;
  form.elements.candidateAge.value = payload.candidateProfile.age;
  form.elements.candidateCity.value = payload.candidateProfile.city;
  form.elements.candidateOccupation.value = payload.candidateProfile.occupation;
  form.elements.candidateRelationshipGoal.value = payload.candidateProfile.relationshipGoal;
  form.elements.candidateProfileText.value = payload.candidateProfile.profileText;
  form.elements.candidateChatSummary.value = payload.candidateProfile.chatSummary;
  form.elements.candidateNotes.value = payload.candidateProfile.notes;

  for (const input of form.querySelectorAll('input[name="topic"]')) {
    input.checked = payload.twinProfile.authorizedSensitiveTopics.includes(input.value);
  }
}

function renderPill(tone, label) {
  return `<span class="pill ${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
}

function renderReport(report) {
  const fitClass = report.fitBand.toLowerCase().replaceAll(" ", "-");

  reportShell.classList.remove("empty");
  reportShell.innerHTML = `
    <div class="report-topline">
      <p class="eyebrow">生成时间：${new Date(report.createdAt).toLocaleString()}</p>
      <span class="badge ${fitClass}">${escapeHtml(report.fitBandLabel)}</span>
    </div>
    <div class="score">${escapeHtml(report.compatibilityScore)}/100</div>
    <p class="summary">${escapeHtml(report.summary)}</p>

    <div class="report-grid">
      <section class="report-section">
        <h3>匹配度矩阵</h3>
        <div class="matrix-list">
          ${report.compatibilityMatrix
            .map(
              (item) => `
                <article class="matrix-item">
                  <header>
                    <strong>${escapeHtml(item.label)}</strong>
                    ${renderPill(item.status, item.statusLabel)}
                  </header>
                  <div class="pair">
                    <span><strong>用户侧：</strong>${escapeHtml(item.userPosition)}</span>
                    <span><strong>候选人侧：</strong>${escapeHtml(item.candidatePosition)}</span>
                  </div>
                  <p>${escapeHtml(item.reason)}</p>
                </article>
              `
            )
            .join("")}
        </div>
      </section>

      <section class="report-section">
        <h3>风险信号</h3>
        <div class="stack-list">
          ${
            report.riskSignals.length
              ? report.riskSignals
                  .map(
                    (risk) => `
                      <article class="stack-item">
                        <header>
                          <strong>${escapeHtml(risk.label)}</strong>
                          ${renderPill(risk.severity, risk.severityLabel)}
                        </header>
                        <p>${escapeHtml(risk.whyItMatters)}</p>
                        <p><strong>证据：</strong>${escapeHtml(risk.evidence)}</p>
                      </article>
                    `
                  )
                  .join("")
              : `<article class="stack-item"><p>当前材料中暂未识别出明显风险关键词。</p></article>`
          }
        </div>
      </section>

      <section class="report-section">
        <h3>信息缺口</h3>
        <div class="stack-list">
          ${
            report.missingInformation.length
              ? report.missingInformation
                  .map(
                    (item) => `
                      <article class="stack-item">
                        <header>
                          <strong>${escapeHtml(item.dimension)}</strong>
                          ${renderPill(item.priority, item.priorityLabel)}
                        </header>
                        <p>${escapeHtml(item.reason)}</p>
                      </article>
                    `
                  )
                  .join("")
              : `<article class="stack-item"><p>当前没有明显的关键缺口需要优先补齐。</p></article>`
          }
        </div>
      </section>

      <section class="report-section">
        <h3>下一步建议</h3>
        <ul class="plain-list">
          ${report.nextSteps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}
        </ul>
      </section>

      <section class="report-section">
        <h3>提问草稿包</h3>
        <div class="stack-list">
          ${
            report.questionPack.length
              ? report.questionPack
                  .map(
                    (item) => `
                      <article class="stack-item">
                        <header>
                          <strong>${escapeHtml(item.dimension)}</strong>
                          ${renderPill(item.sensitivity, item.sensitivityLabel)}
                        </header>
                        <p><strong>议题类别：</strong>${escapeHtml(item.topicLabel)}</p>
                        <p>${escapeHtml(item.draft)}</p>
                        <p><strong>当前授权：</strong>${item.allowedByCurrentConsent ? "已授权" : "未授权"}</p>
                        <p>${escapeHtml(item.note)}</p>
                      </article>
                    `
                  )
                  .join("")
              : `<article class="stack-item"><p>当前材料下暂时不需要额外追问。</p></article>`
          }
        </div>
      </section>

      <section class="report-section">
        <h3>结构化提取结果</h3>
        <div class="stack-list">
          <article class="stack-item">
            <header><strong>Twin 侧事实</strong></header>
            <div class="pair">
              ${report.extractedFacts.twinFacts
                .map((fact) => `<span><strong>${escapeHtml(fact.label)}：</strong>${escapeHtml(fact.value)}</span>`)
                .join("")}
            </div>
          </article>
          <article class="stack-item">
            <header><strong>候选人侧事实</strong></header>
            <div class="pair">
              ${report.extractedFacts.candidateFacts
                .map((fact) => `<span><strong>${escapeHtml(fact.label)}：</strong>${escapeHtml(fact.value)}</span>`)
                .join("")}
            </div>
          </article>
        </div>
      </section>
    </div>
  `;
}

function renderHistory() {
  if (!reportCache.length) {
    historyList.innerHTML = `<div class="history-item"><p>还没有保存的报告。</p></div>`;
    return;
  }

  historyList.innerHTML = reportCache
    .map(
      (report) => `
        <article class="history-item">
          <strong>${escapeHtml(report.candidateProfile.displayName || "未命名候选人")}</strong>
          <p>${escapeHtml(report.fitBandLabel)} · ${escapeHtml(String(report.compatibilityScore))}/100</p>
          <p>${escapeHtml(new Date(report.createdAt).toLocaleString())}</p>
          <button type="button" data-report-id="${escapeHtml(report.id)}">打开报告</button>
        </article>
      `
    )
    .join("");
}

async function loadConfig() {
  const { sensitiveTopicCategories } = await fetchJson("/api/config");
  topicContainer.innerHTML = sensitiveTopicCategories
    .map(
      (topic) => `
        <label class="checkbox-card">
          <input type="checkbox" name="topic" value="${escapeHtml(topic.key)}" />
          <div>
            <strong>${escapeHtml(topic.label)}</strong>
            <p>${escapeHtml(topic.description)}</p>
          </div>
        </label>
      `
    )
    .join("");
}

async function loadHistory() {
  const { reports } = await fetchJson("/api/reports");
  reportCache = reports;
  renderHistory();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  statusText.textContent = "正在生成报告...";

  try {
    const { report } = await fetchJson("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectPayload())
    });
    reportCache.unshift(report);
    renderReport(report);
    renderHistory();
    statusText.textContent = "报告已生成，并已保存到本地。";
  } catch (error) {
    statusText.textContent = error.message;
  }
});

historyList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-report-id]");
  if (!button) return;
  const report = reportCache.find((item) => item.id === button.dataset.reportId);
  if (report) {
    renderReport(report);
  }
});

sampleButton.addEventListener("click", () => {
  fillForm(samplePayload);
  statusText.textContent = "示例数据已载入。";
});

await loadConfig();
await loadHistory();
