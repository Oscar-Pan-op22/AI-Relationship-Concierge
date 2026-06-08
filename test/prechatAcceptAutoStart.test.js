import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAppServer } from "../src/server.js";
import { resetDatabaseForTests } from "../src/lib/database.js";

const originalFetch = global.fetch;
const tempDbPath = path.join(process.cwd(), "data", "test-prechat-accept.sqlite");

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

async function waitForAutomationIdle(client, sessionId, attempts = 20) {
  let last = null;

  for (let index = 0; index < attempts; index += 1) {
    last = await client.request(`/api/prechat/sessions/${sessionId}`);
    const runState = last.body?.session?.control?.automation?.runState || "idle";
    if (!["queued", "running"].includes(runState)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }

  return last;
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

test("接受邀请后会直接自动开始预沟通", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "a@example.com", "雨涵");
  await registerAndLogin(clientB, "b@example.com", "予安");
  await saveTwinFor(clientA, buildTwin("雨涵", { cities: "上海" }));
  await saveTwinFor(clientB, buildTwin("予安", { cities: "杭州" }));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "予安").id;
  const plan = await clientA.request("/api/prechat/plan", {
    method: "POST",
    json: {
      matchIds: [matchId],
      objectiveKeys: ["cities"]
    }
  });
  assert.equal(plan.status, 201);

  const sessionId = plan.body.sessions[0].id;

  mockLlmSequence([
    {
      reply: "我这边长期更倾向在上海生活。你未来长期更倾向在哪个城市发展？",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "cities",
          value: "上海",
          confidence: 0.92
        }
      ],
      open_questions: ["长期城市安排"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "pause_review"
    },
    {
      summary: "已开始确认长期城市安排。",
      confirmed_facts: [],
      unresolved_questions: ["长期城市安排"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);
  assert.equal(["queued", "running", "idle"].includes(accepted.body.session.control.automation.runState), true);

  const detail = await waitForAutomationIdle(clientB, sessionId);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.turns.length >= 1, true);
  assert.equal(detail.body.session.control.automation.source, "report_plan");
});

test("直接邀请流在接受后也会自动开始预沟通", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "a@example.com", "雨涵");
  await registerAndLogin(clientB, "b@example.com", "予安");
  await saveTwinFor(clientA, buildTwin("雨涵", { cities: "上海" }));
  await saveTwinFor(clientB, buildTwin("予安", { cities: "杭州" }));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "予安").id;
  const invitation = await clientA.request(`/api/matches/${matchId}/invite-prechat`, { method: "POST" });
  const sessionId = invitation.body.session.id;

  mockLlmSequence([
    {
      reply: "你好，我是雨涵的 Twin。看到我们都在认真考虑长期关系，我想先确认一下，你未来长期更倾向在哪个城市生活？",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["对方长期城市安排"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "pause_review"
    },
    {
      summary: "直接邀请流已自动开启首轮预沟通。",
      confirmed_facts: [],
      unresolved_questions: ["对方长期城市安排"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);
  assert.equal(["queued", "running", "idle"].includes(accepted.body.session.control.automation.runState), true);

  const detail = await waitForAutomationIdle(clientB, sessionId);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.turns.length >= 1, true);
  assert.equal(detail.body.session.control.automation.source, "direct_invite");

  const firstTwinContents = detail.body.turns
    .filter((turn) => String(turn.actorRole || "").endsWith("_twin"))
    .map((turn) => turn.content);

  const reopened = await clientB.request(`/api/prechat/sessions/${sessionId}`);
  assert.equal(reopened.status, 200);

  const reopenedTwinContents = reopened.body.turns
    .filter((turn) => String(turn.actorRole || "").endsWith("_twin"))
    .map((turn) => turn.content);

  assert.deepEqual(reopenedTwinContents, firstTwinContents);
  assert.equal(
    reopenedTwinContents.filter((content) => content === reopenedTwinContents[0]).length,
    1
  );
});

test("用户显式勾选的预沟通目标即使双方字段一致，也会自动开启首轮", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "a@example.com", "雨涵");
  await registerAndLogin(clientB, "b@example.com", "予安");
  await saveTwinFor(clientA, buildTwin("雨涵", { cities: "上海", relationshipGoal: "认真长期关系，希望以结婚为目标" }));
  await saveTwinFor(clientB, buildTwin("予安", { cities: "上海", relationshipGoal: "认真长期关系，希望以结婚为目标" }));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "予安").id;
  const plan = await clientA.request("/api/prechat/plan", {
    method: "POST",
    json: {
      matchIds: [matchId],
      objectiveKeys: ["relationshipGoal"]
    }
  });
  assert.equal(plan.status, 201);

  const sessionId = plan.body.sessions[0].id;

  mockLlmSequence([
    {
      reply: "我这边的关系目标是认真、长期地往结婚方向发展。你这边更看重长期稳定，还是也会把结婚放进考虑里？",
      reply_topic_key: "relationshipGoal",
      question_topic_key: "relationshipGoal",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "relationshipGoal",
          value: "认真长期关系，希望以结婚为目标",
          confidence: 0.95
        }
      ],
      open_questions: ["对方关系目标"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "我这边也是认真长期关系，也会把结婚放进考虑里。",
      reply_topic_key: "relationshipGoal",
      question_topic_key: null,
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "relationshipGoal",
          value: "认真长期关系，希望以结婚为目标",
          confidence: 0.95
        }
      ],
      open_questions: [],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "pause_review"
    },
    {
      summary: "即使双方画像初看一致，系统仍按用户确认的目标自动开启了关系目标核实。",
      confirmed_facts: [],
      unresolved_questions: [],
      risk_summary: [],
      next_action: "pause_review",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);
  assert.equal(["queued", "running", "idle"].includes(accepted.body.session.control.automation.runState), true);

  const detail = await waitForAutomationIdle(clientB, sessionId);
  assert.equal(detail.status, 200);
  assert.equal(["paused_review", "completed"].includes(detail.body.session.status), true);
  assert.equal(detail.body.turns.length >= 2, true);
  assert.match(detail.body.turns[0].content, /关系目标/u);
});
