import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAppServer } from "../src/server.js";
import { getCurrentTwin, resetDatabaseForTests, saveReport } from "../src/lib/database.js";
import { REPORT_SCHEMA_VERSION } from "../src/lib/matchingEngine.js";

const originalFetch = global.fetch;
const tempDbPath = path.join(process.cwd(), "data", "test-phase2-report-shortlist.sqlite");

let server;
let baseUrl;

function removeIfExistsWithRetry(targetPath, attempts = 5) {
  for (let index = 0; index < attempts; index += 1) {
    if (!fs.existsSync(targetPath)) {
      return;
    }

    try {
      fs.unlinkSync(targetPath);
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" || index === attempts - 1) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    }
  }
}

function createClient() {
  let cookie = "";

  return {
    async request(requestPath, { method = "GET", json } = {}) {
      const headers = {};
      let body;

      if (cookie) {
        headers.Cookie = cookie;
      }

      if (json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(json);
      }

      const response = await originalFetch(`${baseUrl}${requestPath}`, {
        method,
        headers,
        body
      });
      const setCookie = response.headers.get("set-cookie");

      if (setCookie) {
        cookie = setCookie.split(";")[0];
      }

      let payload = {};

      try {
        payload = await response.json();
      } catch {
        payload = {};
      }

      return {
        status: response.status,
        body: payload
      };
    }
  };
}

function buildTwin(displayName, overrides = {}) {
  return {
    displayName,
    relationshipGoal: "认真长期关系，希望以结婚为目标",
    cities: "上海、杭州",
    mustHaves: "情绪稳定、愿意认真经营关系",
    hardStops: "借钱、赌博",
    communicationStyle: "直接、稳定回复",
    marriageTimeline: "如果匹配，希望 1 到 2 年内推进",
    childrenPreference: "希望未来要孩子",
    familyBoundary: "尊重父母，但婚后更偏独立小家庭",
    financialView: "务实稳定，不接受隐性负债",
    selfSummary: "更重视长期稳定和现实可推进性。",
    authorizedSensitiveTopics: [],
    selfReality: {},
    partnerRealityPreferences: {},
    ...overrides
  };
}

async function registerAndLogin(client, email, displayName) {
  const response = await client.request("/api/auth/register", {
    method: "POST",
    json: {
      email,
      displayName,
      password: "secret123"
    }
  });

  assert.equal(response.status, 201);
}

async function saveTwinFor(client, twinProfile) {
  const response = await client.request("/api/twin", {
    method: "POST",
    json: { twinProfile }
  });

  assert.equal(response.status, 201);
}

test.beforeEach(async () => {
  resetDatabaseForTests(tempDbPath);
  if (fs.existsSync(tempDbPath)) {
    removeIfExistsWithRetry(tempDbPath);
  }

  server = createAppServer();
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  resetDatabaseForTests("");
  if (fs.existsSync(tempDbPath)) {
    removeIfExistsWithRetry(tempDbPath);
  }
});

test("Phase 1 报告 shortlist 只展示真实注册用户，不再返回 mock 假人", async () => {
  const clientA = createClient();
  const clientB = createClient();
  const clientC = createClient();

  await registerAndLogin(clientA, "a@example.com", "雨涵");
  await registerAndLogin(clientB, "b@example.com", "沈特");
  await registerAndLogin(clientC, "c@example.com", "林予安");

  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("沈特", { cities: "上海" }));
  await saveTwinFor(clientC, buildTwin("林予安", { cities: "杭州" }));

  const reportResponse = await clientA.request("/api/reports", {
    method: "POST",
    json: {
      twinProfile: buildTwin("雨涵")
    }
  });

  assert.equal(reportResponse.status, 201);
  assert.equal(reportResponse.body.report.overview.candidatePoolSize, 2);
  assert.equal(reportResponse.body.report.shortlist.length, 2);
  assert.equal(
    reportResponse.body.report.shortlist.every((item) => !String(item.candidateId).startsWith("cand_")),
    true
  );
  assert.deepEqual(
    reportResponse.body.report.shortlist.map((item) => item.displayName).sort(),
    ["林予安", "沈特"]
  );
});

test("shortlist 的城市字段只展示 Twin 档案中的安全城市值，不展示聊天句子", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "shortlist-a@example.com", "雨涵");
  await registerAndLogin(clientB, "shortlist-b@example.com", "沈特");

  await saveTwinFor(clientA, buildTwin("雨涵", { cities: "上海" }));
  await saveTwinFor(clientB, buildTwin("沈特", { cities: "我也比较偏向上海！你具体在上海哪里？" }));

  const reportResponse = await clientA.request("/api/reports", {
    method: "POST",
    json: {
      twinProfile: buildTwin("雨涵", { cities: "上海" })
    }
  });

  assert.equal(reportResponse.status, 201);
  const candidate = reportResponse.body.report.shortlist.find((item) => item.displayName === "沈特");
  assert.ok(candidate);
  assert.equal(candidate.city, "");
  assert.equal(candidate.summary.includes("你具体在上海哪里"), false);
  assert.equal(
    candidate.realitySummary.some((item) => String(item.value || "").includes("你具体在上海哪里")),
    false
  );
});

test("预沟通计划只写入 runtime state，不再污染 Twin 手动画像", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "plan-a@example.com", "雨涵");
  await registerAndLogin(clientB, "plan-b@example.com", "沈特");

  await saveTwinFor(clientA, buildTwin("雨涵", { cities: "上海" }));
  await saveTwinFor(clientB, buildTwin("沈特", { cities: "杭州" }));

  const matches = await clientA.request("/api/matches");
  const match = matches.body.matches.find((item) => item.counterpart.displayName === "沈特");
  assert.ok(match);

  const planned = await clientA.request("/api/prechat/plan", {
    method: "POST",
    json: {
      matchIds: [match.id],
      objectiveKeys: ["cities", "marriageTimeline"]
    }
  });

  assert.equal(planned.status, 201);
  const twin = await clientA.request("/api/twin");
  assert.equal(twin.status, 200);
  assert.equal(Boolean(twin.body.twin.twinProfile.prechatGoals), false);
  assert.deepEqual(twin.body.twin.runtimeState.prechatGoals.selectedObjectiveKeys, ["cities", "marriageTimeline"]);
});

test("旧报告保持生成时快照，重新生成报告后才读取最新手动 Twin 资料", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "report-freeze-a@example.com", "雨涵");
  await registerAndLogin(clientB, "report-freeze-b@example.com", "沈特");

  await saveTwinFor(clientA, buildTwin("雨涵", { cities: "上海" }));
  await saveTwinFor(clientB, buildTwin("沈特", { cities: "杭州" }));

  const firstReport = await clientA.request("/api/reports", {
    method: "POST",
    json: {
      twinProfile: buildTwin("雨涵", { cities: "上海" })
    }
  });
  assert.equal(firstReport.status, 201);
  const firstCandidate = firstReport.body.report.shortlist.find((item) => item.displayName === "沈特");
  assert.equal(firstCandidate.city, "杭州");

  await saveTwinFor(clientB, buildTwin("沈特", { cities: "北京" }));

  const savedFirstReport = await clientA.request(`/api/reports/${firstReport.body.report.id}`);
  assert.equal(savedFirstReport.status, 200);
  const frozenCandidate = savedFirstReport.body.report.shortlist.find((item) => item.displayName === "沈特");
  assert.equal(frozenCandidate.city, "杭州");

  const secondReport = await clientA.request("/api/reports", {
    method: "POST",
    json: {
      twinProfile: buildTwin("雨涵", { cities: "上海" })
    }
  });
  assert.equal(secondReport.status, 201);
  const refreshedCandidate = secondReport.body.report.shortlist.find((item) => item.displayName === "沈特");
  assert.equal(refreshedCandidate.city, "北京");
});

test("历史报告中的 shortlist 脏城市摘要会在后端读取时被净化", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "report-sanitize-a@example.com", "雨涵");
  await registerAndLogin(clientB, "report-sanitize-b@example.com", "沈特");

  await saveTwinFor(clientA, buildTwin("雨涵", { cities: "上海" }));
  await saveTwinFor(clientB, buildTwin("沈特", { cities: "上海、杭州" }));

  const twinA = await clientA.request("/api/twin");
  assert.equal(twinA.status, 200);

  const pollutedReport = {
    id: "historical-polluted-shortlist-report",
    schemaVersion: REPORT_SCHEMA_VERSION,
    phase: "phase_1_matching_shortlist",
    createdAt: new Date().toISOString(),
    twinSummary: { summary: "测试报告" },
    shortlist: [
      {
        candidateId: "candidate-shente",
        displayName: "沈特",
        city: "",
        relationshipGoal: "认真长期关系，希望以结婚为目标",
        communicationStyle: "直接、稳定回复，不喜欢反复试探",
        summary:
          "关系目标：认真长期关系，希望以结婚为目标；偏好城市：也比较偏向上海！你具体在上海哪里？；沟通风格：直接、稳定回复，不喜欢反复试探",
        nextPhaseFocus: [
          "继续由 Twin-Twin 预沟通确认双方长期关系目标。",
          "优先确认长期生活城市是否能落到 我也比较偏向上海！你具体在上海哪里？。"
        ],
        realitySummary: [
          {
            key: "cities",
            label: "长期生活城市",
            value: "也比较偏向上海！你具体在上海哪里？",
            valueLabel: "也比较偏向上海！你具体在上海哪里？"
          }
        ]
      }
    ],
    overview: {
      shortlistCount: 1,
      candidatePoolSize: 1,
      nextPhaseReadyCount: 1,
      excludedByRealityCount: 0,
      headline: "测试"
    },
    nextSteps: []
  };

  const savedTwin = getCurrentTwin(twinA.body.twin.userId);
  saveReport(twinA.body.twin.userId, pollutedReport, savedTwin?.twinVersionId, savedTwin?.twinVersionNumber);

  const response = await clientA.request(`/api/reports/${pollutedReport.id}`);
  assert.equal(response.status, 200);

  const candidate = response.body.report.shortlist[0];
  assert.equal(candidate.city, "");
  assert.equal(candidate.summary.includes("你具体在上海哪里"), false);
  assert.equal(candidate.summary.includes("偏好城市"), false);
  assert.deepEqual(candidate.realitySummary, []);
  assert.equal(candidate.summary, "关系目标：认真长期关系，希望以结婚为目标；沟通风格：直接、稳定回复，不喜欢反复试探");
  assert.deepEqual(candidate.nextPhaseFocus, [
    "继续由 Twin-Twin 预沟通确认双方长期关系目标。",
    "继续确认长期生活城市安排。"
  ]);
});
