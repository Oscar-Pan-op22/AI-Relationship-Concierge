import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAppServer } from "../src/server.js";
import { resetDatabaseForTests, saveCurrentTwin, updatePrechatSession } from "../src/lib/database.js";

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
    marriageTimeline: "如果匹配，希望 1 到 2 年内推进",
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
  return response.body.user;
}

async function saveTwinFor(client, twinProfile) {
  const response = await client.request("/api/twin", {
    method: "POST",
    json: { twinProfile }
  });

  assert.equal(response.status, 201);
  return response.body.twin;
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

test("已完成会话仍可发送真人消息并重新激活", async () => {
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
  await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });

  mockLlmSequence([
    {
      reply: "我比较重视认真长期关系，你更看重怎样的关系目标？",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["对方的关系目标"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "我同样以认真长期关系为目标，希望节奏稳定一些。",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "relationshipGoal",
          value: "认真长期关系",
          confidence: 0.9
        }
      ],
      open_questions: [],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "pause_review"
    },
    {
      summary: "双方都明确希望认真长期关系，可以进入下一轮。",
      confirmed_facts: [
        {
          subjectUserId: "counterparty",
          key: "relationshipGoal",
          value: "认真长期关系",
          confidence: 0.9
        }
      ],
      unresolved_questions: [],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const firstRound = await clientA.request(`/api/prechat/sessions/${sessionId}/run-round`, { method: "POST" });
  assert.equal(firstRound.status, 200);

  updatePrechatSession(sessionId, { status: "completed" });

  mockLlmSequence([]);

  const sent = await clientA.request(`/api/prechat/sessions/${sessionId}/manual-message`, {
    method: "POST",
    json: {
      content: "我想补充一下：如果双方节奏一致，我愿意继续推进这段关系。"
    }
  });

  assert.equal(sent.status, 201);

  const detail = await clientA.request(`/api/prechat/sessions/${sessionId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.session.status, "active");
  assert.equal(detail.body.turns.at(-1).actorRole, "initiator_user");
  assert.equal(detail.body.turns.at(-1).content.includes("我想补充一下"), true);
});
