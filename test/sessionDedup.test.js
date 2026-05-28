import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAppServer } from "../src/server.js";
import {
  createPrechatSession,
  getRawDatabaseForTests,
  resetDatabaseForTests,
  saveCurrentTwin,
  upsertMatch
} from "../src/lib/database.js";

const originalFetch = global.fetch;
const tempDbPath = path.join(process.cwd(), "data", "test-session-dedup.sqlite");

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

      return {
        status: response.status,
        body: payload
      };
    }
  };
}

function buildTwin(displayName) {
  return {
    displayName,
    relationshipGoal: "认真长期关系，以结婚为目标",
    cities: "上海、杭州",
    mustHaves: "情绪稳定，愿意认真经营关系",
    hardStops: "借钱、赌博",
    communicationStyle: "直接、稳定回复",
    marriageTimeline: "如果匹配，希望 1 到 2 年内推进",
    childrenPreference: "希望未来要孩子",
    familyBoundary: "婚后更偏独立小家庭",
    financialView: "务实稳定，不接受隐性负债",
    selfSummary: "重视长期稳定和现实可推进性",
    authorizedSensitiveTopics: [
      "finance_and_debt",
      "family_boundaries",
      "marriage_and_housing_logistics",
      "fertility_and_children"
    ],
    selfReality: {},
    partnerRealityPreferences: {}
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
    fs.unlinkSync(tempDbPath);
  }
});

test("同一对用户在会话列表和待办箱里只会出现一条记录", async () => {
  const clientA = createClient();
  const clientB = createClient();

  const userA = await registerAndLogin(clientA, "a@example.com", "雨涵");
  const userB = await registerAndLogin(clientB, "b@example.com", "沈特");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("沈特"));

  const matchId = upsertMatch(userA.id, userB.id, 91, "matched");
  createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id
  });

  const database = getRawDatabaseForTests();
  const now = new Date(Date.now() + 1000).toISOString();
  database
    .prepare(`
      INSERT INTO prechat_sessions (
        id, match_id, initiator_user_id, counterparty_user_id, status, current_round, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `)
    .run("duplicate-session", matchId, userA.id, userB.id, "awaiting_counterparty_acceptance", now, now);

  const sessionsA = await clientA.request("/api/prechat/sessions");
  const sessionsB = await clientB.request("/api/prechat/sessions");
  const inboxB = await clientB.request("/api/inbox");

  assert.equal(sessionsA.status, 200);
  assert.equal(sessionsB.status, 200);
  assert.equal(sessionsA.body.sessions.length, 1);
  assert.equal(sessionsB.body.sessions.length, 1);
  assert.equal(sessionsA.body.sessions[0].id, "duplicate-session");
  assert.equal(sessionsB.body.sessions[0].id, "duplicate-session");
  assert.equal(inboxB.status, 200);
  assert.equal(inboxB.body.items.filter((item) => item.type === "invitation").length, 1);
});
