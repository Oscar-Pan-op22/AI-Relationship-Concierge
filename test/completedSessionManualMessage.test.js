import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAppServer } from "../src/server.js";
import { resetDatabaseForTests } from "../src/lib/database.js";

const originalFetch = global.fetch;
const tempDbPath = path.join(process.cwd(), "data", "test-completed-manual-message.sqlite");

let server;
let baseUrl;

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

      if (Array.isArray(payload.matches)) {
        const originalFind = payload.matches.find.bind(payload.matches);
        payload.matches.find = (predicate) => originalFind(predicate) || payload.matches[0];
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
    marriageTimeline: "如果匹配，希望1到2年内推进",
    childrenPreference: "希望未来要孩子",
    familyBoundary: "尊重父母，但婚后更偏独立小家庭",
    financialView: "务实稳定，不接受隐性负债",
    selfSummary: "更重视长期稳定和现实可推进性。",
    authorizedSensitiveTopics: [
      "finance_and_debt",
      "family_boundaries",
      "marriage_and_housing_logistics",
      "fertility_and_children"
    ],
    selfReality: {},
    partnerRealityPreferences: {},
    ...overrides
  };
}

function mockLlmSequence(sequence) {
  global.fetch = async (url, init) => {
    const target = String(url);

    if (target.startsWith("http://100.91.101.3:8003/v1/chat/completions")) {
      const next = sequence.shift();
      if (!next) {
        throw new Error("Unexpected LLM call");
      }

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: typeof next === "string" ? next : JSON.stringify(next)
              }
            }
          ]
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    return originalFetch(url, init);
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
    fs.unlinkSync(tempDbPath);
  }

  global.fetch = originalFetch;
  server = createAppServer();
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterEach(async () => {
  global.fetch = originalFetch;

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  resetDatabaseForTests("");
  if (fs.existsSync(tempDbPath)) {
    fs.unlinkSync(tempDbPath);
  }
});

test("任意一方结束推进后，双方 Twin 停止发消息，且只有从无限制进入限制期时才重置双方额度", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "a@example.com", "雨涵");
  await registerAndLogin(clientB, "b@example.com", "沈特");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("沈特"));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "沈特").id;
  const invitation = await clientA.request(`/api/matches/${matchId}/invite-prechat`, { method: "POST" });
  const sessionId = invitation.body.session.id;

  mockLlmSequence([
    {
      reply: "我比较重视认真长期关系。你更看重怎样的关系目标？",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["对方的关系目标"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "pause_review"
    },
    {
      summary: "已自动开启首轮关系目标确认。",
      confirmed_facts: [],
      unresolved_questions: ["对方的关系目标"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  const paused = await clientA.request(`/api/prechat/sessions/${sessionId}/decision`, {
    method: "POST",
    json: { action: "toggle_manual_pause" }
  });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.session.control.manualPause.initiatorEnded, true);
  assert.equal(paused.body.session.control.manualPause.counterpartyEnded, false);

  const blockedRound = await clientA.request(`/api/prechat/sessions/${sessionId}/run-round`, { method: "POST" });
  assert.equal(blockedRound.status, 400);

  const firstManualA = await clientA.request(`/api/prechat/sessions/${sessionId}/manual-message`, {
    method: "POST",
    json: {
      content: "我先用真人补充一句：这段关系我更看重长期稳定。"
    }
  });
  assert.equal(firstManualA.status, 201);

  const firstManualB = await clientB.request(`/api/prechat/sessions/${sessionId}/manual-message`, {
    method: "POST",
    json: {
      content: "我也补充一句：我更在意相处是否稳定。"
    }
  });
  assert.equal(firstManualB.status, 201);

  const pausedByB = await clientB.request(`/api/prechat/sessions/${sessionId}/decision`, {
    method: "POST",
    json: { action: "toggle_manual_pause" }
  });
  assert.equal(pausedByB.status, 200);
  assert.equal(pausedByB.body.session.control.manualPause.counterpartyEnded, true);
  assert.equal(pausedByB.body.session.control.manualPause.messageCountByRole.initiator, 1);
  assert.equal(pausedByB.body.session.control.manualPause.messageCountByRole.counterparty, 1);

  const secondManualA = await clientA.request(`/api/prechat/sessions/${sessionId}/manual-message`, {
    method: "POST",
    json: {
      content: "我想再补一条。"
    }
  });
  assert.equal(secondManualA.status, 400);

  const detailWhilePaused = await clientA.request(`/api/prechat/sessions/${sessionId}`);
  assert.equal(detailWhilePaused.status, 200);
  assert.equal(detailWhilePaused.body.turns.filter((turn) => String(turn.actorRole || "").endsWith("_user")).length, 2);

  const stillBlocked = await clientA.request(`/api/prechat/sessions/${sessionId}/run-round`, { method: "POST" });
  assert.equal(stillBlocked.status, 400);

  const resumedByA = await clientA.request(`/api/prechat/sessions/${sessionId}/decision`, {
    method: "POST",
    json: { action: "toggle_manual_pause" }
  });
  assert.equal(resumedByA.status, 200);
  assert.equal(resumedByA.body.session.control.manualPause.initiatorEnded, false);
  assert.equal(resumedByA.body.session.control.manualPause.counterpartyEnded, true);

  const resumedFully = await clientB.request(`/api/prechat/sessions/${sessionId}/decision`, {
    method: "POST",
    json: { action: "toggle_manual_pause" }
  });
  assert.equal(resumedFully.status, 200);
  assert.equal(resumedFully.body.session.control.manualPause.initiatorEnded, false);
  assert.equal(resumedFully.body.session.control.manualPause.counterpartyEnded, false);
  assert.equal(resumedFully.body.session.control.manualPause.messageCountByRole.initiator, 0);
  assert.equal(resumedFully.body.session.control.manualPause.messageCountByRole.counterparty, 0);

  mockLlmSequence([
    {
      reply: "我这边也更看重长期稳定。你会更希望先慢慢相处，还是希望节奏明确一些？",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["推进节奏"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "pause_review"
    },
    {
      summary: "继续推进后，Twin 对话已恢复。",
      confirmed_facts: [],
      unresolved_questions: ["推进节奏"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const resumedAfterToggle = await clientA.request(`/api/prechat/sessions/${sessionId}`);
  assert.equal(resumedAfterToggle.status, 200);

  const detail = await clientA.request(`/api/prechat/sessions/${sessionId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.turns.some((turn) => turn.actorRole === "initiator_user"), true);
  assert.equal(detail.body.turns.some((turn) => String(turn.actorRole || "").endsWith("_twin")), true);
});
