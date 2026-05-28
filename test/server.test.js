import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAppServer } from "../src/server.js";
import {
  createPrechatSession,
  createUser,
  getRawDatabaseForTests,
  resetDatabaseForTests,
  saveCurrentTwin,
  upsertMatch
} from "../src/lib/database.js";
import { hashPassword } from "../src/lib/auth.js";

const originalFetch = global.fetch;
const tempDbPath = path.join(process.cwd(), "data", "test-phase2-server.sqlite");

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

test("注册、登录态与未登录拦截生效", async () => {
  const clientA = createClient();
  const guest = createClient();

  const userA = await registerAndLogin(clientA, "a@example.com", "雨涵");
  const me = await clientA.request("/api/auth/me");
  const guestTwin = await guest.request("/api/twin");

  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, userA.email);
  assert.equal(guestTwin.status, 401);
});

test("双身份邀请链路和非敏感问题自动推进可用", async () => {
  const clientA = createClient();
  const clientB = createClient();
  const clientC = createClient();

  await registerAndLogin(clientA, "a@example.com", "雨涵");
  await registerAndLogin(clientB, "b@example.com", "予安");
  await registerAndLogin(clientC, "c@example.com", "路人");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("予安"));
  await saveTwinFor(clientC, buildTwin("路人", { cities: "北京" }));

  const matchResponse = await clientA.request("/api/matches");
  assert.equal(matchResponse.status, 200);
  assert.equal(matchResponse.body.matches.length >= 1, true);

  const matchId = matchResponse.body.matches.find((item) => item.counterpart.displayName === "予安").id;
  const invitation = await clientA.request(`/api/matches/${matchId}/invite-prechat`, { method: "POST" });
  assert.equal(invitation.status, 201);

  const inboxA = await clientA.request("/api/inbox");
  const inboxB = await clientB.request("/api/inbox");
  assert.equal(inboxA.body.items.length, 0);
  assert.equal(inboxB.body.items.length, 1);

  const sessionId = invitation.body.session.id;
  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  const sessionsA = await clientA.request("/api/prechat/sessions");
  const sessionsB = await clientB.request("/api/prechat/sessions");
  assert.equal(sessionsA.status, 200);
  assert.equal(sessionsB.status, 200);
  assert.equal(sessionsA.body.sessions.some((item) => item.id === sessionId), true);
  assert.equal(sessionsB.body.sessions.some((item) => item.id === sessionId), true);

  mockLlmSequence([
    {
      reply: "我比较重视认真长期关系，你更看重什么样的关系目标？",
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
      summary: "双方都明确希望认真长期关系，可以进入下一轮确认其他现实问题。",
      confirmed_facts: [
        {
          subjectUserId: "counterparty",
          key: "relationshipGoal",
          value: "认真长期关系",
          confidence: 0.9
        }
      ],
      unresolved_questions: ["婚后城市安排"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const round = await clientA.request(`/api/prechat/sessions/${sessionId}/run-round`, { method: "POST" });
  assert.equal(round.status, 200);
  assert.equal(round.body.result.status, "paused_review");

  const sessionA = await clientA.request(`/api/prechat/sessions/${sessionId}`);
  const sessionB = await clientB.request(`/api/prechat/sessions/${sessionId}`);
  const sessionC = await clientC.request(`/api/prechat/sessions/${sessionId}`);

  assert.equal(sessionA.status, 200);
  assert.equal(sessionB.status, 200);
  assert.equal(sessionC.status, 404);
  assert.equal(sessionA.body.turns.length, 2);
  assert.equal(sessionA.body.stageReports.length, 1);
});

test("敏感问题会进入逐题授权，且非被问方不能代批", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "a@example.com", "雨涵");
  await registerAndLogin(clientB, "b@example.com", "予安");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("予安"));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "予安").id;
  const invitation = await clientA.request(`/api/matches/${matchId}/invite-prechat`, { method: "POST" });
  const sessionId = invitation.body.session.id;
  await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });

  mockLlmSequence([
    {
      reply: "你希望婚后和父母同住吗？",
      is_sensitive_question: true,
      sensitive_topic_category: "family_boundaries",
      needs_sensitive_approval: true,
      target_user_for_approval: "listener",
      confirmed_facts: [],
      open_questions: ["婚后家庭边界"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "已命中敏感问题，需要被问方授权后才能继续。",
      confirmed_facts: [],
      unresolved_questions: ["婚后家庭边界"],
      risk_summary: [],
      next_action: "pause_review",
      handoff_ready: false
    }
  ]);

  const firstRound = await clientA.request(`/api/prechat/sessions/${sessionId}/run-round`, { method: "POST" });
  assert.equal(firstRound.status, 200);
  assert.equal(firstRound.body.result.status, "pending_sensitive_approval");

  const inboxB = await clientB.request("/api/inbox");
  const sensitiveItem = inboxB.body.items.find((item) => item.type === "sensitive_request");
  assert.ok(sensitiveItem);

  const illegalApprove = await clientA.request(
    `/api/sensitive-requests/${sensitiveItem.payload.requestId}/approve`,
    { method: "POST" }
  );
  assert.equal(illegalApprove.status, 400);

  mockLlmSequence([
    {
      reply: "我更希望婚后保持独立小家庭，但可以住得近一些。",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "familyBoundary",
          value: "偏独立小家庭，可接受住得近",
          confidence: 0.86
        }
      ],
      open_questions: [],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "pause_review"
    },
    {
      summary: "家庭边界问题已得到回答，可以进入下一轮。",
      confirmed_facts: [
        {
          subjectUserId: "counterparty",
          key: "familyBoundary",
          value: "偏独立小家庭，可接受住得近",
          confidence: 0.86
        }
      ],
      unresolved_questions: [],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const approved = await clientB.request(
    `/api/sensitive-requests/${sensitiveItem.payload.requestId}/approve`,
    { method: "POST" }
  );
  assert.equal(approved.status, 200);
  assert.equal(approved.body.result.status, "paused_review");

  const detail = await clientB.request(`/api/prechat/sessions/${sessionId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.turns.length >= 2, true);
  assert.equal(detail.body.sensitiveRequests.some((item) => item.status === "approved"), true);
});

test("生成 Phase 1 报告后会自动发起真实用户预沟通", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "a@example.com", "雨涵");
  await registerAndLogin(clientB, "b@example.com", "予安");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("予安"));

  const reportResponse = await clientA.request("/api/reports", {
    method: "POST",
    json: {
      twinProfile: buildTwin("雨涵")
    }
  });

  assert.equal(reportResponse.status, 201);
  assert.equal(reportResponse.body.report.prechatOverview.totalSessions, 0);

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "予安").id;
  const plan = await clientA.request("/api/prechat/plan", {
    method: "POST",
    json: {
      matchIds: [matchId],
      objectiveKeys: ["cities", "marriageTimeline"]
    }
  });

  assert.equal(plan.status, 201);
  assert.equal(plan.body.prechatOverview.totalSessions >= 1, true);

  const inboxB = await clientB.request("/api/inbox");
  assert.equal(inboxB.status, 200);
  assert.equal(inboxB.body.items.some((item) => item.type === "invitation"), true);
});

test("待办箱会过滤旧坏账号发来的邀请", async () => {
  const clientA = createClient();
  const userA = await registerAndLogin(clientA, "a@example.com", "雨涵");
  await saveTwinFor(clientA, buildTwin("雨涵"));

  const brokenUser = createUser({
    email: "broken@example.com",
    displayName: "??",
    passwordHash: hashPassword("secret123")
  });
  saveCurrentTwin(
    brokenUser.id,
    buildTwin("??", {
      displayName: "??"
    })
  );

  const matchId = upsertMatch(brokenUser.id, userA.id, 88, "matched");
  createPrechatSession({
    matchId,
    initiatorUserId: brokenUser.id,
    counterpartyUserId: userA.id
  });

  const inbox = await clientA.request("/api/inbox");
  assert.equal(inbox.status, 200);
  assert.equal(inbox.body.items.length, 0);
});

test("reply 为空但 recommendation=continue 时，会话会被业务层暂停", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "a@example.com", "雨涵");
  await registerAndLogin(clientB, "b@example.com", "予安");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("予安"));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "予安").id;
  const invitation = await clientA.request(`/api/matches/${matchId}/invite-prechat`, { method: "POST" });
  const sessionId = invitation.body.session.id;
  await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });

  mockLlmSequence([
    {
      reply: "",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: [],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "模型给出了无效推进结果，已暂停等待人工确认。",
      confirmed_facts: [],
      unresolved_questions: ["需要人工确认本轮有效问题"],
      risk_summary: [],
      next_action: "pause_review",
      handoff_ready: false
    }
  ]);

  const round = await clientA.request(`/api/prechat/sessions/${sessionId}/run-round`, { method: "POST" });
  assert.equal(round.status, 200);
  assert.equal(round.body.result.status, "paused_review");
  assert.equal(round.body.result.stopReason, "empty_reply_with_continue");

  const session = await clientA.request(`/api/prechat/sessions/${sessionId}`);
  assert.equal(session.status, 200);
  assert.equal(session.body.turns.length, 0);
  assert.equal(session.body.stageReports.length, 1);
});

test("人工补充暂停会在会话中显示系统提示，提交后写入真人消息", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "a@example.com", "雨涵");
  await registerAndLogin(clientB, "b@example.com", "予安");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("予安"));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "予安").id;
  const invitation = await clientA.request(`/api/matches/${matchId}/invite-prechat`, { method: "POST" });
  const sessionId = invitation.body.session.id;
  await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });

  mockLlmSequence([
    {
      reply: "",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["你希望多久内考虑结婚？"],
      risk_flags: [],
      needs_human_input: {
        required: true,
        field: "marriageTimeline",
        question: "请直接说明你希望多久内考虑结婚。",
        target_user_for_input: "self"
      },
      recommendation: "continue"
    },
    {
      summary: "本轮已暂停，等待用户本人补充结婚节奏信息。",
      confirmed_facts: [],
      unresolved_questions: ["结婚节奏"],
      risk_summary: [],
      next_action: "pause_review",
      handoff_ready: false
    }
  ]);

  const firstRound = await clientA.request(`/api/prechat/sessions/${sessionId}/run-round`, { method: "POST" });
  assert.equal(firstRound.status, 200);
  assert.equal(firstRound.body.result.status, "pending_human_input");

  const pausedSession = await clientA.request(`/api/prechat/sessions/${sessionId}`);
  assert.equal(pausedSession.status, 200);
  assert.equal(pausedSession.body.turns.length, 1);
  assert.equal(pausedSession.body.turns[0].actorRole, "system");
  assert.equal(pausedSession.body.humanInputRequests.length, 1);

  const requestId = pausedSession.body.humanInputRequests[0].id;
  const submitted = await clientA.request(`/api/prechat/sessions/${sessionId}/human-input`, {
    method: "POST",
    json: {
      requestId,
      responseText: "如果关系稳定，我希望 1 到 2 年内推进结婚。"
    }
  });

  assert.equal(submitted.status, 200);

  const resumedSession = await clientA.request(`/api/prechat/sessions/${sessionId}`);
  assert.equal(resumedSession.status, 200);
  assert.equal(resumedSession.body.session.status, "active");
  assert.equal(resumedSession.body.turns.length, 3);
  assert.equal(resumedSession.body.turns[1].actorRole, "initiator_user");
  assert.equal(
    resumedSession.body.turns[1].content,
    "如果关系稳定，我希望 1 到 2 年内推进结婚。"
  );
});

test("用户可以在会话中直接发送真人消息", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "a@example.com", "雨涵");
  await registerAndLogin(clientB, "b@example.com", "予安");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("予安"));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "予安").id;
  const invitation = await clientA.request(`/api/matches/${matchId}/invite-prechat`, { method: "POST" });
  const sessionId = invitation.body.session.id;
  await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });

  const sent = await clientA.request(`/api/prechat/sessions/${sessionId}/manual-message`, {
    method: "POST",
    json: {
      content: "你好，我想先由本人补充一句：我希望这段关系以认真长期为前提。"
    }
  });

  assert.equal(sent.status, 201);

  const session = await clientA.request(`/api/prechat/sessions/${sessionId}`);
  assert.equal(session.status, 200);
  assert.equal(session.body.session.currentRound, 1);
  assert.equal(session.body.turns.length, 1);
  assert.equal(session.body.turns[0].actorRole, "initiator_user");
  assert.equal(
    session.body.turns[0].content,
    "你好，我想先由本人补充一句：我希望这段关系以认真长期为前提。"
  );
});

test("Twin-Twin 预沟通遇到复读时会先回答再推进新问题", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "a@example.com", "雨涵");
  await registerAndLogin(clientB, "b@example.com", "予安");
  await saveTwinFor(
    clientA,
    buildTwin("雨涵", {
      cities: "上海",
      marriageTimeline: "如果匹配，希望 1 到 2 年内推进"
    })
  );
  await saveTwinFor(
    clientB,
    buildTwin("予安", {
      cities: "杭州",
      marriageTimeline: "更希望先相处稳定，再考虑 2 到 3 年内推进"
    })
  );

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "予安").id;
  const invitation = await clientA.request(`/api/matches/${matchId}/invite-prechat`, { method: "POST" });
  const sessionId = invitation.body.session.id;
  await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });

  mockLlmSequence([
    {
      reply: "你好，我们都在认真考虑长期关系。我想先确认一下，你未来长期更倾向在上海还是杭州生活？",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["对方未来长期生活城市"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "你好，我们都在认真考虑长期关系。我想先确认一下，你未来长期更倾向在上海还是杭州生活？",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["对方未来长期生活城市"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "我这边如果关系顺利，希望 1 到 2 年内推进结婚。",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "marriageTimeline",
          value: "如果匹配，希望 1 到 2 年内推进",
          confidence: 0.88
        }
      ],
      open_questions: [],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "pause_review"
    },
    {
      summary: "双方已经从城市聊到结婚节奏，未再出现原地重复提问。",
      confirmed_facts: [
        {
          subjectUserId: "counterparty",
          key: "cities",
          value: "杭州",
          confidence: 0.92
        }
      ],
      unresolved_questions: ["对方对结婚节奏的期待"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const round = await clientA.request(`/api/prechat/sessions/${sessionId}/run-round`, { method: "POST" });
  assert.equal(round.status, 200);
  assert.equal(round.body.result.status, "paused_review");

  const detail = await clientA.request(`/api/prechat/sessions/${sessionId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.turns.length, 3);
  assert.equal(detail.body.turns[0].content.includes("上海还是杭州"), true);
  assert.equal(detail.body.turns[1].content.includes("杭州"), true);
  assert.equal(detail.body.turns[1].content === detail.body.turns[0].content, false);
  assert.equal(detail.body.turns[1].content.includes("结婚节奏"), true);
});
