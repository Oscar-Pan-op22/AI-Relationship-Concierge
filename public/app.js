import { escapeHtml, fetchJson, formatDateTime, logout, requireAuth } from "./common.js";

const MODE_OPTIONS = [
  { value: "ignore", label: "不纳入匹配" },
  { value: "prefer", label: "加分偏好" },
  { value: "require", label: "必须满足" },
  { value: "reject", label: "不接受" }
];

const samplePayload = {
  displayName: "雨涵",
  relationshipGoal: "认真长期关系，希望以结婚为目标",
  cities: "上海、杭州",
  mustHaves: "情绪稳定、愿意认真经营关系、能直接沟通",
  hardStops: "借钱、赌博、高消费失控",
  communicationStyle: "直接、稳定回复，不喜欢反复试探",
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
};

const form = document.querySelector("#matching-form");
const currentTwinShell = document.querySelector("#current-twin-shell");
const statusText = document.querySelector("#status-text");
const profileStateText = document.querySelector("#profile-state-text");
const sampleButton = document.querySelector("#sample-button");
const saveTwinButton = document.querySelector("#save-twin-button");
const resetFormButton = document.querySelector("#reset-form-button");
const logoutButton = document.querySelector("#logout-button");
const topicContainer = document.querySelector("#topic-checkboxes");
const selfRealityContainer = document.querySelector("#reality-self-fields");
const preferenceContainer = document.querySelector("#reality-preference-fields");

const AUTO_SAVE_DELAY_MS = 1200;

let appConfig = {
  realityFieldDefs: [],
  sensitiveTopicCategories: []
};
let currentTwin = null;
let autoSaveTimer = null;
let lastPersistedSnapshot = "";

function asDisplayText(value, fallback = "未填写") {
  if (Array.isArray(value)) {
    return value.length ? value.join("、") : fallback;
  }

  const text = String(value ?? "").trim();
  return text || fallback;
}

function setStatus(state, message) {
  statusText.dataset.state = state;
  statusText.textContent = message;
}

function setSavedStatus(auto = false) {
  setStatus(
    "saved",
    `${auto ? "已自动保存" : "已保存"}于 ${new Date().toLocaleTimeString()}`
  );
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

function renderRealityPreferenceFields(fields) {
  preferenceContainer.innerHTML = fields
    .map(
      (field) => `
        <section class="preference-row">
          <div class="preference-head">
            <div>
              <strong>${escapeHtml(field.label)}</strong>
              <p>按偏好、必须项或排斥项设置。</p>
            </div>
            <select name="preferenceMode_${escapeHtml(field.key)}" data-preference-mode="${escapeHtml(field.key)}">
              ${MODE_OPTIONS.map(
                (mode) => `<option value="${escapeHtml(mode.value)}">${escapeHtml(mode.label)}</option>`
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
    const inputs = preferenceContainer.querySelectorAll(`input[name="preferenceValue_${field.key}"]`);
    const disabled = !modeSelect || modeSelect.value === "ignore";

    inputs.forEach((input) => {
      input.disabled = disabled;
      if (disabled) {
        input.checked = false;
      }
    });
  }
}

function buildTwinProfilePayload() {
  const data = new FormData(form);
  const selfReality = {};
  const partnerRealityPreferences = {};

  for (const field of appConfig.realityFieldDefs) {
    selfReality[field.key] = data.get(`selfReality_${field.key}`) || "";
    partnerRealityPreferences[field.key] = {
      mode: data.get(`preferenceMode_${field.key}`) || "ignore",
      values: [...form.querySelectorAll(`input[name="preferenceValue_${field.key}"]:checked`)].map(
        (input) => input.value
      )
    };
  }

  return {
    displayName: data.get("twinDisplayName") || "",
    relationshipGoal: data.get("twinRelationshipGoal") || "",
    cities: data.get("twinCities") || "",
    mustHaves: data.get("twinMustHaves") || "",
    hardStops: data.get("twinHardStops") || "",
    communicationStyle: data.get("twinCommunicationStyle") || "",
    marriageTimeline: data.get("twinMarriageTimeline") || "",
    childrenPreference: data.get("twinChildrenPreference") || "",
    familyBoundary: data.get("twinFamilyBoundary") || "",
    financialView: data.get("twinFinancialView") || "",
    selfSummary: data.get("twinSelfSummary") || "",
    authorizedSensitiveTopics: [...form.querySelectorAll('input[name="topic"]:checked')].map(
      (input) => input.value
    ),
    selfReality,
    partnerRealityPreferences
  };
}

function currentFormSnapshot() {
  return JSON.stringify(buildTwinProfilePayload());
}

function syncPersistedSnapshot() {
  lastPersistedSnapshot = currentFormSnapshot();
}

function hasUnsavedTwinChanges() {
  return currentFormSnapshot() !== lastPersistedSnapshot;
}

function fillFormFromTwin(twinProfile = {}) {
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

  for (const topicInput of form.querySelectorAll('input[name="topic"]')) {
    topicInput.checked = (twinProfile.authorizedSensitiveTopics || []).includes(topicInput.value);
  }

  for (const field of appConfig.realityFieldDefs) {
    form.elements[`selfReality_${field.key}`].value = twinProfile.selfReality?.[field.key] || "";
    form.elements[`preferenceMode_${field.key}`].value =
      twinProfile.partnerRealityPreferences?.[field.key]?.mode || "ignore";

    for (const input of form.querySelectorAll(`input[name="preferenceValue_${field.key}"]`)) {
      input.checked = (twinProfile.partnerRealityPreferences?.[field.key]?.values || []).includes(
        input.value
      );
    }
  }

  syncPreferenceValuesAvailability();
}

function clearForm() {
  form.reset();
  syncPreferenceValuesAvailability();
  currentTwin = null;
  currentTwinShell.innerHTML = "";
  profileStateText.textContent = "当前 Twin 尚未保存。";
  syncPersistedSnapshot();
setStatus("idle", "已清空表单。");
}

function renderCurrentTwin() {
  if (!currentTwin) {
    currentTwinShell.innerHTML = `
      <article class="history-item">
        <p>当前还没有 Twin。请先填写资料并保存。</p>
      </article>
    `;
    return;
  }

  currentTwinShell.innerHTML = `
    <article class="history-item">
      <header>
        <strong>${escapeHtml(currentTwin.displayName)}</strong>
        <span class="pill ok">v${escapeHtml(String(currentTwin.twinVersionNumber))}</span>
      </header>
      <p><strong>关系目标：</strong>${escapeHtml(asDisplayText(currentTwin.twinProfile.relationshipGoal))}</p>
      <p><strong>偏好城市：</strong>${escapeHtml(asDisplayText(currentTwin.twinProfile.cities))}</p>
      <p><strong>沟通风格：</strong>${escapeHtml(asDisplayText(currentTwin.twinProfile.communicationStyle))}</p>
      <p><strong>最近更新：</strong>${escapeHtml(formatDateTime(currentTwin.updatedAt))}</p>
    </article>
  `;
}

async function loadConfig() {
  const config = await fetchJson("/api/config");
  appConfig = config;
  renderTopicCheckboxes(config.sensitiveTopicCategories);
  renderRealitySelfFields(config.realityFieldDefs);
  renderRealityPreferenceFields(config.realityFieldDefs);
  syncPreferenceValuesAvailability();
}

async function loadCurrentTwin() {
  const { twin } = await fetchJson("/api/twin");
  currentTwin = twin;

  if (twin) {
    fillFormFromTwin(twin.twinProfile);
    profileStateText.textContent = `当前 Twin 版本：v${twin.twinVersionNumber}`;
  } else {
    profileStateText.textContent = "当前 Twin 尚未保存。";
  }

  syncPersistedSnapshot();
  renderCurrentTwin();
}

async function persistCurrentTwin(auto = false) {
  if (auto && !hasUnsavedTwinChanges()) {
    return;
  }

  const twinProfile = buildTwinProfilePayload();
  setStatus(auto ? "saving" : "saving", auto ? "正在自动保存 Twin..." : "正在保存当前 Twin...");
  const { twin } = await fetchJson("/api/twin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ twinProfile })
  });

  currentTwin = twin;
  renderCurrentTwin();
  profileStateText.textContent = `当前 Twin 版本：v${twin.twinVersionNumber}`;
  syncPersistedSnapshot();
  setSavedStatus(auto);
}

async function generateReport() {
  const twinProfile = buildTwinProfilePayload();
  setStatus("saving", "正在生成匹配报告...");
  const { report, twin } = await fetchJson("/api/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ twinProfile })
  });

  currentTwin = twin;
  renderCurrentTwin();
  profileStateText.textContent = `当前 Twin 版本：v${twin.twinVersionNumber}`;
  syncPersistedSnapshot();
  setSavedStatus(false);
  window.location.href = `/report.html?reportId=${encodeURIComponent(report.id)}`;
}

function scheduleAutoSave() {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
  }

  setStatus("pending", "检测到修改，将在 1.2 秒后自动保存...");
  autoSaveTimer = window.setTimeout(async () => {
    try {
      await persistCurrentTwin(true);
    } catch (error) {
      setStatus("error", `自动保存失败：${error.message}`);
    }
  }, AUTO_SAVE_DELAY_MS);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    await generateReport();
  } catch (error) {
    setStatus("error", `生成报告失败：${error.message}`);
  }
});

form.addEventListener("input", () => scheduleAutoSave());

preferenceContainer.addEventListener("change", (event) => {
  if (event.target.matches("[data-preference-mode]")) {
    syncPreferenceValuesAvailability();
  }
});

sampleButton.addEventListener("click", () => {
  fillFormFromTwin(samplePayload);
  scheduleAutoSave();
});

saveTwinButton.addEventListener("click", async () => {
  try {
    await persistCurrentTwin(false);
  } catch (error) {
    setStatus("error", `保存失败：${error.message}`);
  }
});

resetFormButton.addEventListener("click", () => clearForm());
logoutButton.addEventListener("click", () => logout());

const auth = await requireAuth();
if (auth) {
  await loadConfig();
  await loadCurrentTwin();
}
