const MODE_OPTIONS = [
  { value: "ignore", label: "不纳入匹配" },
  { value: "prefer", label: "加分偏好" },
  { value: "require", label: "必须满足" },
  { value: "reject", label: "不接受" }
];

const samplePayload = {
  twinProfile: {
    displayName: "雨涵",
    relationshipGoal: "认真长期关系，希望以结婚为目标",
    cities: "上海、杭州",
    mustHaves: "情绪稳定、愿意认真经营关系、能直接沟通",
    hardStops: "早期借钱、赌博、高消费",
    communicationStyle: "直接、稳定回复、不喜欢反复试探",
    marriageTimeline: "如果匹配，希望 1 到 2 年内推进",
    childrenPreference: "希望未来要孩子，但不想立刻推进生育",
    familyBoundary: "尊重父母，但婚后更偏独立小家庭",
    financialView: "务实稳定，不接受隐性负债",
    selfSummary: "更重视长期稳定和现实可推进性，不想在目标模糊的人身上花太多时间。",
    authorizedSensitiveTopics: [
      "finance_and_debt",
      "family_boundaries",
      "marriage_and_housing_logistics",
      "fertility_and_children"
    ],
    selfReality: {
      incomeBand: "30k_to_50k",
      incomeStability: "stable",
      debtLevel: "mortgage_or_car_loan_only",
      housingStatus: "renting_independently",
      vehicleStatus: "none",
      siblingStructure: "only_child",
      parentCareBurden: "medium",
      postMaritalLivingPreference: "independent_home"
    },
    partnerRealityPreferences: {
      incomeBand: { mode: "prefer", values: ["30k_to_50k", "50k_plus"] },
      housingStatus: { mode: "prefer", values: ["own_with_loan", "own_without_loan"] },
      parentCareBurden: { mode: "require", values: ["low", "medium"] },
      postMaritalLivingPreference: {
        mode: "require",
        values: ["independent_home", "near_parents"]
      }
    }
  }
};

const form = document.querySelector("#matching-form");
const reportShell = document.querySelector("#report-shell");
const historyList = document.querySelector("#history-list");
const profileList = document.querySelector("#profile-list");
const statusText = document.querySelector("#status-text");
const profileStateText = document.querySelector("#profile-state-text");
const sampleButton = document.querySelector("#sample-button");
const saveProfileButton = document.querySelector("#save-profile-button");
const newProfileButton = document.querySelector("#new-profile-button");
const topicContainer = document.querySelector("#topic-checkboxes");
const selfRealityContainer = document.querySelector("#reality-self-fields");
const preferenceContainer = document.querySelector("#reality-preference-fields");

let appConfig = {
  realityFieldDefs: [],
  sensitiveTopicCategories: [],
  candidatePoolSize: 0
};
let reportCache = [];
let profileCache = [];
let currentProfileId = "";

function escapeHtml(value) {
  return String(value ?? "")
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

function renderPill(tone, label) {
  return `<span class="pill ${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
}

function updateProfileState() {
  const currentProfile = profileCache.find((profile) => profile.id === currentProfileId);

  if (!currentProfile) {
    profileStateText.textContent = "当前为未保存档案。";
    return;
  }

  const cities = currentProfile.cities || "未填写城市";
  profileStateText.textContent = `当前档案：${currentProfile.displayName} · ${cities}`;
}

function buildTwinProfilePayload() {
  const data = new FormData(form);
  const checkedTopics = [...form.querySelectorAll('input[name="topic"]:checked')].map(
    (input) => input.value
  );
  const selfReality = {};
  const partnerRealityPreferences = {};

  for (const field of appConfig.realityFieldDefs) {
    selfReality[field.key] = data.get(`selfReality_${field.key}`) || "";
    partnerRealityPreferences[field.key] = {
      mode: data.get(`preferenceMode_${field.key}`) || "ignore",
      values: [
        ...form.querySelectorAll(`input[name="preferenceValue_${field.key}"]:checked`)
      ].map((input) => input.value)
    };
  }

  return {
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
    authorizedSensitiveTopics: checkedTopics,
    selfReality,
    partnerRealityPreferences
  };
}

function renderOptionChips(field, prefix) {
  return field.options
    .map(
      (option) => `
        <label class="option-chip">
          <input type="checkbox" name="${escapeHtml(prefix)}" value="${escapeHtml(option.value)}" />
          <span>${escapeHtml(option.label)}</span>
        </label>
      `
    )
    .join("");
}

function renderTopicCheckboxes(topics) {
  topicContainer.innerHTML = topics
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

function renderRealitySelfFields(fields) {
  selfRealityContainer.innerHTML = fields
    .map(
      (field) => `
        <label>
          <span>${escapeHtml(field.label)}</span>
          <select name="selfReality_${escapeHtml(field.key)}">
            <option value="">暂不填写</option>
            ${field.options
              .map(
                (option) =>
                  `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`
              )
              .join("")}
          </select>
        </label>
      `
    )
    .join("");
}

function renderRealityPreferenceFields(fields) {
  preferenceContainer.innerHTML = fields
    .map(
      (field) => `
        <section class="preference-row">
          <div class="preference-head">
            <div>
              <strong>${escapeHtml(field.label)}</strong>
              <p>可按偏好、必须项或排除项设置。</p>
            </div>
            <select name="preferenceMode_${escapeHtml(field.key)}" data-preference-mode="${escapeHtml(field.key)}">
              ${MODE_OPTIONS.map(
                (mode) =>
                  `<option value="${escapeHtml(mode.value)}">${escapeHtml(mode.label)}</option>`
              ).join("")}
            </select>
          </div>
          <div class="option-chip-group" data-preference-values="${escapeHtml(field.key)}">
            ${renderOptionChips(field, `preferenceValue_${field.key}`)}
          </div>
        </section>
      `
    )
    .join("");
}

function syncPreferenceValuesAvailability() {
  for (const field of appConfig.realityFieldDefs) {
    const modeSelect = form.elements[`preferenceMode_${field.key}`];
    const group = preferenceContainer.querySelector(`[data-preference-values="${field.key}"]`);
    const disabled = !modeSelect || modeSelect.value === "ignore";

    if (!group) continue;

    group.classList.toggle("disabled", disabled);
    for (const input of group.querySelectorAll("input")) {
      input.disabled = disabled;
      if (disabled) {
        input.checked = false;
      }
    }
  }
}

function fillFormFromProfile(twinProfile) {
  form.reset();

  form.elements.twinDisplayName.value = twinProfile.displayName || "";
  form.elements.twinRelationshipGoal.value = twinProfile.relationshipGoal || "";
  form.elements.twinCities.value = twinProfile.cities || "";
  form.elements.twinMustHaves.value = twinProfile.mustHaves || "";
  form.elements.twinHardStops.value = twinProfile.hardStops || "";
  form.elements.twinCommunicationStyle.value = twinProfile.communicationStyle || "";
  form.elements.twinMarriageTimeline.value = twinProfile.marriageTimeline || "";
  form.elements.twinChildrenPreference.value = twinProfile.childrenPreference || "";
  form.elements.twinFamilyBoundary.value = twinProfile.familyBoundary || "";
  form.elements.twinFinancialView.value = twinProfile.financialView || "";
  form.elements.twinSelfSummary.value = twinProfile.selfSummary || "";

  for (const input of form.querySelectorAll('input[name="topic"]')) {
    input.checked = (twinProfile.authorizedSensitiveTopics || []).includes(input.value);
  }

  for (const field of appConfig.realityFieldDefs) {
    const selfField = form.elements[`selfReality_${field.key}`];
    const preferenceMode = form.elements[`preferenceMode_${field.key}`];
    const preferenceConfig = twinProfile.partnerRealityPreferences?.[field.key] || {
      mode: "ignore",
      values: []
    };

    if (selfField) {
      selfField.value = twinProfile.selfReality?.[field.key] || "";
    }

    if (preferenceMode) {
      preferenceMode.value = preferenceConfig.mode || "ignore";
    }

    for (const input of form.querySelectorAll(`input[name="preferenceValue_${field.key}"]`)) {
      input.checked = (preferenceConfig.values || []).includes(input.value);
    }
  }

  syncPreferenceValuesAvailability();
}

function clearCurrentProfile() {
  currentProfileId = "";
  form.reset();
  syncPreferenceValuesAvailability();
  updateProfileState();
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
      ${renderSimpleList(report.twinSummary.anchors, "当前还没有足够画像锚点。")}
    </section>
  `;
}

function renderRealitySummary(report) {
  const selfItems = report.realitySummary.selfReality.map(
    (item) => `${item.label}：${item.valueLabel}`
  );
  const preferenceItems = report.realitySummary.partnerPreferences.map(
    (item) => `${item.label}：${item.modeLabel}（${item.valueLabels.join("、")}）`
  );

  return `
    <section class="report-section">
      <h3>现实条件摘要</h3>
      <div class="subsection">
        <strong>我的现实情况</strong>
        ${renderSimpleList(selfItems, "这次还没有填写结构化现实条件。")}
      </div>
      <div class="subsection">
        <strong>我对对方的现实条件偏好</strong>
        ${renderSimpleList(preferenceItems, "这次还没有设置结构化现实条件偏好。")}
      </div>
    </section>
  `;
}

function renderShortlist(report) {
  return `
    <section class="report-section">
      <h3>数据库匹配 shortlist</h3>
      <div class="stack-list">
        ${report.shortlist
          .map((candidate) => {
            const realityLine = candidate.realitySummary
              .map((item) => `${item.label}：${item.valueLabel}`)
              .join(" / ");
            const findingLine = candidate.realityFindings.map((item) => item.summary).join(" ");

            return `
              <article class="stack-item">
                <header>
                  <strong>${escapeHtml(candidate.displayName)} · ${escapeHtml(String(candidate.age))} 岁 · ${escapeHtml(candidate.city)}</strong>
                  ${renderPill(candidate.matchBandKey, candidate.matchBandLabel)}
                </header>
                <p><strong>职业：</strong>${escapeHtml(candidate.occupation)} · <strong>认证：</strong>${escapeHtml(candidate.verificationLevel)}</p>
                <p><strong>匹配分：</strong>${escapeHtml(String(candidate.matchScore))}/100</p>
                <p><strong>候选摘要：</strong>${escapeHtml(candidate.summary)}</p>
                <p><strong>亮点：</strong>${escapeHtml(candidate.highlights.join("、"))}</p>
                <p><strong>现实条件：</strong>${escapeHtml(realityLine)}</p>
                <p><strong>推荐理由：</strong>${escapeHtml(candidate.matchedReasons.join(" "))}</p>
                <p><strong>结构化现实判断：</strong>${escapeHtml(findingLine || "当前没有触发额外的结构化现实提醒。")}</p>
                <p><strong>需要留意：</strong>${escapeHtml(candidate.cautionPoints.length ? candidate.cautionPoints.join(" ") : "当前没有明显结构性风险。")}</p>
                <p><strong>进入下一阶段前重点确认：</strong>${escapeHtml(candidate.nextPhaseFocus.join(" "))}</p>
              </article>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function renderProfileGaps(report) {
  return `
    <section class="report-section">
      <h3>用户画像缺口</h3>
      <div class="stack-list">
        ${
          report.profileGaps.length
            ? report.profileGaps
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
  return `
    <section class="report-section">
      <h3>建议补充的信息</h3>
      <div class="stack-list">
        ${
          report.suggestedCompletions.length
            ? report.suggestedCompletions
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
            : `<article class="stack-item"><p>这次已经补充了完整的结构化现实条件层。</p></article>`
        }
      </div>
    </section>
  `;
}

function renderReport(report) {
  const topCandidate = report.shortlist[0];

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
      ${renderTwinSummary(report)}
      ${renderRealitySummary(report)}
      ${renderShortlist(report)}
      ${renderProfileGaps(report)}
      ${renderSuggestedCompletions(report)}
      <section class="report-section">
        <h3>下一步建议</h3>
        <ul class="plain-list">
          ${report.nextSteps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}
        </ul>
      </section>
    </div>
  `;
}

function renderProfiles() {
  if (!profileCache.length) {
    profileList.innerHTML = `<div class="history-item"><p>还没有保存的 Twin 档案。</p></div>`;
    return;
  }

  profileList.innerHTML = profileCache
    .map(
      (profile) => `
        <article class="history-item ${profile.id === currentProfileId ? "is-current" : ""}">
          <strong>${escapeHtml(profile.displayName)}</strong>
          <p>${escapeHtml(profile.relationshipGoal || "未填写关系目标")}</p>
          <p>${escapeHtml(profile.cities || "未填写城市偏好")}</p>
          <p>更新于：${escapeHtml(new Date(profile.updatedAt).toLocaleString())}</p>
          <div class="history-actions">
            <button type="button" data-profile-action="load" data-profile-id="${escapeHtml(profile.id)}">载入</button>
            <button type="button" data-profile-action="rematch" data-profile-id="${escapeHtml(profile.id)}">重新匹配</button>
          </div>
        </article>
      `
    )
    .join("");
}

function renderHistory() {
  if (!reportCache.length) {
    historyList.innerHTML = `<div class="history-item"><p>还没有保存的匹配报告。</p></div>`;
    return;
  }

  historyList.innerHTML = reportCache
    .map((report) => {
      const topCandidate = report.shortlist[0];

      return `
        <article class="history-item">
          <strong>${escapeHtml(report.twinSummary.displayName)}</strong>
          <p>${escapeHtml(report.twinSummary.profileLabel)}</p>
          <p>${escapeHtml(report.overview.headline)}</p>
          <p>Top 1：${escapeHtml(topCandidate ? topCandidate.displayName : "暂无")} ${topCandidate ? `· ${escapeHtml(topCandidate.matchBandLabel)}` : ""}</p>
          <p>${escapeHtml(new Date(report.createdAt).toLocaleString())}</p>
          <button type="button" data-report-id="${escapeHtml(report.id)}">打开报告</button>
        </article>
      `;
    })
    .join("");
}

async function loadConfig() {
  const config = await fetchJson("/api/config");
  appConfig = config;
  renderTopicCheckboxes(config.sensitiveTopicCategories);
  renderRealitySelfFields(config.realityFieldDefs);
  renderRealityPreferenceFields(config.realityFieldDefs);
  syncPreferenceValuesAvailability();
  statusText.textContent = `候选池已加载，共 ${config.candidatePoolSize} 人。`;
}

async function loadProfiles() {
  const { profiles } = await fetchJson("/api/profiles");
  profileCache = profiles;
  renderProfiles();
  updateProfileState();
}

async function loadHistory() {
  const { reports } = await fetchJson("/api/reports");
  reportCache = reports;
  renderHistory();
}

async function persistCurrentProfile() {
  const { profile } = await fetchJson("/api/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profileId: currentProfileId,
      twinProfile: buildTwinProfilePayload()
    })
  });

  currentProfileId = profile.id;
  await loadProfiles();
  updateProfileState();
  return profile;
}

async function openProfile(profileId) {
  const { profile } = await fetchJson(`/api/profiles/${encodeURIComponent(profileId)}`);
  currentProfileId = profile.id;
  fillFormFromProfile(profile.twinProfile);
  updateProfileState();
  return profile;
}

async function runMatching(payload) {
  const { report, profile } = await fetchJson("/api/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  currentProfileId = profile.id;
  await loadProfiles();
  await loadHistory();
  updateProfileState();
  renderReport(report);
  return report;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  statusText.textContent = "正在保存档案并生成匹配报告...";

  try {
    await runMatching({
      profileId: currentProfileId,
      twinProfile: buildTwinProfilePayload()
    });
    statusText.textContent = "匹配报告已生成，并已保存到数据库。";
  } catch (error) {
    statusText.textContent = error.message;
  }
});

form.addEventListener("change", (event) => {
  if (event.target.matches("[data-preference-mode]")) {
    syncPreferenceValuesAvailability();
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

profileList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-profile-id]");
  if (!button) return;

  const profileId = button.dataset.profileId;
  const action = button.dataset.profileAction;

  try {
    if (action === "load") {
      await openProfile(profileId);
      statusText.textContent = "Twin 档案已载入。";
      renderProfiles();
      return;
    }

    if (action === "rematch") {
      statusText.textContent = "正在基于已保存档案重新匹配...";
      await runMatching({ profileId });
      statusText.textContent = "已基于已保存档案重新生成匹配报告。";
    }
  } catch (error) {
    statusText.textContent = error.message;
  }
});

saveProfileButton.addEventListener("click", async () => {
  statusText.textContent = "正在保存 Twin 档案...";

  try {
    await persistCurrentProfile();
    statusText.textContent = "Twin 档案已保存。";
  } catch (error) {
    statusText.textContent = error.message;
  }
});

newProfileButton.addEventListener("click", () => {
  clearCurrentProfile();
  statusText.textContent = "已切换到新的空白档案。";
  renderProfiles();
});

sampleButton.addEventListener("click", () => {
  currentProfileId = "";
  fillFormFromProfile(samplePayload.twinProfile);
  updateProfileState();
  renderProfiles();
  statusText.textContent = "示例数据已载入。";
});

await loadConfig();
await loadProfiles();
await loadHistory();
