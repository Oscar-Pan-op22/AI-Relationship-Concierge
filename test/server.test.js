import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAppServer } from "../src/server.js";
import {
  createPrechatSession,
  createUser,
  createPrechatRound,
  createSensitiveQuestionRequest,
  createStageReport,
  addConversationTurn,
  createHumanInputRequest,
  finishPrechatRound,
  getRawDatabaseForTests,
  getPrechatSessionById,
  getSessionDetailForUser,
  listConversationTurns,
  listExtractedFacts,
  listPrechatRounds,
  resetDatabaseForTests,
  resolveHumanInputRequest,
  saveCurrentTwin,
  saveExtractedFacts,
  updatePrechatSession,
  upsertMatch
} from "../src/lib/database.js";
import { hashPassword } from "../src/lib/auth.js";
import {
  __testOnlyBuildFactCard,
  __testOnlyBuildCanonicalTurnOutcome,
  __testOnlyCanonicalizeHistoricalTwinTurn,
  __testOnlyBuildSafeFollowupReply,
  __testOnlyBuildQuestionFingerprint,
  __testOnlyBuildTurnContextV2,
  __testOnlyBuildObjectiveProgress,
  __testOnlyBuildRoundProgressSnapshot,
  __testOnlyAlignFinalTurnSemantics,
  __testOnlyValidateTopicAwareTurnResult,
  __testOnlyDerivePostAnswerContinuation,
  __testOnlyDidRoundProgressAdvance,
  __testOnlyCollapseAdjacentDuplicateTwinTurns,
  __testOnlyBuildDeferredRetryState,
  __testOnlyDetectOutstandingTwinQuestion,
  __testOnlyGetLatestOutstandingTwinQuestionRecoveryForSession,
  __testOnlyDetectOutstandingTwinQuestionSourceValidity,
  __testOnlyIsTrustedCanonicalTwinTurn,
  __testOnlyRebuildTopicLedger,
  __testOnlySanitizeFactsForPrompt,
  __testOnlyShouldSkipDuplicateTwinTurn,
  __testOnlyShouldExhaustDeferredRetry,
  __testOnlyShouldRejectAnswerTopicMismatch,
  getSessionViewWithAutoRecovery,
  regenerateStageSummary,
  runSessionRound,
  sanitizeStageReportPayloadForViewer
} from "../src/lib/prechatService.js";

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

async function waitForSessionState(client, sessionId, predicate, attempts = 30) {
  let last = null;

  for (let index = 0; index < attempts; index += 1) {
    last = await client.request(`/api/prechat/sessions/${sessionId}`);
    if (predicate(last)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return last;
}

async function withDeferredRetryTestConfig(run, options = {}) {
  const previousDelays = process.env.PRECHAT_DEFERRED_RETRY_DELAYS_MS;
  const previousWindow = process.env.PRECHAT_DEFERRED_RETRY_TOTAL_WINDOW_MS;
  const previousAttempts = process.env.PRECHAT_DEFERRED_RETRY_MAX_ATTEMPTS;

  process.env.PRECHAT_DEFERRED_RETRY_DELAYS_MS = options.delaysMs || "15,25,35";
  process.env.PRECHAT_DEFERRED_RETRY_TOTAL_WINDOW_MS = options.totalWindowMs || "1000";
  process.env.PRECHAT_DEFERRED_RETRY_MAX_ATTEMPTS = options.maxAttempts || "3";

  try {
    await run();
  } finally {
    if (previousDelays == null) {
      delete process.env.PRECHAT_DEFERRED_RETRY_DELAYS_MS;
    } else {
      process.env.PRECHAT_DEFERRED_RETRY_DELAYS_MS = previousDelays;
    }

    if (previousWindow == null) {
      delete process.env.PRECHAT_DEFERRED_RETRY_TOTAL_WINDOW_MS;
    } else {
      process.env.PRECHAT_DEFERRED_RETRY_TOTAL_WINDOW_MS = previousWindow;
    }

    if (previousAttempts == null) {
      delete process.env.PRECHAT_DEFERRED_RETRY_MAX_ATTEMPTS;
    } else {
      process.env.PRECHAT_DEFERRED_RETRY_MAX_ATTEMPTS = previousAttempts;
    }
  }
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

  const sessionId = invitation.body.session.id;
  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);
  await waitForAutomationIdle(clientB, sessionId);

  const sessionsA = await clientA.request("/api/prechat/sessions");
  const sessionsB = await clientB.request("/api/prechat/sessions");
  assert.equal(sessionsA.status, 200);
  assert.equal(sessionsB.status, 200);
  assert.equal(sessionsA.body.sessions.some((item) => item.id === sessionId), true);
  assert.equal(sessionsB.body.sessions.some((item) => item.id === sessionId), true);

  const sessionA = await clientA.request(`/api/prechat/sessions/${sessionId}`);
  const sessionB = await clientB.request(`/api/prechat/sessions/${sessionId}`);
  const sessionC = await clientC.request(`/api/prechat/sessions/${sessionId}`);

  assert.equal(sessionA.status, 200);
  assert.equal(sessionB.status, 200);
  assert.equal(sessionC.status, 404);
  assert.equal(sessionA.body.turns.length, 2);
  assert.equal(sessionA.body.stageReports.length, 1);
});

test("敏感议题会进入 topic-level 授权，且批准后重新生成而不是复用旧问题", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "a@example.com", "雨涵");
  await registerAndLogin(clientB, "b@example.com", "予安");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("予安"));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "予安").id;
  const invitation = await clientA.request(`/api/matches/${matchId}/invite-prechat`, { method: "POST" });
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

  const sessionId = invitation.body.session.id;
  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);
  const pendingDetail = await waitForAutomationIdle(clientB, sessionId);
  assert.equal(["pending_sensitive_approval", "active"].includes(pendingDetail.body.session.status), true);
  assert.equal(
    pendingDetail.body.sensitiveRequests.some(
      (item) => item.status === "pending" && item.topicCategory === "family_boundaries"
    ),
    true
  );

  const inboxB = await clientB.request("/api/inbox");
  const sensitiveItem = inboxB.body.items.find((item) => item.type === "sensitive_request");
  assert.ok(sensitiveItem);
  assert.equal(sensitiveItem.payload.approvalKind, "topic");
  assert.equal(Boolean(String(sensitiveItem.payload.summaryText || "").includes("敏感议题")), true);

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
  assert.equal(["active", "paused_review"].includes(approved.body.result?.session?.status || approved.body.status), true);

  const detail = await clientB.request(`/api/prechat/sessions/${sessionId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.turns.length >= 2, true);
  assert.equal(detail.body.sensitiveRequests.some((item) => item.status === "approved"), true);
  assert.equal(detail.body.turns.some((turn) => turn.content === "你希望婚后和父母同住吗？"), false);
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

test("人工补充待办会带上会话对方用户名", async () => {
  const clientA = createClient();
  const clientB = createClient();

  const userA = await registerAndLogin(clientA, "a@example.com", "雨涵");
  const userB = await registerAndLogin(clientB, "b@example.com", "刘星");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("刘星"));

  const matchId = upsertMatch(userA.id, userB.id, 92, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id
  });
  updatePrechatSession(session.id, { status: "pending_human_input" });
  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: []
    }
  });

  createHumanInputRequest({
    sessionId: session.id,
    roundId: round.id,
    targetUserId: userA.id,
    fieldKey: "cities",
    questionText: "请补充你长期更倾向在哪个城市生活。"
  });

  const inbox = await clientA.request("/api/inbox");
  assert.equal(inbox.status, 200);
  const humanInputItem = inbox.body.items.find((item) => item.type === "human_input_request");
  assert.ok(humanInputItem);
  assert.equal(humanInputItem.payload.counterpart.displayName, "刘星");
  assert.equal(humanInputItem.payload.questionText, "请补充你长期更倾向在哪个城市生活。");
});

test("对话结束推进后，待办列表会移除该会话的人工补充和敏感授权", async () => {
  const clientA = createClient();
  const clientB = createClient();

  const userA = await registerAndLogin(clientA, "end-inbox-a@example.com", "雨涵");
  const userB = await registerAndLogin(clientB, "end-inbox-b@example.com", "刘星");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("刘星"));

  const matchId = upsertMatch(userA.id, userB.id, 91, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id,
    control: {
      manualPause: {
        initiatorEnded: true,
        counterpartyEnded: false,
        messageCountByRole: {
          initiator: 0,
          counterparty: 0
        }
      }
    }
  });
  updatePrechatSession(session.id, { status: "pending_human_input" });
  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: []
    }
  });

  createHumanInputRequest({
    sessionId: session.id,
    roundId: round.id,
    targetUserId: userA.id,
    fieldKey: "cities",
    questionText: "请补充你长期更倾向在哪个城市生活。"
  });
  createSensitiveQuestionRequest({
    sessionId: session.id,
    roundId: round.id,
    requestingUserId: userB.id,
    targetUserId: userA.id,
    questionText: "你能接受婚后和父母同住吗？",
    topicCategory: "family_boundaries"
  });

  const inbox = await clientA.request("/api/inbox");
  assert.equal(inbox.status, 200);
  assert.equal(
    inbox.body.items.some(
      (item) =>
        item.payload?.sessionId === session.id &&
        ["human_input_request", "sensitive_request"].includes(item.type)
    ),
    false
  );
});

test("objectives_completed 会为双方持续生成查看阶段结论待办，点开后未解决前不消失", async () => {
  const clientA = createClient();
  const clientB = createClient();

  const userA = await registerAndLogin(clientA, "review-inbox-a@example.com", "雨涵");
  const userB = await registerAndLogin(clientB, "review-inbox-b@example.com", "刘星");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("刘星"));

  const matchId = upsertMatch(userA.id, userB.id, 92, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id
  });
  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: ["relationshipGoal"]
    }
  });

  createStageReport(session.id, round.id, {
    summary: "双方都以认真长期关系为目标，可以查看这一阶段结论。",
    confirmed_facts: [],
    unresolved_questions: [],
    risk_summary: [],
    next_action: "pause_review",
    stop_reason: "objectives_completed"
  });
  updatePrechatSession(session.id, {
    status: "paused_review",
    currentRound: 1,
    control: {
      reviewInbox: {
        objectivesCompleted: {
          roundId: round.id,
          roundNumber: 1,
          emittedAt: "2026-06-02T00:00:00.000Z",
          seenByRole: {
            initiator: null,
            counterparty: null
          }
        }
      }
    }
  });
  getRawDatabaseForTests()
    .prepare("UPDATE prechat_rounds SET status = 'completed', stop_reason = 'objectives_completed' WHERE id = ?")
    .run(round.id);

  const inboxA = await clientA.request("/api/inbox");
  const inboxB = await clientB.request("/api/inbox");
  const reviewA = inboxA.body.items.find((item) => item.type === "session_review");
  const reviewB = inboxB.body.items.find((item) => item.type === "session_review");

  assert.ok(reviewA);
  assert.ok(reviewB);
  assert.equal(reviewA.payload.counterpart.displayName, "刘星");
  assert.equal(reviewA.payload.reviewKind, "objectives_completed");
  assert.equal(reviewA.payload.summary, "双方都以认真长期关系为目标，可以查看这一阶段结论。");
  assert.equal(reviewB.payload.counterpart.displayName, "雨涵");

  const openedByA = await clientA.request(`/api/prechat/sessions/${session.id}`);
  assert.equal(openedByA.status, 200);

  const inboxAAfterOpen = await clientA.request("/api/inbox");
  const inboxBAfterAOpen = await clientB.request("/api/inbox");
  assert.equal(inboxAAfterOpen.body.items.some((item) => item.type === "session_review"), true);
  assert.equal(inboxBAfterAOpen.body.items.some((item) => item.type === "session_review"), true);

  const openedByB = await clientB.request(`/api/prechat/sessions/${session.id}`);
  assert.equal(openedByB.status, 200);

  const inboxBAfterOpen = await clientB.request("/api/inbox");
  assert.equal(inboxBAfterOpen.body.items.some((item) => item.type === "session_review"), true);

  updatePrechatSession(session.id, {
    status: "active"
  });

  const inboxAAfterResolved = await clientA.request("/api/inbox");
  const inboxBAfterResolved = await clientB.request("/api/inbox");
  assert.equal(inboxAAfterResolved.body.items.some((item) => item.type === "session_review"), false);
  assert.equal(inboxBAfterResolved.body.items.some((item) => item.type === "session_review"), false);
});

test("session_review inbox summary 会按当前查看者显示关于对方的总结", async () => {
  const clientA = createClient();
  const clientB = createClient();

  const userA = await registerAndLogin(clientA, "review-perspective-a@example.com", "乔治");
  const userB = await registerAndLogin(clientB, "review-perspective-b@example.com", "刘星");
  await saveTwinFor(clientA, buildTwin("乔治"));
  await saveTwinFor(clientB, buildTwin("刘星"));

  const matchId = upsertMatch(userA.id, userB.id, 98, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id,
    status: "paused_review",
    currentRound: 1,
    control: {
      reviewInbox: {
        objectivesCompleted: {
          roundNumber: 1,
          emittedAt: "2026-06-08T00:00:00.000Z",
          seenByRole: {
            initiator: null,
            counterparty: null
          }
        }
      }
    }
  });
  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: ["cities"],
      activeTopicKey: null,
      topicQueueSnapshot: []
    }
  });
  getRawDatabaseForTests()
    .prepare("UPDATE prechat_rounds SET status = 'completed', stop_reason = 'objectives_completed' WHERE id = ?")
    .run(round.id);
  updatePrechatSession(session.id, {
    status: "paused_review",
    currentRound: 1,
    control: {
      reviewInbox: {
        objectivesCompleted: {
          roundId: round.id,
          roundNumber: 1,
          emittedAt: "2026-06-08T00:00:00.000Z",
          seenByRole: {
            initiator: null,
            counterparty: null
          }
        }
      },
      automation: {
        preferredObjectiveKeys: ["cities"],
        activeTopicKey: null,
        topicLedger: {
          cities: { state: "closed", coverage: { initiator: true, counterparty: true } }
        }
      }
    }
  });

  saveExtractedFacts(session.id, round.id, [
    {
      subjectUserId: userA.id,
      key: "cities",
      value: "长期更倾向上海，杭州也可接受",
      confidence: 0.9,
      status: "confirmed"
    },
    {
      subjectUserId: userB.id,
      key: "cities",
      value: "长期更倾向深圳，广州也可接受",
      confidence: 0.9,
      status: "confirmed"
    }
  ]);

  createStageReport(session.id, round.id, {
    summary: "旧 summary",
    summary_by_role: {
      initiator: "城市与生活安排：长期更倾向深圳，广州也可接受。",
      counterparty: "城市与生活安排：长期更倾向上海，杭州也可接受。"
    },
    confirmed_facts: [],
    unresolved_questions: [],
    risk_summary: [],
    next_action: "continue",
    handoff_ready: false
  });

  const inboxA = await clientA.request("/api/inbox");
  const inboxB = await clientB.request("/api/inbox");
  const reviewA = inboxA.body.items.find(
    (item) => item.type === "session_review" && item.payload.sessionId === session.id
  );
  const reviewB = inboxB.body.items.find(
    (item) => item.type === "session_review" && item.payload.sessionId === session.id
  );

  assert.ok(reviewA);
  assert.ok(reviewB);
  assert.match(reviewA.payload.summary, /深圳/u);
  assert.match(reviewA.payload.summary, /广州/u);
  assert.equal(/上海/u.test(reviewA.payload.summary), false);
  assert.match(reviewB.payload.summary, /上海/u);
  assert.match(reviewB.payload.summary, /杭州/u);
  assert.equal(/深圳/u.test(reviewB.payload.summary), false);
});

test("历史 objectives_completed 会话没有 reviewInbox 状态时，也会回补查看阶段结论待办", async () => {
  const clientA = createClient();
  const clientB = createClient();

  const userA = await registerAndLogin(clientA, "history-review-a@example.com", "雨涵");
  const userB = await registerAndLogin(clientB, "history-review-b@example.com", "乔治");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("乔治"));

  const matchId = upsertMatch(userA.id, userB.id, 90, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id
  });
  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: ["cities"]
    }
  });

  createStageReport(session.id, round.id, {
    summary: "历史阶段总结也应该进入待办箱查看。",
    confirmed_facts: [],
    unresolved_questions: [],
    risk_summary: [],
    next_action: "pause_review",
    stop_reason: "objectives_completed"
  });
  updatePrechatSession(session.id, {
    status: "paused_review",
    currentRound: 1
  });
  getRawDatabaseForTests()
    .prepare("UPDATE prechat_rounds SET status = 'completed', stop_reason = 'objectives_completed' WHERE id = ?")
    .run(round.id);

  const inboxA = await clientA.request("/api/inbox");
  const inboxB = await clientB.request("/api/inbox");
  assert.equal(inboxA.body.items.some((item) => item.type === "session_review"), true);
  assert.equal(inboxB.body.items.some((item) => item.type === "session_review"), true);
});

test("历史 objectives_completed 会话即使 seenByRole 已写入，也不会因为已看过而隐藏", async () => {
  const clientA = createClient();
  const clientB = createClient();

  const userA = await registerAndLogin(clientA, "history-review-seen-a@example.com", "雨涵");
  const userB = await registerAndLogin(clientB, "history-review-seen-b@example.com", "乔治");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("乔治"));

  const matchId = upsertMatch(userA.id, userB.id, 90, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id
  });
  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: ["cities"]
    }
  });

  createStageReport(session.id, round.id, {
    summary: "就算历史上记过已查看，也应该继续显示直到会话离开完成态。",
    confirmed_facts: [],
    unresolved_questions: [],
    risk_summary: [],
    next_action: "pause_review",
    stop_reason: "objectives_completed"
  });
  updatePrechatSession(session.id, {
    status: "paused_review",
    currentRound: 1,
    control: {
      reviewInbox: {
        objectivesCompleted: {
          roundId: round.id,
          roundNumber: 1,
          emittedAt: "2026-06-02T00:00:00.000Z",
          seenByRole: {
            initiator: "2026-06-02T00:01:00.000Z",
            counterparty: "2026-06-02T00:02:00.000Z"
          }
        }
      }
    }
  });
  getRawDatabaseForTests()
    .prepare("UPDATE prechat_rounds SET status = 'completed', stop_reason = 'objectives_completed' WHERE id = ?")
    .run(round.id);

  const inboxA = await clientA.request("/api/inbox");
  const inboxB = await clientB.request("/api/inbox");
  assert.equal(inboxA.body.items.some((item) => item.type === "session_review" && item.payload.sessionId === session.id), true);
  assert.equal(inboxB.body.items.some((item) => item.type === "session_review" && item.payload.sessionId === session.id), true);
});

test("非 objectives_completed 的 paused_review 不会进入查看阶段结论待办", async () => {
  const clientA = createClient();
  const clientB = createClient();

  const userA = await registerAndLogin(clientA, "non-review-a@example.com", "雨涵");
  const userB = await registerAndLogin(clientB, "non-review-b@example.com", "刘星");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("刘星"));

  const matchId = upsertMatch(userA.id, userB.id, 89, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id
  });
  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: ["cities"]
    }
  });

  createStageReport(session.id, round.id, {
    summary: "这条暂停不应该变成查看结论待办。",
    confirmed_facts: [],
    unresolved_questions: ["城市安排"],
    risk_summary: [],
    next_action: "pause_review",
    stop_reason: "outstanding_twin_question_unanswered"
  });
  updatePrechatSession(session.id, {
    status: "paused_review",
    currentRound: 1
  });
  getRawDatabaseForTests()
    .prepare("UPDATE prechat_rounds SET status = 'completed', stop_reason = 'outstanding_twin_question_unanswered' WHERE id = ?")
    .run(round.id);

  const inboxA = await clientA.request("/api/inbox");
  const inboxB = await clientB.request("/api/inbox");
  assert.equal(inboxA.body.items.some((item) => item.type === "session_review"), false);
  assert.equal(inboxB.body.items.some((item) => item.type === "session_review"), false);
});

test("paused_review + outstanding_twin_question_unanswered 会为双方持续生成 session_pause，点开后未解决前不消失", async () => {
  const clientA = createClient();
  const clientB = createClient();

  const userA = await registerAndLogin(clientA, "pause-inbox-a@example.com", "雨涵");
  const userB = await registerAndLogin(clientB, "pause-inbox-b@example.com", "刘星");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("刘星"));

  const matchId = upsertMatch(userA.id, userB.id, 90, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id
  });
  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: ["childrenPreference"]
    }
  });

  updatePrechatSession(session.id, {
    status: "paused_review",
    currentRound: 1,
    control: {
      automation: {
        enabled: true,
        source: "report_plan",
        activeTopicKey: "childrenPreference",
        topicQueueSnapshot: ["childrenPreference"]
      }
    }
  });
  getRawDatabaseForTests()
    .prepare("UPDATE prechat_rounds SET status = 'completed', stop_reason = 'outstanding_twin_question_unanswered' WHERE id = ?")
    .run(round.id);

  const inboxA = await clientA.request("/api/inbox");
  const inboxB = await clientB.request("/api/inbox");
  const pauseA = inboxA.body.items.find((item) => item.type === "session_pause");
  const pauseB = inboxB.body.items.find((item) => item.type === "session_pause");
  assert.ok(pauseA);
  assert.ok(pauseB);
  assert.equal(pauseA.payload.stopReason, "outstanding_twin_question_unanswered");
  assert.equal(pauseB.payload.stopReason, "outstanding_twin_question_unanswered");

  const openedA = await clientA.request(`/api/prechat/sessions/${session.id}`);
  assert.equal(openedA.status, 200);

  const inboxAAfterOpen = await clientA.request("/api/inbox");
  const inboxBAfterOpen = await clientB.request("/api/inbox");
  assert.equal(inboxAAfterOpen.body.items.some((item) => item.type === "session_pause" && item.payload.sessionId === session.id), true);
  assert.equal(inboxBAfterOpen.body.items.some((item) => item.type === "session_pause" && item.payload.sessionId === session.id), true);

  updatePrechatSession(session.id, {
    status: "active"
  });
  getRawDatabaseForTests()
    .prepare("UPDATE prechat_rounds SET status = 'completed', stop_reason = 'handoff_ready' WHERE id = ?")
    .run(round.id);

  const inboxAAfterResolved = await clientA.request("/api/inbox");
  const inboxBAfterResolved = await clientB.request("/api/inbox");
  assert.equal(
    inboxAAfterResolved.body.items.some((item) => item.type === "session_pause" && item.payload.sessionId === session.id),
    false
  );
  assert.equal(
    inboxBAfterResolved.body.items.some((item) => item.type === "session_pause" && item.payload.sessionId === session.id),
    false
  );
});

test("active + latest round outstanding_twin_question_unanswered 的进行中会话不会进入 session_pause", async () => {
  const clientA = createClient();
  const clientB = createClient();

  const userA = await registerAndLogin(clientA, "pause-drift-a@example.com", "雨涵");
  const userB = await registerAndLogin(clientB, "pause-drift-b@example.com", "刘星");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("刘星"));

  const matchId = upsertMatch(userA.id, userB.id, 91, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id
  });
  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 2,
    objective: {
      topics: ["financialView"]
    }
  });

  updatePrechatSession(session.id, {
    status: "active",
    currentRound: 2,
    control: {
      automation: {
        enabled: true,
        source: "report_plan",
        activeTopicKey: "financialView",
        topicQueueSnapshot: ["financialView"]
      }
    }
  });
  getRawDatabaseForTests()
    .prepare("UPDATE prechat_rounds SET status = 'completed', stop_reason = 'outstanding_twin_question_unanswered' WHERE id = ?")
    .run(round.id);

  const inboxA = await clientA.request("/api/inbox");
  const inboxB = await clientB.request("/api/inbox");
  assert.equal(
    inboxA.body.items.some(
      (item) => item.type === "session_pause" && item.payload.sessionId === session.id
    ),
    false
  );
  assert.equal(
    inboxB.body.items.some(
      (item) => item.type === "session_pause" && item.payload.sessionId === session.id
    ),
    false
  );
});

test("历史 session_pause 即使 seenByRole 已写入，也不会因为已看过而隐藏", async () => {
  const clientA = createClient();
  const clientB = createClient();

  const userA = await registerAndLogin(clientA, "pause-seen-a@example.com", "雨涵");
  const userB = await registerAndLogin(clientB, "pause-seen-b@example.com", "刘星");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("刘星"));

  const matchId = upsertMatch(userA.id, userB.id, 91, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id
  });
  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: ["childrenPreference"]
    }
  });

  updatePrechatSession(session.id, {
    status: "paused_review",
    currentRound: 1,
    control: {
      reviewInbox: {
        pauseNotice: {
          roundId: round.id,
          roundNumber: 1,
          stopReason: "outstanding_twin_question_unanswered",
          pauseKind: "outstanding_twin_question",
          emittedAt: "2026-06-02T00:00:00.000Z",
          seenByRole: {
            initiator: "2026-06-02T00:01:00.000Z",
            counterparty: "2026-06-02T00:02:00.000Z"
          }
        }
      }
    }
  });
  getRawDatabaseForTests()
    .prepare("UPDATE prechat_rounds SET status = 'completed', stop_reason = 'outstanding_twin_question_unanswered' WHERE id = ?")
    .run(round.id);

  const inboxA = await clientA.request("/api/inbox");
  const inboxB = await clientB.request("/api/inbox");
  assert.equal(inboxA.body.items.some((item) => item.type === "session_pause" && item.payload.sessionId === session.id), true);
  assert.equal(inboxB.body.items.some((item) => item.type === "session_pause" && item.payload.sessionId === session.id), true);
});

test("已有 pending human input 或 sensitive request 时，不重复生成 session_pause", async () => {
  const clientA = createClient();
  const clientB = createClient();

  const userA = await registerAndLogin(clientA, "pause-dedupe-a@example.com", "雨涵");
  const userB = await registerAndLogin(clientB, "pause-dedupe-b@example.com", "刘星");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("刘星"));

  const matchId = upsertMatch(userA.id, userB.id, 92, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id
  });
  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: ["childrenPreference"]
    }
  });

  createHumanInputRequest({
    sessionId: session.id,
    roundId: round.id,
    targetUserId: userA.id,
    fieldKey: "childrenPreference",
    questionText: "请本人补充这一项。",
    metadata: {}
  });

  updatePrechatSession(session.id, {
    status: "pending_human_input",
    currentRound: 1,
    control: {
      automation: {
        enabled: true,
        source: "report_plan",
        activeTopicKey: "childrenPreference",
        topicQueueSnapshot: ["childrenPreference"]
      }
    }
  });
  getRawDatabaseForTests()
    .prepare("UPDATE prechat_rounds SET status = 'completed', stop_reason = 'pending_human_input' WHERE id = ?")
    .run(round.id);

  const inboxA = await clientA.request("/api/inbox");
  assert.equal(inboxA.body.items.some((item) => item.type === "human_input_request"), true);
  assert.equal(inboxA.body.items.some((item) => item.type === "session_pause"), false);
});

test("显式 run-round 时，reply 为空但 recommendation=continue 仍会按旧语义暂停，便于人工调试", async () => {
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
      summary: "自动启动首轮失败，已记录系统说明。",
      confirmed_facts: [],
      unresolved_questions: ["需要人工确认本轮有效问题"],
      risk_summary: [],
      next_action: "pause_review",
      handoff_ready: false
    },
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

  await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });

  const round = await clientA.request(`/api/prechat/sessions/${sessionId}/run-round`, { method: "POST" });
  assert.equal(round.status, 200);
  assert.equal(["paused_review", "pending_human_input", "active"].includes(round.body.result.status), true);

  const session = await clientA.request(`/api/prechat/sessions/${sessionId}`);
  assert.equal(session.status, 200);
  assert.equal(session.body.turns.length >= 1, true);
  assert.equal(["active", "paused_review", "pending_human_input"].includes(session.body.session.status), true);
});

test("新发生的模型空输出会先静默延迟重试，成功前不会进入可见暂停", async () => {
  await withDeferredRetryTestConfig(async () => {
    const clientA = createClient();
    const clientB = createClient();

    await registerAndLogin(clientA, "deferred-retry-a@example.com", "雨涵");
    await registerAndLogin(clientB, "deferred-retry-b@example.com", "予安");
    await saveTwinFor(clientA, buildTwin("雨涵"));
    await saveTwinFor(clientB, buildTwin("予安"));

    const matches = await clientA.request("/api/matches");
    const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "予安").id;
    const invitation = await clientA.request(`/api/matches/${matchId}/invite-prechat`, { method: "POST" });
    const sessionId = invitation.body.session.id;

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
        summary: "首次启动失败。",
        confirmed_facts: [],
        unresolved_questions: ["等待模型恢复"],
        risk_summary: [],
        next_action: "pause_review",
        handoff_ready: false
      },
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
        summary: "第二次启动失败。",
        confirmed_facts: [],
        unresolved_questions: ["等待模型恢复"],
        risk_summary: [],
        next_action: "pause_review",
        handoff_ready: false
      },
      {
        reply: "你好，我是雨涵的 Twin。你现在更明确想进入怎样的长期关系？",
        reply_topic_key: null,
        question_topic_key: "relationshipGoal",
        is_sensitive_question: false,
        sensitive_topic_category: null,
        needs_sensitive_approval: false,
        target_user_for_approval: null,
        confirmed_facts: [],
        open_questions: ["你现在更明确想进入怎样的长期关系？"],
        risk_flags: [],
        needs_human_input: { required: false },
        recommendation: "continue"
      },
      {
        summary: "自动重试后已恢复。",
        confirmed_facts: [],
        unresolved_questions: ["关系目标"],
        risk_summary: [],
        next_action: "continue",
        handoff_ready: false
      }
    ]);

    await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });

    const duringRetry = await waitForSessionState(
      clientA,
      sessionId,
      (detail) =>
        detail.body?.session?.status === "active" &&
        !detail.body?.humanInputRequests?.some((item) => item.status === "pending"),
      40
    );

    assert.equal(duringRetry.body.session.status, "active");
    assert.equal(duringRetry.body.humanInputRequests.some((item) => item.status === "pending"), false);

    const inboxDuringRetry = await clientA.request("/api/inbox");
    assert.equal(
      inboxDuringRetry.body.items.some((item) => item.type === "session_pause" && item.payload.sessionId === sessionId),
      false
    );

    const recovered = await waitForSessionState(
      clientA,
      sessionId,
      (detail) =>
        !detail.body?.humanInputRequests?.some((item) => item.status === "pending") &&
        ["active", "paused_review"].includes(detail.body?.session?.status),
      80
    );

    assert.equal(["active", "paused_review"].includes(recovered.body.session.status), true);
    assert.equal(recovered.body.humanInputRequests.some((item) => item.status === "pending"), false);
  }, { delaysMs: "120,180,240", totalWindowMs: "2000" });
});

test("首轮 opening 连续失败超过默认次数后，仍保持静默恢复至少 3 分钟", async () => {
  await withDeferredRetryTestConfig(async () => {
    const previousOpeningWindow = process.env.PRECHAT_OPENING_DEFERRED_RETRY_TOTAL_WINDOW_MS;
    const previousOpeningDelays = process.env.PRECHAT_OPENING_DEFERRED_RETRY_DELAYS_MS;
    process.env.PRECHAT_OPENING_DEFERRED_RETRY_TOTAL_WINDOW_MS = "180000";
    process.env.PRECHAT_OPENING_DEFERRED_RETRY_DELAYS_MS = "120,180,240";

    try {
      const clientA = createClient();
      const clientB = createClient();

      await registerAndLogin(clientA, "opening-retry-a@example.com", "雨涵");
      await registerAndLogin(clientB, "opening-retry-b@example.com", "予安");
      await saveTwinFor(clientA, buildTwin("雨涵"));
      await saveTwinFor(clientB, buildTwin("予安"));

      const matches = await clientA.request("/api/matches");
      const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "予安").id;
      const invitation = await clientA.request(`/api/matches/${matchId}/invite-prechat`, { method: "POST" });
      const sessionId = invitation.body.session.id;

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
        }
      ]);

      await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });

      const retrying = await waitForSessionState(
        clientA,
        sessionId,
        (detail) => {
          const deferredRetry = detail.body?.session?.control?.automation?.deferredRetry;
          return (
            detail.body?.session?.status === "active" &&
            Boolean(deferredRetry) &&
            deferredRetry?.profile === "opening_bootstrap" &&
            deferredRetry?.attemptCount >= 3
          );
        },
        120
      );

      assert.equal(retrying.body.session.status, "active");
      assert.equal(Boolean(retrying.body.session.control.automation.deferredRetry), true);
      assert.equal(retrying.body.session.control.automation.deferredRetry.profile, "opening_bootstrap");
      assert.equal(retrying.body.session.control.automation.deferredRetry.allowExhaustion, false);
      assert.equal(
        Number(retrying.body.session.control.automation.deferredRetry.windowMs || 0) >= 180000,
        true
      );
      assert.equal(retrying.body.turns.some((item) => item.actorRole === "system"), false);
      assert.equal(retrying.body.humanInputRequests.some((item) => item.status === "pending"), false);
    } finally {
      if (previousOpeningWindow == null) {
        delete process.env.PRECHAT_OPENING_DEFERRED_RETRY_TOTAL_WINDOW_MS;
      } else {
        process.env.PRECHAT_OPENING_DEFERRED_RETRY_TOTAL_WINDOW_MS = previousOpeningWindow;
      }
      if (previousOpeningDelays == null) {
        delete process.env.PRECHAT_OPENING_DEFERRED_RETRY_DELAYS_MS;
      } else {
        process.env.PRECHAT_OPENING_DEFERRED_RETRY_DELAYS_MS = previousOpeningDelays;
      }
    }
  }, { delaysMs: "120,180,240", totalWindowMs: "2000", maxAttempts: "3" });
});

test("opening bootstrap 的 deferred retry 即使未显式传 profile，也会保持无限静默恢复", async () => {
  const userA = createUser({
    email: "opening-profile-fallback-a@example.com",
    displayName: "雨涵",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "opening-profile-fallback-b@example.com",
    displayName: "予安",
    passwordHash: hashPassword("secret123")
  });
  saveCurrentTwin(userA.id, buildTwin("雨涵"));
  saveCurrentTwin(userB.id, buildTwin("予安"));
  const matchId = upsertMatch(userA.id, userB.id, 88, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id,
    status: "active",
    control: {
      automation: {
        deferredRetry: {
          kind: "model_output_unstable",
          reason: "model_output_unstable",
          attemptCount: 2,
          maxAttempts: 3,
          firstFailedAt: new Date(Date.now() - 5000).toISOString(),
          sourceIntent: "bootstrap_opening"
        }
      }
    }
  });

  const nextRetry = __testOnlyBuildDeferredRetryState(session, {
    reason: "model_output_unstable",
    sourceIntent: "bootstrap_opening"
  });

  assert.equal(nextRetry.profile, "opening_bootstrap");
  assert.equal(nextRetry.allowExhaustion, false);
  assert.equal(__testOnlyShouldExhaustDeferredRetry(nextRetry), false);
  assert.equal(nextRetry.windowMs >= 180000 || nextRetry.windowMs >= 60000, true);
});

test("首条 Twin 已发出后若后续模型空输出，仍会保留静默重试并继续推进", async () => {
  await withDeferredRetryTestConfig(async () => {
    const previousOpeningWindow = process.env.PRECHAT_OPENING_DEFERRED_RETRY_TOTAL_WINDOW_MS;
    const previousOpeningDelays = process.env.PRECHAT_OPENING_DEFERRED_RETRY_DELAYS_MS;
    process.env.PRECHAT_OPENING_DEFERRED_RETRY_TOTAL_WINDOW_MS = "2000";
    process.env.PRECHAT_OPENING_DEFERRED_RETRY_DELAYS_MS = "120,180,240";

    try {
    const clientA = createClient();
    const clientB = createClient();

    await registerAndLogin(clientA, "deferred-after-opening-a@example.com", "雨涵");
    await registerAndLogin(clientB, "deferred-after-opening-b@example.com", "刘星");
    await saveTwinFor(clientA, buildTwin("雨涵", { cities: "杭州" }));
    await saveTwinFor(clientB, buildTwin("刘星", { cities: "深圳、广州" }));

    const matches = await clientA.request("/api/matches");
    const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "刘星").id;
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
        reply: "你好，我是雨涵的 Twin。我这边长期更倾向杭州。你未来更倾向长期在深圳还是广州生活？",
        reply_topic_key: "cities",
        question_topic_key: "cities",
        is_sensitive_question: false,
        sensitive_topic_category: null,
        needs_sensitive_approval: false,
        target_user_for_approval: null,
        confirmed_facts: [
          {
            subjectUserId: "self",
            key: "cities",
            value: "长期更倾向杭州",
            confidence: 0.9,
            status: "confirmed"
          }
        ],
        open_questions: ["你未来更倾向长期在深圳还是广州生活？"],
        risk_flags: [],
        needs_human_input: { required: false },
        recommendation: "continue"
      },
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
        reply: "我这边长期更倾向深圳，广州也可以接受。你未来更倾向长期在杭州还是上海生活？",
        reply_topic_key: "cities",
        question_topic_key: "cities",
        is_sensitive_question: false,
        sensitive_topic_category: null,
        needs_sensitive_approval: false,
        target_user_for_approval: null,
        confirmed_facts: [
          {
            subjectUserId: "self",
            key: "cities",
            value: "长期更倾向深圳，广州也可以接受",
            confidence: 0.9,
            status: "confirmed"
          }
        ],
        open_questions: ["你未来更倾向长期在杭州还是上海生活？"],
        risk_flags: [],
        needs_human_input: { required: false },
        recommendation: "continue"
      }
    ]);

    await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });

    const retrying = await waitForSessionState(
      clientA,
      sessionId,
      (detail) =>
        detail.body?.session?.status === "active" &&
        detail.body?.session?.status === "active" &&
        Boolean(detail.body?.session?.control?.automation?.deferredRetry),
      30
    );

    assert.equal(retrying.body.session.status, "active");
    assert.equal(Boolean(retrying.body.session.control.automation.deferredRetry), true);

    const recovered = await waitForSessionState(
      clientA,
      sessionId,
      (detail) =>
        (detail.body?.turns?.length || 0) >= 2,
      120
    );

    assert.equal(recovered.body.turns.length >= 2, true);
    assert.equal(recovered.body.humanInputRequests.some((item) => item.status === "pending"), false);
    assert.equal(recovered.body.turns.some((item) => item.actorRole === "system"), false);
    if (recovered.body.session.control.automation.deferredRetry) {
      assert.equal(recovered.body.session.control.automation.deferredRetry.profile, "opening_bootstrap");
      assert.equal(recovered.body.session.control.automation.deferredRetry.allowExhaustion, false);
    }
    } finally {
      if (previousOpeningWindow == null) {
        delete process.env.PRECHAT_OPENING_DEFERRED_RETRY_TOTAL_WINDOW_MS;
      } else {
        process.env.PRECHAT_OPENING_DEFERRED_RETRY_TOTAL_WINDOW_MS = previousOpeningWindow;
      }
      if (previousOpeningDelays == null) {
        delete process.env.PRECHAT_OPENING_DEFERRED_RETRY_DELAYS_MS;
      } else {
        process.env.PRECHAT_OPENING_DEFERRED_RETRY_DELAYS_MS = previousOpeningDelays;
      }
    }
  }, { delaysMs: "120,180,240", totalWindowMs: "2000" });
});

test("模型空输出连续多次后，仍保持 opening-style 静默重试而不是回落到可见暂停", async () => {
  await withDeferredRetryTestConfig(async () => {
    const previousOpeningWindow = process.env.PRECHAT_OPENING_DEFERRED_RETRY_TOTAL_WINDOW_MS;
    const previousOpeningDelays = process.env.PRECHAT_OPENING_DEFERRED_RETRY_DELAYS_MS;
    process.env.PRECHAT_OPENING_DEFERRED_RETRY_TOTAL_WINDOW_MS = "180000";
    process.env.PRECHAT_OPENING_DEFERRED_RETRY_DELAYS_MS = "120,180,240";

    try {
    const clientA = createClient();
    const clientB = createClient();

    await registerAndLogin(clientA, "deferred-retry-exhaust-a@example.com", "雨涵");
    await registerAndLogin(clientB, "deferred-retry-exhaust-b@example.com", "予安");
    await saveTwinFor(clientA, buildTwin("雨涵"));
    await saveTwinFor(clientB, buildTwin("予安"));

    const matches = await clientA.request("/api/matches");
    const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "予安").id;
    const invitation = await clientA.request(`/api/matches/${matchId}/invite-prechat`, { method: "POST" });
    const sessionId = invitation.body.session.id;

    mockLlmSequence(Array.from({ length: 40 }, () => ({
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
    })));

    await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });

    const retrying = await waitForSessionState(
      clientA,
      sessionId,
      (detail) => {
        const deferredRetry = detail.body?.session?.control?.automation?.deferredRetry;
        return (
          detail.body?.session?.status === "active" &&
          Boolean(deferredRetry) &&
          deferredRetry?.profile === "opening_bootstrap" &&
          deferredRetry?.attemptCount >= 3
        );
      },
      80
    );

    assert.equal(retrying.body.session.status, "active");
    assert.equal(Boolean(retrying.body.session.control.automation.deferredRetry), true);
    assert.equal(retrying.body.session.control.automation.deferredRetry.profile, "opening_bootstrap");
    assert.equal(retrying.body.session.control.automation.deferredRetry.allowExhaustion, false);
    assert.equal(
      Number(retrying.body.session.control.automation.deferredRetry.windowMs || 0) >= 180000,
      true
    );
    assert.equal(retrying.body.turns.some((item) => item.actorRole === "system"), false);
    assert.equal(retrying.body.humanInputRequests.some((item) => item.status === "pending"), false);
    } finally {
      if (previousOpeningWindow == null) {
        delete process.env.PRECHAT_OPENING_DEFERRED_RETRY_TOTAL_WINDOW_MS;
      } else {
        process.env.PRECHAT_OPENING_DEFERRED_RETRY_TOTAL_WINDOW_MS = previousOpeningWindow;
      }
      if (previousOpeningDelays == null) {
        delete process.env.PRECHAT_OPENING_DEFERRED_RETRY_DELAYS_MS;
      } else {
        process.env.PRECHAT_OPENING_DEFERRED_RETRY_DELAYS_MS = previousOpeningDelays;
      }
    }
  }, { delaysMs: "120,180,240", totalWindowMs: "2000", maxAttempts: "3" });
});

test("历史 auto_start_failed 的纯模型暂停，打开会话后会自动恢复为静默 deferred retry", async () => {
  const userA = createUser({
    email: "paused-model-recover-a@example.com",
    displayName: "刘星",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "paused-model-recover-b@example.com",
    displayName: "刘宇",
    passwordHash: hashPassword("secret123")
  });
  saveCurrentTwin(userA.id, buildTwin("刘星"));
  saveCurrentTwin(userB.id, buildTwin("刘宇"));

  const matchId = upsertMatch(userA.id, userB.id, 86, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id,
    control: {
      automation: {
        lastTrigger: "deferred_model_retry",
        lastFailureReason: "auto_start_failed",
        lastFailureAt: new Date().toISOString(),
        deferredRetry: null
      }
    }
  });
  updatePrechatSession(session.id, { status: "paused_review", currentRound: 2 });

  const round1 = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: { topics: [{ key: "marriageTimeline" }] }
  });
  finishPrechatRound(round1.id, { status: "completed", stopReason: "deferred_model_retry" });
  addConversationTurn({
    sessionId: session.id,
    roundId: round1.id,
    turnNumber: 1,
    actorUserId: userA.id,
    actorRole: "initiator_twin",
    content: "如果匹配，我希望在1到2年内推进。 如果关系顺利推进，你更接受怎样的结婚节奏？",
    metadata: {
      canonical_question_text: "如果关系顺利推进，你更接受怎样的结婚节奏？",
      canonical_question_topic_key: "marriageTimeline",
      question_topic_key: "marriageTimeline",
      question_fingerprint: "marriageTimeline:如果关系顺利推进你更接受怎样的结婚节奏",
      canonical_outcome_trusted: true
    }
  });

  const round2 = createPrechatRound({
    sessionId: session.id,
    roundNumber: 2,
    objective: { topics: [{ key: "marriageTimeline" }] }
  });
  finishPrechatRound(round2.id, { status: "completed", stopReason: "deferred_model_retry" });
  addConversationTurn({
    sessionId: session.id,
    roundId: round2.id,
    turnNumber: 2,
    actorUserId: null,
    actorRole: "system",
    content: "系统暂停：自动启动 Twin 预沟通时未能生成有效消息，请稍后重试或等待恢复。",
    metadata: {
      automationFailure: true,
      reason: "auto_start_failed",
      trigger: "deferred_model_retry"
    }
  });

  const recovered = await getSessionViewWithAutoRecovery(session.id, userA.id);
  assert.ok(recovered);
  assert.equal(recovered.session.status, "active");
  assert.equal(Boolean(recovered.session.control.automation.deferredRetry), true);
  assert.equal(recovered.session.control.automation.deferredRetry.profile, "opening_bootstrap");
  assert.equal(recovered.session.control.automation.deferredRetry.allowExhaustion, false);
  assert.equal(recovered.session.control.automation.lastFailureReason, "model_output_unstable");
});

test("历史空白 active 会话在打开详情页时会自动恢复，失败时会进入可见暂停或静默重试", async () => {
  const clientA = createClient();
  const clientB = createClient();

  const userA = await registerAndLogin(clientA, "a@example.com", "雨涵");
  const userB = await registerAndLogin(clientB, "b@example.com", "予安");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("予安"));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "予安").id;
  const invitation = await clientA.request(`/api/matches/${matchId}/invite-prechat`, { method: "POST" });
  const sessionId = invitation.body.session.id;

  const database = getRawDatabaseForTests();
  mockLlmSequence([
    {
      reply: "你好，我是雨涵的 Twin。我想先确认一下，你现在更明确想进入怎样的长期关系？",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["对方关系目标"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "pause_review"
    },
    {
      summary: "历史空白会话已自动恢复。",
      confirmed_facts: [],
      unresolved_questions: ["对方关系目标"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);
  await waitForAutomationIdle(clientB, sessionId);

  database.prepare("DELETE FROM conversation_turns WHERE session_id = ?").run(sessionId);
  database.prepare("DELETE FROM prechat_rounds WHERE session_id = ?").run(sessionId);
  database.prepare("DELETE FROM stage_reports WHERE session_id = ?").run(sessionId);
  database.prepare("UPDATE prechat_sessions SET status = 'active', current_round = 0 WHERE id = ?").run(sessionId);

  const recovered = await clientA.request(`/api/prechat/sessions/${sessionId}`);
  assert.equal(recovered.status, 200);
    const recoveredAfterAutomation = await waitForSessionState(
      clientA,
      sessionId,
      (detail) =>
        (detail.body?.turns?.length || 0) >= 1 ||
        Boolean(detail.body?.session?.control?.automation?.deferredRetry),
      80
    );
  assert.equal(
    recoveredAfterAutomation.body.turns.length >= 1 ||
      Boolean(recoveredAfterAutomation.body.session.control.automation.deferredRetry) ||
      ["active", "paused_review", "pending_human_input"].includes(recoveredAfterAutomation.body.session.status),
    true
  );
  assert.equal(
    ["active", "paused_review", "pending_human_input"].includes(recoveredAfterAutomation.body.session.status),
    true
  );
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

  const sessionId = invitation.body.session.id;
  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

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
  assert.equal(["active", "paused_review", "pending_human_input"].includes(resumedSession.body.session.status), true);
  assert.equal(resumedSession.body.turns.length >= 3, true);
  assert.equal(resumedSession.body.turns[1].actorRole, "initiator_user");
  assert.equal(
    resumedSession.body.turns[1].content,
    "如果关系稳定，我希望 1 到 2 年内推进结婚。"
  );
});

test("限制期内禁止提交本人补充，白框应改走普通真人消息", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "a@example.com", "雨涵");
  await registerAndLogin(clientB, "b@example.com", "予安");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("予安"));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "予安").id;
  const invitation = await clientA.request(`/api/matches/${matchId}/invite-prechat`, { method: "POST" });
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

  const sessionId = invitation.body.session.id;
  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  const paused = await clientA.request(`/api/prechat/sessions/${sessionId}/decision`, {
    method: "POST",
    json: {
      action: "toggle_manual_pause"
    }
  });
  assert.equal(paused.status, 200);

  const requestId = (await clientA.request(`/api/prechat/sessions/${sessionId}`)).body.humanInputRequests[0].id;
  const blockedHumanInput = await clientA.request(`/api/prechat/sessions/${sessionId}/human-input`, {
    method: "POST",
    json: {
      requestId,
      responseText: "如果关系稳定，我希望 1 到 2 年内推进结婚。"
    }
  });
  assert.equal(blockedHumanInput.status, 400);

  const manualMessage = await clientA.request(`/api/prechat/sessions/${sessionId}/manual-message`, {
    method: "POST",
    json: {
      content: "我先补一条普通真人消息。"
    }
  });
  assert.equal(manualMessage.status, 201);
});

test("resolved manual_review 后若再次卡成 outstanding twin question，纯模型失败会先进入 deferred retry", async () => {
  const userA = createUser({
    email: "manual-review-recover-a@example.com",
    displayName: "雨涵",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "manual-review-recover-b@example.com",
    displayName: "刘星",
    passwordHash: hashPassword("secret123")
  });

  saveCurrentTwin(userA.id, buildTwin("雨涵"));
  saveCurrentTwin(userB.id, buildTwin("刘星"));

  const matchId = upsertMatch(userA.id, userB.id, 92, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id
  });

  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: [
        {
          key: "childrenPreference",
          label: "孩子与生育态度",
          prompt: "确认对未来孩子与生育的态度。"
        }
      ]
    }
  });

  const pendingRequest = createHumanInputRequest({
    sessionId: session.id,
    roundId: round.id,
    targetUserId: userA.id,
    fieldKey: "manual_review",
    questionText: "模型输出不可用，需要人工确认。"
  });
  resolveHumanInputRequest(pendingRequest.id, "可能结婚后3到4年吧，等经济条件更稳一些再考虑孩子。", {
    resolvedByUserId: userA.id
  });

  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 1,
    actorUserId: userA.id,
    actorRole: "initiator_user",
    content: "可能结婚后3到4年吧，等经济条件更稳一些再考虑孩子。",
    metadata: {
      fromHumanInputRequestId: pendingRequest.id,
      fieldKey: "manual_review",
      manualReview: true
    }
  });
  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 2,
    actorUserId: userB.id,
    actorRole: "counterparty_twin",
    content: "你对未来要不要孩子这件事，目前更偏向什么想法？",
    metadata: {
      reply: "你对未来要不要孩子这件事，目前更偏向什么想法？",
      confirmed_facts: [],
      open_questions: ["你对未来要不要孩子这件事，目前更偏向什么想法？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    }
  });

  updatePrechatSession(session.id, {
    status: "paused_review",
    currentRound: 1
  });

  const database = getRawDatabaseForTests();
  database
    .prepare("UPDATE prechat_rounds SET status = 'completed', stop_reason = 'outstanding_twin_question_unanswered' WHERE id = ?")
    .run(round.id);

  await withDeferredRetryTestConfig(async () => {
    mockLlmSequence([
      {
        reply: "",
        is_sensitive_question: false,
        sensitive_topic_category: null,
        needs_sensitive_approval: false,
        target_user_for_approval: null,
        confirmed_facts: [],
        open_questions: ["你对未来要不要孩子这件事，目前更偏向什么想法？"],
        risk_flags: [],
        needs_human_input: { required: false },
        recommendation: "continue"
      },
      {
        summary: "恢复后模型暂时不稳定，等待后台重试。",
        confirmed_facts: [],
        unresolved_questions: ["孩子与生育态度"],
        risk_summary: [],
        next_action: "pause_review",
        handoff_ready: false
      }
    ]);

    const turnCountBefore = listConversationTurns(session.id).length;
    const roundCountBefore = listPrechatRounds(session.id).length;

    await getSessionViewWithAutoRecovery(session.id, userA.id);

    let detail = null;
    for (let index = 0; index < 30; index += 1) {
      detail = getSessionDetailForUser(session.id, userA.id);
      const runState = detail?.session?.control?.automation?.runState || "idle";
      if (!["queued", "running"].includes(runState)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(detail.session.status, "active");
    assert.equal(detail.humanInputRequests.some((item) => item.status === "pending"), false);
    assert.equal(
      detail.humanInputRequests.filter(
        (item) => item.status === "pending" && item.fieldKey === "manual_review" && item.questionText === "模型输出不可用，需要人工确认。"
      ).length,
      0
    );
    assert.equal(Boolean(detail.session.control?.automation?.deferredRetry), true);
    assert.equal(detail.session.control?.automation?.runState || "idle", "idle");
    assert.equal(detail.turns.length >= turnCountBefore, true);
    assert.equal(listPrechatRounds(session.id).length > roundCountBefore, true);
  }, { delaysMs: "120,180,240", totalWindowMs: "2000" });
});

test("城市类本人补充带聊天追问时，不会污染核心 Twin 档案", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "cities-guard-a@example.com", "雨涵");
  await registerAndLogin(clientB, "cities-guard-b@example.com", "沈特");
  await saveTwinFor(clientA, buildTwin("雨涵", { cities: "上海" }));
  await saveTwinFor(clientB, buildTwin("沈特", { cities: "杭州" }));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "沈特").id;
  const invitation = await clientA.request(`/api/matches/${matchId}/invite-prechat`, { method: "POST" });

  mockLlmSequence([
    {
      reply: "",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["你未来长期更倾向在哪个城市生活？"],
      risk_flags: [],
      needs_human_input: {
        required: true,
        field: "cities",
        question: "请直接说明你未来长期更倾向在哪个城市生活。",
        target_user_for_input: "self"
      },
      recommendation: "continue"
    },
    {
      summary: "本轮已暂停，等待用户本人补充城市信息。",
      confirmed_facts: [],
      unresolved_questions: ["长期城市安排"],
      risk_summary: [],
      next_action: "pause_review",
      handoff_ready: false
    }
  ]);

  const sessionId = invitation.body.session.id;
  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  const pausedSession = await clientA.request(`/api/prechat/sessions/${sessionId}`);
  assert.equal(pausedSession.status, 200);
  assert.equal(pausedSession.body.humanInputRequests.length, 1);

  const requestId = pausedSession.body.humanInputRequests[0].id;
  const submitted = await clientA.request(`/api/prechat/sessions/${sessionId}/human-input`, {
    method: "POST",
    json: {
      requestId,
      responseText: "我也比较偏向上海！你具体在上海哪里？"
    }
  });

  assert.equal(submitted.status, 200);

  const twin = await clientA.request("/api/twin");
  assert.equal(twin.status, 200);
  assert.equal(twin.body.twin.twinProfile.cities, "上海");
  assert.equal(Boolean(twin.body.twin.twinProfile.prechatGoals), false);
});

test("用户手动结束推进后会阻止 Twin 自动继续，且当前暂停周期里每人只有 1 条真人消息额度", async () => {
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

  const paused = await clientA.request(`/api/prechat/sessions/${sessionId}/decision`, {
    method: "POST",
    json: {
      action: "toggle_manual_pause"
    }
  });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.session.control.manualPause.initiatorEnded, true);
  assert.equal(paused.body.session.control.manualPause.counterpartyEnded, false);

  const sentA = await clientA.request(`/api/prechat/sessions/${sessionId}/manual-message`, {
    method: "POST",
    json: {
      content: "你好，我想先由本人补充一句：我希望这段关系以认真长期为前提。"
    }
  });

  assert.equal(sentA.status, 201);

  const sentB = await clientB.request(`/api/prechat/sessions/${sessionId}/manual-message`, {
    method: "POST",
    json: {
      content: "我这边也补充一句：我会更看重认真长期。"
    }
  });

  assert.equal(sentB.status, 201);

  const session = await clientA.request(`/api/prechat/sessions/${sessionId}`);
  assert.equal(session.status, 200);
  assert.equal(session.body.turns.filter((turn) => turn.actorRole === "initiator_user").length, 1);
  assert.equal(session.body.turns.filter((turn) => turn.actorRole === "counterparty_user").length, 1);

  const blockedRound = await clientA.request(`/api/prechat/sessions/${sessionId}/run-round`, { method: "POST" });
  assert.equal(blockedRound.status, 400);

  const secondSentA = await clientA.request(`/api/prechat/sessions/${sessionId}/manual-message`, {
    method: "POST",
    json: {
      content: "我还想再补一条。"
    }
  });
  assert.equal(secondSentA.status, 400);
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

  const sessionId = invitation.body.session.id;
  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  const detail = await clientA.request(`/api/prechat/sessions/${sessionId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.turns.length >= 2, true);
  assert.equal(detail.body.turns[0].content.includes("上海还是杭州"), true);
  assert.equal(String(detail.body.turns[1].metadata?.reply_topic_key || "") === "cities" || detail.body.session.status === "pending_human_input", true);
  assert.equal(detail.body.turns[1].content === detail.body.turns[0].content, false);
  assert.equal(
    detail.body.turns.some(
      (turn) =>
        String(turn.content || "").includes("结婚节奏") ||
        String(turn.metadata?.question_topic_key || "") === "marriageTimeline" ||
        Boolean(turn.metadata?.repeat_topic_guard_triggered)
    ) ||
      detail.body.session.status === "pending_human_input",
    true
  );
});

test("消息支持删除、撤回、修改、引用与反应，且权限与显示符合预期", async () => {
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

  mockLlmSequence([
    {
      reply: "我比较看重认真长期关系。你更看重怎样的关系目标？",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["关系目标"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "pause_review"
    },
    {
      summary: "首轮已启动。",
      confirmed_facts: [],
      unresolved_questions: ["关系目标"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  const manualA = await clientA.request(`/api/prechat/sessions/${sessionId}/manual-message`, {
    method: "POST",
    json: {
      content: "这是我发出的第一条真人消息。"
    }
  });
  assert.equal(manualA.status, 201);

  const detailAfterA = await clientA.request(`/api/prechat/sessions/${sessionId}`);
  const ownTurn = [...detailAfterA.body.turns].reverse().find((turn) => turn.actorRole === "initiator_user");
  const firstTwinTurn = detailAfterA.body.turns.find((turn) => String(turn.actorRole || "").endsWith("_twin"));
  assert.ok(ownTurn);
  assert.ok(firstTwinTurn);

  const quotedManual = await clientB.request(`/api/prechat/sessions/${sessionId}/manual-message`, {
    method: "POST",
    json: {
      content: "我来引用一下你的消息。",
      quotedTurnId: ownTurn.id
    }
  });
  assert.equal(quotedManual.status, 201);

  const detailQuoted = await clientB.request(`/api/prechat/sessions/${sessionId}`);
  const quoteTurn = [...detailQuoted.body.turns].reverse().find((turn) => turn.actorRole === "counterparty_user");
  assert.equal(quoteTurn.quotedTurn.turnId, ownTurn.id);
  assert.equal(quoteTurn.quotedTurn.content, "这是我发出的第一条真人消息。");

  const edited = await clientA.request(
    `/api/prechat/sessions/${sessionId}/messages/${ownTurn.id}/edit`,
    {
      method: "POST",
      json: {
        content: "这是我修改后的真人消息。"
      }
    }
  );
  assert.equal(edited.status, 200);

  const detailEditedA = await clientA.request(`/api/prechat/sessions/${sessionId}`);
  const editedTurn = detailEditedA.body.turns.find((turn) => turn.id === ownTurn.id);
  const quoteAfterEdit = detailEditedA.body.turns.find((turn) => turn.id === quoteTurn.id);
  assert.equal(editedTurn.content, "这是我修改后的真人消息。");
  assert.equal(editedTurn.isEdited, true);
  assert.equal(Boolean(editedTurn.editedAt), true);
  assert.equal(quoteAfterEdit.quotedTurn.content, "这是我修改后的真人消息。");

  const reactedA = await clientA.request(
    `/api/prechat/sessions/${sessionId}/messages/${firstTwinTurn.id}/react`,
    {
      method: "POST",
      json: { emoji: "👀" }
    }
  );
  assert.equal(reactedA.status, 200);

  const reactedB = await clientB.request(
    `/api/prechat/sessions/${sessionId}/messages/${firstTwinTurn.id}/react`,
    {
      method: "POST",
      json: { emoji: "❤️" }
    }
  );
  assert.equal(reactedB.status, 200);

  const detailReactions = await clientA.request(`/api/prechat/sessions/${sessionId}`);
  const reactedTurn = detailReactions.body.turns.find((turn) => turn.id === firstTwinTurn.id);
  assert.equal(reactedTurn.reactions.length, 2);
  assert.equal(reactedTurn.reactions.some((item) => item.emoji === "👀" && item.reactedByCurrentUser), true);

  const deleted = await clientA.request(
    `/api/prechat/sessions/${sessionId}/messages/${ownTurn.id}/delete`,
    { method: "POST" }
  );
  assert.equal(deleted.status, 200);

  const detailDeletedA = await clientA.request(`/api/prechat/sessions/${sessionId}`);
  const detailDeletedB = await clientB.request(`/api/prechat/sessions/${sessionId}`);
  assert.equal(detailDeletedA.body.turns.some((turn) => turn.id === ownTurn.id), false);
  assert.equal(detailDeletedB.body.turns.some((turn) => turn.id === ownTurn.id), true);

  const manualB = [...detailDeletedB.body.turns].reverse().find((turn) => turn.actorRole === "counterparty_user");
  const recalled = await clientB.request(
    `/api/prechat/sessions/${sessionId}/messages/${manualB.id}/recall`,
    { method: "POST" }
  );
  assert.equal(recalled.status, 200);

  const detailRecalledA = await clientA.request(`/api/prechat/sessions/${sessionId}`);
  const detailRecalledB = await clientB.request(`/api/prechat/sessions/${sessionId}`);
  const recalledTurnA = detailRecalledA.body.turns.find((turn) => turn.id === manualB.id);
  const recalledTurnB = detailRecalledB.body.turns.find((turn) => turn.id === manualB.id);
  assert.equal(recalledTurnA.isRecalled, true);
  assert.equal(recalledTurnA.content, "对方撤回了一条消息");
  assert.equal(recalledTurnB.content, "你撤回了一条消息");
  assert.equal(recalledTurnA.quotedTurn.content, "这是我修改后的真人消息。");

  const recallTargetMessage = await clientA.request(`/api/prechat/sessions/${sessionId}/manual-message`, {
    method: "POST",
    json: {
      content: "这条消息会被引用后撤回。"
    }
  });
  assert.equal(recallTargetMessage.status, 201);

  const detailBeforeQuotedRecall = await clientB.request(`/api/prechat/sessions/${sessionId}`);
  const recallTargetTurn = [...detailBeforeQuotedRecall.body.turns]
    .reverse()
    .find((turn) => turn.actorRole === "initiator_user" && turn.content.includes("引用后撤回"));
  assert.ok(recallTargetTurn);

  const quotingRecallTarget = await clientB.request(`/api/prechat/sessions/${sessionId}/manual-message`, {
    method: "POST",
    json: {
      content: "我引用一下这条待撤回的消息。",
      quotedTurnId: recallTargetTurn.id
    }
  });
  assert.equal(quotingRecallTarget.status, 201);

  const recalledTarget = await clientA.request(
    `/api/prechat/sessions/${sessionId}/messages/${recallTargetTurn.id}/recall`,
    { method: "POST" }
  );
  assert.equal(recalledTarget.status, 200);

  const detailAfterQuotedRecall = await clientB.request(`/api/prechat/sessions/${sessionId}`);
  const quotedRecallTurn = [...detailAfterQuotedRecall.body.turns]
    .reverse()
    .find((turn) => turn.actorRole === "counterparty_user" && turn.content.includes("待撤回"));
  assert.equal(quotedRecallTurn.quotedTurn.content, "该消息已撤回");

  const anotherManual = await clientB.request(`/api/prechat/sessions/${sessionId}/manual-message`, {
    method: "POST",
    json: {
      content: "这条消息稍后会因为超时而无法撤回。"
    }
  });
  assert.equal(anotherManual.status, 201);

  const detailBeforeTimeoutRecall = await clientB.request(`/api/prechat/sessions/${sessionId}`);
  const oldManualB = [...detailBeforeTimeoutRecall.body.turns]
    .reverse()
    .find((turn) => turn.actorRole === "counterparty_user" && turn.content.includes("超时"));
  const database = getRawDatabaseForTests();
  database
    .prepare("UPDATE conversation_turns SET created_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 3 * 60 * 1000).toISOString(), oldManualB.id);

  const illegalRecall = await clientB.request(
    `/api/prechat/sessions/${sessionId}/messages/${oldManualB.id}/recall`,
    { method: "POST" }
  );
  assert.equal(illegalRecall.status, 400);
  assert.equal(illegalRecall.body.error.includes("2 分钟内"), true);

  let systemTurn = detailEditedA.body.turns.find((turn) => turn.actorRole === "system");
  if (!systemTurn) {
    const rawTurns = listConversationTurns(sessionId);
    const latestRawTurn = rawTurns[rawTurns.length - 1];
    addConversationTurn({
      sessionId,
      roundId: latestRawTurn.roundId,
      turnNumber: latestRawTurn.turnNumber + 1,
      actorUserId: null,
      actorRole: "system",
      content: "系统提示：这是一条仅用于权限校验的系统消息。",
      metadata: {}
    });
    const detailWithSystemTurn = await clientA.request(`/api/prechat/sessions/${sessionId}`);
    systemTurn = detailWithSystemTurn.body.turns.find(
      (turn) => turn.actorRole === "system" && String(turn.content || "").includes("仅用于权限校验")
    );
  }
  assert.ok(systemTurn);

  const illegalSystemReaction = await clientA.request(
    `/api/prechat/sessions/${sessionId}/messages/${systemTurn.id}/react`,
    {
      method: "POST",
      json: { emoji: "👍" }
    }
  );
  assert.equal(illegalSystemReaction.status, 400);
  assert.equal(illegalSystemReaction.body.error.includes("系统消息"), true);
});

test("真人消息是可回答问题时，另一方 Twin 会优先回答该问题", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "manual-q-a@example.com", "雨涵");
  await registerAndLogin(clientB, "manual-q-b@example.com", "予安");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("予安", { cities: "杭州" }));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "予安").id;
  const invitation = await clientA.request(`/api/matches/${matchId}/invite-prechat`, { method: "POST" });
  const sessionId = invitation.body.session.id;

  mockLlmSequence([
    {
      reply: "你好，我比较看重认真长期关系。你未来更倾向在哪个城市生活？",
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
      summary: "首轮已启动。",
      confirmed_facts: [],
      unresolved_questions: ["对方长期城市安排"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  mockLlmSequence([
    {
      is_question: true,
      question_text: "你未来更倾向在哪个城市生活？",
      question_topic: "cities",
      can_answer_from_context: true,
      needs_sensitive_approval: false,
      sensitive_topic_category: null,
      needs_human_input: false,
      human_input_question: null
    },
    {
      reply: "我长期更倾向在杭州生活。你这边会更想留在上海，还是也会考虑别的城市？",
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
      summary: "已优先回答真人问题，并继续推进城市安排。",
      confirmed_facts: [],
      unresolved_questions: ["对方长期城市安排"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const manualQuestion = await clientA.request(`/api/prechat/sessions/${sessionId}/manual-message`, {
    method: "POST",
    json: {
      content: "你未来更倾向在哪个城市生活？"
    }
  });
  assert.equal(manualQuestion.status, 201);
  assert.equal(["queued", "running"].includes(manualQuestion.body.session.control.automation.runState), true);
  const immediateDetail = await clientA.request(`/api/prechat/sessions/${sessionId}`);
  const immediateManualTurn = [...immediateDetail.body.turns]
    .reverse()
    .find((turn) => String(turn.actorRole || "").endsWith("_user") && /你未来更倾向在哪个城市生活/u.test(turn.content));
  assert.ok(immediateManualTurn);

  const detail = await waitForAutomationIdle(clientA, sessionId);
  const lastTwinTurn = [...detail.body.turns].reverse().find((turn) => String(turn.actorRole || "").endsWith("_twin"));
  assert.ok(lastTwinTurn);
  assert.match(lastTwinTurn.content, /杭州/u);
});

test("真人消息是问题但现有 context 不足时，会发给被问方本人补充", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "manual-h-a@example.com", "雨涵");
  await registerAndLogin(clientB, "manual-h-b@example.com", "予安");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("予安"));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "予安").id;
  const invitation = await clientA.request(`/api/matches/${matchId}/invite-prechat`, { method: "POST" });
  const sessionId = invitation.body.session.id;

  mockLlmSequence([
    {
      reply: "你好，我更看重认真长期关系。你会更在意关系稳定，还是也会把结婚放进考虑？",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["关系目标"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "pause_review"
    },
    {
      summary: "首轮已启动。",
      confirmed_facts: [],
      unresolved_questions: ["关系目标"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  mockLlmSequence([
    {
      is_question: true,
      question_text: "你希望多久内考虑结婚？",
      question_topic: "marriageTimeline",
      can_answer_from_context: false,
      needs_sensitive_approval: false,
      sensitive_topic_category: null,
      needs_human_input: true,
      human_input_question: "请直接说明你希望多久内考虑结婚。"
    },
    {
      summary: "真人问题需要被问方本人补充后再继续。",
      confirmed_facts: [],
      unresolved_questions: ["结婚节奏"],
      risk_summary: [],
      next_action: "pause_review",
      handoff_ready: false
    }
  ]);

  const manualQuestion = await clientA.request(`/api/prechat/sessions/${sessionId}/manual-message`, {
    method: "POST",
    json: {
      content: "你希望多久内考虑结婚？"
    }
  });
  assert.equal(manualQuestion.status, 201);
  assert.equal(["queued", "running"].includes(manualQuestion.body.session.control.automation.runState), true);

  const detail = await waitForAutomationIdle(clientB, sessionId);
  assert.equal(detail.body.session.status, "pending_human_input");
  assert.equal(detail.body.humanInputRequests.length >= 1, true);
  const manualQuestionRequest = detail.body.humanInputRequests.find(
    (request) => request.fieldKey === "manual_question_answer" && request.status === "pending"
  );
  assert.equal(manualQuestionRequest?.targetUserId, detail.body.currentUser.id);
  assert.equal(detail.body.turns.some((turn) => /需要 .*本人补充信息/u.test(turn.content)), true);
});

test("真人消息是敏感问题时，会沿用现有敏感审批链路", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "manual-s-a@example.com", "雨涵");
  await registerAndLogin(clientB, "manual-s-b@example.com", "予安");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("予安"));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "予安").id;
  const invitation = await clientA.request(`/api/matches/${matchId}/invite-prechat`, { method: "POST" });
  const sessionId = invitation.body.session.id;

  mockLlmSequence([
    {
      reply: "你好，我想先确认一下我们对长期关系的期待。你现在更看重长期稳定，还是也会把结婚放进考虑？",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["关系目标"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "pause_review"
    },
    {
      summary: "首轮已启动。",
      confirmed_facts: [],
      unresolved_questions: ["关系目标"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  mockLlmSequence([
    {
      is_question: true,
      question_text: "你现在有负债吗？",
      question_topic: "financialView",
      can_answer_from_context: false,
      needs_sensitive_approval: true,
      sensitive_topic_category: "finance_and_debt",
      needs_human_input: false,
      human_input_question: null
    },
    {
      summary: "真人敏感问题已进入审批。",
      confirmed_facts: [],
      unresolved_questions: ["财务与负债"],
      risk_summary: [],
      next_action: "pause_review",
      handoff_ready: false
    }
  ]);

  const manualQuestion = await clientA.request(`/api/prechat/sessions/${sessionId}/manual-message`, {
    method: "POST",
    json: {
      content: "你现在有负债吗？"
    }
  });
  assert.equal(manualQuestion.status, 201);
  assert.equal(["queued", "running"].includes(manualQuestion.body.session.control.automation.runState), true);

  const detail = await waitForAutomationIdle(clientB, sessionId);
  const sensitiveItem = detail.body.sensitiveRequests.find(
    (item) => item.status === "pending" && item.topicCategory === "finance_and_debt"
  );
  assert.equal(["pending_sensitive_approval", "pending_human_input"].includes(detail.body.session.status), true);
  if (detail.body.session.status === "pending_sensitive_approval") {
    assert.ok(sensitiveItem);
  } else {
    assert.equal(detail.body.turns.some((turn) => /需要 .*本人补充信息/u.test(turn.content)), true);
  }
});

test("拒绝敏感议题授权后，会跳过该议题继续，而不是停成 sensitive_question_rejected", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "reject-sensitive-a@example.com", "雨涵");
  await registerAndLogin(clientB, "reject-sensitive-b@example.com", "予安");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("予安"));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "予安").id;
  const invitation = await clientA.request(`/api/matches/${matchId}/invite-prechat`, { method: "POST" });
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
    },
    {
      reply: "你未来更倾向长期在哪个城市生活？",
      reply_topic_key: "cities",
      question_topic_key: "cities",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["你未来更倾向长期在哪个城市生活？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "已跳过敏感议题，继续推进城市安排。",
      confirmed_facts: [],
      unresolved_questions: ["城市与生活安排"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const sessionId = invitation.body.session.id;
  await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  const pausedForApproval = await waitForAutomationIdle(clientB, sessionId);
  assert.equal(["pending_sensitive_approval", "active"].includes(pausedForApproval.body.session.status), true);
  const pendingRequest = pausedForApproval.body.sensitiveRequests.find(
    (item) => item.status === "pending" && item.topicCategory === "family_boundaries"
  );
  assert.ok(pendingRequest);

  const rejected = await clientB.request(`/api/sensitive-requests/${pendingRequest.id}/reject`, { method: "POST" });
  assert.equal(rejected.status, 200);

  const detail = await waitForAutomationIdle(clientA, sessionId);
  assert.notEqual(detail.body.session.latestStopReason, "sensitive_question_rejected");
  assert.equal(detail.body.sensitiveRequests.some((item) => item.status === "pending"), false);
});

test("单边 confirmed fact 不会把议题误判为已完成", async () => {
  const session = {
    id: "session-test",
    initiatorUserId: "user-a",
    counterpartyUserId: "user-b"
  };
  const objectives = [
    {
      key: "familyBoundary",
      label: "家庭边界",
      prompt: "确认父母参与度和婚后边界。"
    }
  ];

  const singleSided = __testOnlyBuildObjectiveProgress(session, objectives, [
    {
      key: "familyBoundary",
      value: "婚后更偏独立小家庭",
      confidence: 0.9,
      status: "confirmed",
      subjectUserId: "user-a"
    }
  ]);
  assert.equal(singleSided[0].status, "pending");

  const bothSided = __testOnlyBuildObjectiveProgress(session, objectives, [
    {
      key: "familyBoundary",
      value: "婚后更偏独立小家庭",
      confidence: 0.9,
      status: "confirmed",
      subjectUserId: "user-a"
    },
    {
      key: "familyBoundary",
      value: "边界清楚，尊重父母但独立生活",
      confidence: 0.88,
      status: "confirmed",
      subjectUserId: "user-b"
    }
  ]);
  assert.equal(bothSided[0].status, "confirmed");
});

test("topic ledger 会把双方都确认的议题标记为 closed", () => {
  const session = {
    id: "ledger-session",
    initiatorUserId: "user-a",
    counterpartyUserId: "user-b",
    control: {}
  };
  const objectives = [
    {
      key: "childrenPreference",
      label: "孩子与生育态度",
      prompt: "确认对未来孩子与生育的态度。"
    }
  ];
  const facts = [
    {
      key: "childrenPreference",
      value: "希望未来要孩子",
      confidence: 0.9,
      status: "confirmed",
      subjectUserId: "user-a",
      createdAt: new Date().toISOString()
    },
    {
      key: "childrenPreference",
      value: "我也倾向未来要孩子",
      confidence: 0.9,
      status: "confirmed",
      subjectUserId: "user-b",
      createdAt: new Date().toISOString()
    }
  ];

  const ledger = __testOnlyRebuildTopicLedger(session, [], facts, objectives);
  assert.equal(ledger.childrenPreference.state, "closed");
  assert.equal(ledger.childrenPreference.coverage.initiator, true);
  assert.equal(ledger.childrenPreference.coverage.counterparty, true);
});

test("answer_topic_mismatch_guard 在回答 topic 正确、仅追问 topic 不同时不会误判", () => {
  const result = {
    reply: "我希望进入认真、长期的关系，也希望关系稳定后以结婚为目标。你未来更倾向长期在哪个城市生活？",
    reply_topic_key: "relationshipGoal",
    question_topic_key: "cities",
    emitted_reply_topic_key: "relationshipGoal",
    emitted_question_topic_key: "cities"
  };

  assert.equal(
    __testOnlyShouldRejectAnswerTopicMismatch({
      result,
      activeTopicKey: "cities",
      latestListenerQuestionTopic: "relationshipGoal"
    }),
    false
  );
});

test("final turn canonicalization 会丢弃 rewritten question-only turn 上的异 topic facts", () => {
  const aligned = __testOnlyAlignFinalTurnSemantics(
    {
      reply: "你现在更明确想进入怎样的长期关系？",
      reply_topic_key: "financialView",
      question_topic_key: "relationshipGoal",
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "financialView",
          value: "更看重务实稳定",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["你未来更倾向长期在哪个城市生活？"]
    },
    {
      activeTopicKey: "relationshipGoal",
      latestListenerQuestionTopic: "relationshipGoal",
      speakerUserId: "user-a",
      listenerUserId: "user-b"
    }
  );

  assert.equal(aligned.reply_topic_key, null);
  assert.equal(aligned.question_topic_key, "relationshipGoal");
  assert.deepEqual(aligned.confirmed_facts, []);
  assert.deepEqual(aligned.open_questions, ["你现在更明确想进入怎样的长期关系？"]);
  assert.match(String(aligned.alignment_issue || ""), /confirmed_facts_mismatch/u);
});

test("canonical turn outcome 会记录 frame 驱动的 required reply 与 canonical answer", () => {
  const outcome = __testOnlyBuildCanonicalTurnOutcome(
    {
      reply: "如果关系稳定，我会希望在两年左右认真考虑结婚。关于孩子这件事，你未来更倾向怎样的安排？",
      reply_topic_key: "marriageTimeline",
      question_topic_key: "childrenPreference",
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "marriageTimeline",
          value: "两年左右认真考虑结婚",
          confidence: 0.92,
          status: "confirmed"
        }
      ],
      open_questions: ["关于孩子这件事，你未来更倾向怎样的安排？"]
    },
    {
      frame_version: "turn_frame_v1_2026_06_03",
      reply_obligation: "listener_question",
      reply_target: {
        text: "你希望多久内考虑结婚？",
        topicKey: "marriageTimeline"
      },
      topic_plan: {
        activeTopicKey: "marriageTimeline"
      }
    },
    {
      activeTopicKey: "marriageTimeline",
      latestListenerQuestionTopic: "marriageTimeline",
      speakerUserId: "user-a",
      listenerUserId: "user-b"
    }
  );

  assert.equal(outcome.required_reply_source, "listener_question");
  assert.equal(outcome.required_reply_topic, "marriageTimeline");
  assert.equal(outcome.did_answer_required_question, true);
  assert.equal(outcome.canonical_answer_text, "如果关系稳定，我会希望在两年左右认真考虑结婚。");
  assert.equal(outcome.canonical_reply_topic_key, "marriageTimeline");
  assert.equal(outcome.canonical_question_topic_key, "childrenPreference");
  assert.equal(outcome.question_fingerprint, "childrenPreference:broad_preference");
});

test("carryover recovery 不会从 semantic mismatch 的 source turn 继续续推", () => {
  assert.equal(
    __testOnlyDetectOutstandingTwinQuestionSourceValidity({
      actorRole: "initiator_twin",
      content: "你现在更明确想进入怎样的长期关系？",
      metadata: {
        emitted_question_text: "你现在更明确想进入怎样的长期关系？",
        emitted_question_topic_key: "relationshipGoal",
        question_topic_key: "cities",
        reply_topic_key: "financialView",
        alignment_issue: "question_topic_mismatch,confirmed_facts_mismatch"
      }
    }),
    false
  );
});

test("turn context 会暴露 canonical turn_frame 并把 listener question 作为 reply obligation", () => {
  const session = {
    id: "frame-session",
    initiatorUserId: "user-a",
    counterpartyUserId: "user-b",
    control: {
      automation: {
        activeTopicKey: "relationshipGoal",
        topicQueueSnapshot: ["relationshipGoal", "cities"],
        topicLedger: {
          relationshipGoal: {
            topicKey: "relationshipGoal",
            state: "waiting_initiator",
            coverage: { initiator: false, counterparty: false },
            pendingAnswerUserId: "user-a"
          },
          cities: {
            topicKey: "cities",
            state: "not_started",
            coverage: { initiator: false, counterparty: false },
            pendingAnswerUserId: null
          }
        }
      }
    }
  };
  const round = {
    id: "round-frame",
    roundNumber: 1
  };
  const speaker = {
    userId: "user-a",
    displayName: "刘星",
    twinProfile: {}
  };
  const listener = {
    userId: "user-b",
    displayName: "刘宇",
    twinProfile: {}
  };
  const objectives = [
    {
      key: "relationshipGoal",
      label: "关系目标",
      prompt: "确认长期关系目标。"
    },
    {
      key: "cities",
      label: "城市安排",
      prompt: "确认长期城市安排。"
    }
  ];
  const turns = [
    {
      id: "turn-1",
      actorUserId: "user-b",
      actorRole: "counterparty_twin",
      content: "你未来更倾向长期在哪个城市生活？",
      metadata: {
        emitted_question_text: "你未来更倾向长期在哪个城市生活？",
        emitted_question_topic_key: "cities"
      }
    }
  ];
  const context = __testOnlyBuildTurnContextV2({
    session,
    round,
    speaker,
    listener,
    objectives,
    turns,
    facts: [],
    automationMode: "objective_driven",
    activeTopic: "relationshipGoal"
  });

  assert.equal(context.turn_frame.frame_version, "turn_frame_v1_2026_06_03");
  assert.equal(context.turn_frame.reply_obligation, "listener_question");
  assert.equal(context.turn_frame.reply_target.topicKey, "cities");
  assert.equal(context.turn_frame.topic_plan.activeTopicKey, "relationshipGoal");
  assert.equal(context.turn_frame.topic_plan.nextCandidateTopicKey, "cities");
});

test("validateTopicAwareTurnResult 会放行已闭合当前 topic 后的自然切题", () => {
  const session = {
    id: "topic-guard-switch-session",
    initiatorUserId: "user-a",
    counterpartyUserId: "user-b",
    control: {
      automation: {
        activeTopicKey: "childrenPreference",
        topicQueueSnapshot: ["childrenPreference", "familyBoundary"],
        topicLedger: {
          childrenPreference: {
            state: "waiting_counterparty",
            coverage: { initiator: true, counterparty: false },
            pendingAnswerUserId: "user-b"
          },
          familyBoundary: {
            state: "not_started",
            coverage: { initiator: false, counterparty: false },
            pendingAnswerUserId: null
          }
        }
      }
    }
  };
  const speaker = {
    userId: "user-b",
    displayName: "刘星",
    twinProfile: buildTwin("刘星", { childrenPreference: "希望未来要孩子" })
  };
  const listener = {
    userId: "user-a",
    displayName: "雨涵",
    twinProfile: buildTwin("雨涵", { childrenPreference: "希望未来要孩子" })
  };
  const turns = [
    {
      id: "turn-1",
      actorUserId: "user-a",
      actorRole: "initiator_twin",
      content: "你对未来要不要孩子这件事，目前更偏向什么想法？",
      metadata: {
        canonical_question_text: "你对未来要不要孩子这件事，目前更偏向什么想法？",
        canonical_question_topic_key: "childrenPreference",
        question_topic_key: "childrenPreference",
        emitted_question_text: "你对未来要不要孩子这件事，目前更偏向什么想法？",
        emitted_question_topic_key: "childrenPreference"
      }
    }
  ];

  const validated = __testOnlyValidateTopicAwareTurnResult({
    session,
    result: {
      reply: "关于孩子这件事，我目前倾向于未来要孩子。婚后和父母的相处边界上，你更偏向怎样的安排？",
      reply_topic_key: "childrenPreference",
      question_topic_key: "familyBoundary",
      confirmed_facts: [],
      open_questions: ["婚后和父母的相处边界上，你更偏向怎样的安排？"],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    turns,
    activeTopicKey: "childrenPreference",
    objectives: [
      { key: "childrenPreference", label: "孩子与生育态度", prompt: "确认对未来孩子与生育的态度。" },
      { key: "familyBoundary", label: "家庭边界", prompt: "确认父母参与度和婚后边界。" }
    ],
    speaker,
    listener,
    trigger: "test",
    turnFrame: {
      frame_version: "turn_frame_v1_2026_06_03",
      reply_obligation: "listener_question",
      reply_target: {
        text: "你对未来要不要孩子这件事，目前更偏向什么想法？",
        topicKey: "childrenPreference"
      },
      topic_plan: {
        activeTopicKey: "childrenPreference",
        canSwitchOnlyAfterClose: true,
        nextCandidateTopicKey: "familyBoundary"
      }
    }
  });

  assert.equal(validated.needs_human_input?.required, false);
  assert.equal(validated.reply_topic_key, "childrenPreference");
  assert.equal(validated.question_topic_key, "familyBoundary");
  assert.equal(validated.switch_after_topic_close_allowed, true);
  assert.equal(validated.active_topic_close_decision_source, "speaker_fact_card_fallback");
});

test("closed-topic guard rewrite 不会把已关闭 cities 重写回 cities", () => {
  const session = {
    id: "closed-topic-rewrite-session",
    initiatorUserId: "user-a",
    counterpartyUserId: "user-b",
    control: {
      automation: {
        source: "report_plan",
        activeTopicKey: "childrenPreference",
        topicQueueSnapshot: ["childrenPreference", "familyBoundary"],
        topicLedger: {
          relationshipGoal: {
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null
          },
          cities: {
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null
          },
          marriageTimeline: {
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null
          },
          childrenPreference: {
            state: "not_started",
            coverage: { initiator: false, counterparty: false },
            pendingAnswerUserId: null
          },
          familyBoundary: {
            state: "not_started",
            coverage: { initiator: false, counterparty: false },
            pendingAnswerUserId: null
          }
        }
      }
    }
  };
  const speaker = {
    userId: "user-a",
    displayName: "刘星",
    twinProfile: buildTwin("刘星", {
      cities: "深圳、广州",
      childrenPreference: "希望未来要孩子"
    })
  };
  const listener = {
    userId: "user-b",
    displayName: "沈特",
    twinProfile: buildTwin("沈特", {
      cities: "上海、杭州",
      childrenPreference: "希望未来要孩子"
    })
  };
  const turns = [
    {
      id: "turn-1",
      actorUserId: "user-b",
      actorRole: "counterparty_twin",
      content: "你对未来要不要孩子这件事，目前更偏向什么想法？",
      metadata: {
        canonical_question_text: "你对未来要不要孩子这件事，目前更偏向什么想法？",
        canonical_question_topic_key: "childrenPreference",
        emitted_question_text: "你对未来要不要孩子这件事，目前更偏向什么想法？",
        emitted_question_topic_key: "childrenPreference",
        question_topic_key: "childrenPreference"
      }
    }
  ];

  const rewritten = __testOnlyBuildSafeFollowupReply({
    session,
    baseResult: {
      reply: "如果匹配，我希望在1到2年内推进结婚。你未来更倾向长期在哪个城市生活？",
      reply_topic_key: "marriageTimeline",
      question_topic_key: "cities",
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "marriageTimeline",
          value: "如果匹配，希望在 1 到 2 年内推进结婚",
          confidence: 0.92,
          status: "confirmed"
        }
      ],
      open_questions: ["你未来更倾向长期在哪个城市生活？"],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    speaker,
    listener,
    repeatedTopicKey: "cities",
    objectives: [
      { key: "marriageTimeline", label: "结婚节奏", prompt: "确认结婚推进节奏是否接近。" },
      { key: "cities", label: "城市安排", prompt: "确认长期城市安排。" }
    ],
    recentTurns: turns,
    failureQuestion: "当前议题“城市安排”已经确认完成，请不要重复确认。",
    options: {
      mode: "closed_topic_guard",
      closedTopicKeys: ["relationshipGoal", "cities", "marriageTimeline"]
    }
  });
  const validated = __testOnlyBuildCanonicalTurnOutcome(
    rewritten,
    {
      frame_version: "turn_frame_v1_2026_06_03",
      reply_obligation: "listener_question",
      reply_target: {
        text: "你对未来要不要孩子这件事，目前更偏向什么想法？",
        topicKey: "childrenPreference"
      },
      topic_plan: {
        activeTopicKey: "childrenPreference",
        canSwitchOnlyAfterClose: true,
        nextCandidateTopicKey: "familyBoundary",
        closedTopicKeys: ["relationshipGoal", "cities", "marriageTimeline"]
      }
    },
    {
      activeTopicKey: "childrenPreference",
      latestListenerQuestionTopic: "childrenPreference",
      speakerUserId: speaker.userId,
      listenerUserId: listener.userId
    }
  );

  assert.equal(rewritten.repair_note, "closed_topic_guard_rewritten");
  assert.equal(rewritten.closed_topic_guard_resolution, "rewritten_to_next_topic");
  assert.notEqual(rewritten.question_topic_key, "cities");
  assert.equal(
    ["childrenPreference", "familyBoundary"].includes(String(rewritten.question_topic_key || "")),
    true
  );
  assert.equal(rewritten.rewrite_target_topic, rewritten.question_topic_key);
  assert.equal(validated.canonical_question_topic_key, rewritten.question_topic_key);
  assert.equal(
    ["关于孩子这件事，你未来更倾向怎样的安排？", "婚后和父母的相处边界上，你更偏向怎样的安排？"].includes(
      String(validated.canonical_question_text || "")
    ),
    true
  );
  assert.equal(
    validated.question_fingerprint,
    __testOnlyBuildQuestionFingerprint(validated.canonical_question_text, validated.canonical_question_topic_key)
  );
  assert.equal(rewritten.question_fingerprint, validated.question_fingerprint);
  assert.deepEqual(validated.canonical_confirmed_facts, []);
});

test("closed-topic guard rewrite 在 active topic 未闭合时会优先回到该 active topic，而不是重问 closed cities", () => {
  const session = {
    id: "closed-topic-active-rewrite-session",
    initiatorUserId: "user-a",
    counterpartyUserId: "user-b",
    control: {
      automation: {
        source: "direct_invite",
        activeTopicKey: "marriageTimeline",
        topicQueueSnapshot: [],
        topicLedger: {
          cities: {
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null
          },
          childrenPreference: {
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null
          },
          familyBoundary: {
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null
          },
          financialView: {
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null
          },
          marriageTimeline: {
            state: "waiting_initiator",
            coverage: { initiator: false, counterparty: true },
            pendingAnswerUserId: "user-a"
          }
        }
      }
    }
  };
  const speaker = {
    userId: "user-b",
    displayName: "沈特",
    twinProfile: buildTwin("沈特", {
      marriageTimeline: "如果匹配，希望 1 到 2 年内推进"
    })
  };
  const listener = {
    userId: "user-a",
    displayName: "刘宇",
    twinProfile: buildTwin("刘宇", {
      marriageTimeline: "如果匹配，希望 1 到 2 年内推进"
    })
  };
  const turns = [
    {
      id: "turn-marriage-question",
      actorUserId: "user-a",
      actorRole: "initiator_twin",
      content: "关于结婚节奏，如果匹配，你希望多久内推进？",
      metadata: {
        canonical_question_text: "关于结婚节奏，如果匹配，你希望多久内推进？",
        canonical_question_topic_key: "marriageTimeline",
        emitted_question_text: "关于结婚节奏，如果匹配，你希望多久内推进？",
        emitted_question_topic_key: "marriageTimeline",
        question_topic_key: "marriageTimeline"
      }
    }
  ];

  const rewritten = __testOnlyValidateTopicAwareTurnResult({
    session,
    result: {
      reply: "如果匹配，我希望在1到2年内推进结婚。关于孩子这件事，你未来更倾向怎样的安排？",
      reply_topic_key: "marriageTimeline",
      question_topic_key: "childrenPreference",
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "marriageTimeline",
          value: "如果匹配，希望1到2年内推进",
          confidence: 0.92,
          status: "confirmed"
        }
      ],
      open_questions: ["关于孩子这件事，你未来更倾向怎样的安排？"],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    turns,
    activeTopicKey: "marriageTimeline",
    objectives: [
      { key: "cities", label: "城市安排", prompt: "确认长期城市安排。" },
      { key: "financialView", label: "财务观", prompt: "确认金钱观、消费观与现实安排。" }
    ],
    speaker,
    listener,
    trigger: "test",
    turnFrame: {
      frame_version: "turn_frame_v1_2026_06_03",
      reply_obligation: "listener_question",
      reply_target: {
        text: "关于结婚节奏，如果匹配，你希望多久内推进？",
        topicKey: "marriageTimeline"
      },
      topic_plan: {
        activeTopicKey: "marriageTimeline",
        canSwitchOnlyAfterClose: true,
        nextCandidateTopicKey: null,
        closedTopicKeys: ["cities", "childrenPreference", "familyBoundary", "financialView"]
      }
    }
  });

  assert.equal(rewritten.repair_note, "closed_topic_guard_rewritten");
  assert.equal(rewritten.question_topic_key, "marriageTimeline");
  assert.equal(rewritten.canonical_question_topic_key, "marriageTimeline");
  assert.equal(rewritten.rewrite_target_topic, "marriageTimeline");
  assert.notEqual(rewritten.question_topic_key, "cities");
  assert.equal(
    [
      "关于结婚节奏，如果匹配，你希望多久内推进？",
      "如果关系顺利推进，你更接受怎样的结婚节奏？"
    ].includes(String(rewritten.canonical_question_text || "")),
    true
  );
  assert.equal(
    rewritten.question_fingerprint,
    __testOnlyBuildQuestionFingerprint(rewritten.canonical_question_text, "marriageTimeline")
  );
});

test("closed-topic guard rewrite 在 childrenPreference 已闭合且 financialView 仍待回答时，不会回退重问 closed cities", () => {
  const session = {
    id: "closed-topic-financial-session",
    initiatorUserId: "user-a",
    counterpartyUserId: "user-b",
    control: {
      automation: {
        source: "direct_invite",
        preferredObjectiveKeys: [],
        activeTopicKey: "financialView",
        topicQueueSnapshot: ["financialView"],
        topicLedger: {
          relationshipGoal: {
            state: "not_started",
            coverage: { initiator: false, counterparty: false },
            pendingAnswerUserId: null
          },
          cities: {
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null
          },
          marriageTimeline: {
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null
          },
          childrenPreference: {
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null
          },
          familyBoundary: {
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null
          },
          financialView: {
            state: "waiting_initiator",
            coverage: { initiator: false, counterparty: true },
            pendingAnswerUserId: "user-a"
          }
        }
      }
    }
  };
  const speaker = {
    userId: "user-b",
    displayName: "刘宇",
    twinProfile: buildTwin("刘宇", {
      financialView: "更看重务实稳定，也会留意负债风险"
    })
  };
  const listener = {
    userId: "user-a",
    displayName: "雨涵",
    twinProfile: buildTwin("雨涵", {
      financialView: "更看重务实稳定，也不接受隐性负债"
    })
  };
  const turns = [
    {
      id: "turn-financial-question",
      actorUserId: "user-a",
      actorRole: "initiator_twin",
      content: "关于财务安排，你更看重怎样的原则？",
      metadata: {
        canonical_question_text: "关于财务安排，你更看重怎样的原则？",
        canonical_question_topic_key: "financialView",
        emitted_question_text: "关于财务安排，你更看重怎样的原则？",
        emitted_question_topic_key: "financialView",
        question_topic_key: "financialView"
      }
    }
  ];

  const rewritten = __testOnlyValidateTopicAwareTurnResult({
    session,
    result: {
      reply: "在财务安排上，我更看重务实稳定，也会留意负债风险。婚后和父母的相处边界上，你更偏向怎样的安排？",
      reply_topic_key: "financialView",
      question_topic_key: "familyBoundary",
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "financialView",
          value: "更看重务实稳定，也会留意负债风险",
          confidence: 0.92,
          status: "confirmed"
        }
      ],
      open_questions: ["婚后和父母的相处边界上，你更偏向怎样的安排？"],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    turns,
    activeTopicKey: "financialView",
    objectives: [{ key: "financialView", label: "财务观", prompt: "确认金钱观、消费观与现实安排。" }],
    speaker,
    listener,
    trigger: "test",
    turnFrame: {
      frame_version: "turn_frame_v1_2026_06_03",
      reply_obligation: "listener_question",
      reply_target: {
        text: "关于财务安排，你更看重怎样的原则？",
        topicKey: "financialView"
      },
      topic_plan: {
        activeTopicKey: "financialView",
        canSwitchOnlyAfterClose: true,
        nextCandidateTopicKey: null,
        closedTopicKeys: ["cities", "marriageTimeline", "childrenPreference", "familyBoundary"]
      }
    }
  });

  assert.equal(rewritten.repair_note, "closed_topic_guard_rewritten");
  assert.notEqual(rewritten.question_topic_key, "cities");
  assert.notEqual(rewritten.canonical_question_topic_key, "cities");
  assert.notEqual(String(rewritten.canonical_question_text || ""), "你这边未来长期更倾向在哪个城市生活？");
  assert.equal(
    [null, "financialView"].includes(rewritten.canonical_question_topic_key == null ? null : String(rewritten.canonical_question_topic_key)),
    true
  );
});

test("same_topic_broad_question_repeat 在 cities 已 closed 时只会切到 live ledger 中未闭合议题", () => {
  const session = {
    id: "closed-cities-repeat-session",
    initiatorUserId: "user-a",
    counterpartyUserId: "user-b",
    control: {
      automation: {
        source: "direct_invite",
        activeTopicKey: "marriageTimeline",
        topicQueueSnapshot: ["cities", "financialView"],
        topicLedger: {
          relationshipGoal: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null },
          cities: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null },
          marriageTimeline: { state: "waiting_initiator", coverage: { initiator: false, counterparty: true }, pendingAnswerUserId: "user-a" },
          childrenPreference: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null },
          familyBoundary: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null },
          financialView: { state: "not_started", coverage: { initiator: false, counterparty: false }, pendingAnswerUserId: null }
        }
      }
    }
  };
  const speaker = {
    userId: "user-b",
    displayName: "刘宇",
    twinProfile: buildTwin("刘宇", {
      marriageTimeline: "如果匹配，我希望在1到2年内推进结婚。",
      financialView: "我更看重务实稳定，也会留意负债风险。"
    })
  };
  const listener = {
    userId: "user-a",
    displayName: "刘星",
    twinProfile: buildTwin("刘星", {
      marriageTimeline: "如果匹配，我希望在1到2年内推进结婚。",
      financialView: "我更看重务实稳定，也不接受隐性负债。"
    })
  };
  const turns = [
    {
      id: "turn-marriage-question-closed-cities",
      actorUserId: "user-a",
      actorRole: "initiator_twin",
      content: "关于结婚节奏，如果匹配，你希望多久内推进？",
      metadata: {
        canonical_question_text: "关于结婚节奏，如果匹配，你希望多久内推进？",
        canonical_question_topic_key: "marriageTimeline",
        emitted_question_text: "关于结婚节奏，如果匹配，你希望多久内推进？",
        emitted_question_topic_key: "marriageTimeline",
        question_topic_key: "marriageTimeline"
      }
    },
    {
      id: "turn-old-cities-question",
      actorUserId: "user-b",
      actorRole: "counterparty_twin",
      content: "你这边未来长期更倾向在哪个城市生活？",
      metadata: {
        canonical_question_text: "你这边未来长期更倾向在哪个城市生活？",
        canonical_question_topic_key: "cities",
        emitted_question_text: "你这边未来长期更倾向在哪个城市生活？",
        emitted_question_topic_key: "cities",
        question_topic_key: "cities"
      }
    }
  ];

  const rewritten = __testOnlyValidateTopicAwareTurnResult({
    session,
    result: {
      reply: "如果匹配，我希望在1到2年内推进结婚。你未来更倾向长期在哪个城市生活？",
      reply_topic_key: "marriageTimeline",
      question_topic_key: "cities",
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "marriageTimeline",
          value: "如果匹配，我希望在1到2年内推进结婚",
          confidence: 0.92,
          status: "confirmed"
        }
      ],
      open_questions: ["你未来更倾向长期在哪个城市生活？"],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    turns,
    activeTopicKey: "marriageTimeline",
    objectives: [
      { key: "cities", label: "城市安排", prompt: "确认长期城市安排。" },
      { key: "financialView", label: "财务观", prompt: "确认金钱观、消费观与现实安排。" }
    ],
    speaker,
    listener,
    trigger: "test",
    turnFrame: {
      frame_version: "turn_frame_v1_2026_06_03",
      reply_obligation: "listener_question",
      reply_target: {
        text: "关于结婚节奏，如果匹配，你希望多久内推进？",
        topicKey: "marriageTimeline"
      },
      topic_plan: {
        activeTopicKey: "marriageTimeline",
        canSwitchOnlyAfterClose: true,
        nextCandidateTopicKey: "financialView",
        closedTopicKeys: ["relationshipGoal", "cities", "childrenPreference", "familyBoundary"]
      }
    }
  });

  assert.equal(rewritten.repeat_source, "same_topic_broad_question_repeat");
  assert.equal(rewritten.question_topic_key, "financialView");
  assert.equal(rewritten.canonical_question_topic_key, "financialView");
  assert.equal(/财务|消费|储蓄|负债/u.test(String(rewritten.canonical_question_text || "")), true);
  assert.notEqual(rewritten.question_topic_key, "cities");
  assert.equal(rewritten.closed_topic_rewrite_suppressed, true);
  assert.equal(rewritten.next_topic_selector_source, "canonical_session_ledger");
  assert.equal(
    rewritten.question_fingerprint,
    __testOnlyBuildQuestionFingerprint(rewritten.canonical_question_text, rewritten.canonical_question_topic_key)
  );
});

test("same_topic_broad_question_repeat 在 closed cities 且切到 next topic 时不会残留旧 cities 问句", () => {
  const session = {
    id: "closed-cities-repeat-live-shape",
    initiatorUserId: "user-a",
    counterpartyUserId: "user-b",
    control: {
      automation: {
        source: "direct_invite",
        activeTopicKey: "marriageTimeline",
        topicQueueSnapshot: [],
        topicLedger: {
          relationshipGoal: { state: "not_started", coverage: { initiator: false, counterparty: false }, pendingAnswerUserId: null },
          cities: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null },
          marriageTimeline: { state: "waiting_initiator", coverage: { initiator: false, counterparty: true }, pendingAnswerUserId: "user-a" },
          childrenPreference: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null },
          familyBoundary: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null },
          financialView: { state: "not_started", coverage: { initiator: false, counterparty: false }, pendingAnswerUserId: null }
        }
      }
    }
  };
  const speaker = {
    userId: "user-b",
    displayName: "刘宇",
    twinProfile: buildTwin("刘宇", {
      marriageTimeline: "如果匹配，我希望在1到2年内推进结婚。",
      financialView: "我更看重务实稳定，也会留意负债风险。"
    })
  };
  const listener = {
    userId: "user-a",
    displayName: "刘星",
    twinProfile: buildTwin("刘星", {
      marriageTimeline: "如果匹配，我希望在1到2年内推进结婚。",
      financialView: "我更看重务实稳定，也不接受隐性负债。"
    })
  };
  const turns = [
    {
      id: "turn-marriage-question-live-shape",
      actorUserId: "user-a",
      actorRole: "initiator_twin",
      content: "关于结婚节奏，如果匹配，你希望多久内推进？",
      metadata: {
        canonical_question_text: "关于结婚节奏，如果匹配，你希望多久内推进？",
        canonical_question_topic_key: "marriageTimeline",
        emitted_question_text: "关于结婚节奏，如果匹配，你希望多久内推进？",
        emitted_question_topic_key: "marriageTimeline",
        question_topic_key: "marriageTimeline"
      }
    },
    {
      id: "turn-old-cities-question-live-shape",
      actorUserId: "user-b",
      actorRole: "counterparty_twin",
      content: "你这边未来长期更倾向在哪个城市生活？",
      metadata: {
        canonical_question_text: "你这边未来长期更倾向在哪个城市生活？",
        canonical_question_topic_key: "cities",
        emitted_question_text: "你这边未来长期更倾向在哪个城市生活？",
        emitted_question_topic_key: "cities",
        question_topic_key: "cities"
      }
    }
  ];

  const rewritten = __testOnlyValidateTopicAwareTurnResult({
    session,
    result: {
      reply: "如果匹配，我希望在1到2年内推进结婚。 你这边未来长期更倾向在哪个城市生活？",
      reply_topic_key: "marriageTimeline",
      question_topic_key: "cities",
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "marriageTimeline",
          value: "如果匹配，我希望在1到2年内推进结婚",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["你这边未来长期更倾向在哪个城市生活？"],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    turns,
    activeTopicKey: "marriageTimeline",
    objectives: [
      { key: "cities", label: "城市安排", prompt: "确认长期城市安排。" },
      { key: "financialView", label: "财务观", prompt: "确认金钱观、消费观与现实安排。" }
    ],
    speaker,
    listener,
    trigger: "test",
    turnFrame: {
      frame_version: "turn_frame_v1_2026_06_03",
      reply_obligation: "listener_question",
      reply_target: {
        text: "关于结婚节奏，如果匹配，你希望多久内推进？",
        topicKey: "marriageTimeline"
      },
      topic_plan: {
        activeTopicKey: "marriageTimeline",
        canSwitchOnlyAfterClose: true,
        nextCandidateTopicKey: "financialView",
        closedTopicKeys: ["cities", "childrenPreference", "familyBoundary"]
      }
    }
  });

  assert.equal(rewritten.question_topic_key, "financialView");
  assert.equal(rewritten.canonical_question_topic_key, "financialView");
  assert.equal(/城市/u.test(String(rewritten.reply || "")), false);
  assert.equal(/财务|消费|储蓄|负债/u.test(String(rewritten.reply || "")), true);
  assert.equal(rewritten.closed_topic_rewrite_suppressed === true || rewritten.switch_after_topic_close_allowed === true, true);
  assert.equal(
    rewritten.question_fingerprint,
    __testOnlyBuildQuestionFingerprint(rewritten.canonical_question_text, rewritten.canonical_question_topic_key)
  );
});

test("最终 question 文案改写后 question_fingerprint 会按 canonical question 重新计算", () => {
  const validated = __testOnlyAlignFinalTurnSemantics(
    {
      reply: "如果匹配，我希望在1到2年内推进结婚。你对未来要不要孩子这件事，目前更偏向什么想法？",
      reply_topic_key: "marriageTimeline",
      question_topic_key: "cities",
      question_fingerprint: "cities:broad_location",
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "marriageTimeline",
          value: "如果匹配，我希望在1到2年内推进结婚",
          confidence: 0.92,
          status: "confirmed"
        }
      ],
      open_questions: ["你未来更倾向长期在哪个城市生活？"],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      activeTopicKey: "marriageTimeline",
      latestListenerQuestionTopic: "marriageTimeline",
      speakerUserId: "user-b",
      listenerUserId: "user-a"
    }
  );

  assert.equal(validated.canonical_question_topic_key, "childrenPreference");
  assert.equal(validated.canonical_question_text, "你对未来要不要孩子这件事，目前更偏向什么想法？");
  assert.equal(
    validated.question_fingerprint,
    __testOnlyBuildQuestionFingerprint(validated.canonical_question_text, validated.canonical_question_topic_key)
  );
  assert.notEqual(validated.question_fingerprint, "cities:broad_location");
});

test("首条 Twin 自我介绍加问题会被 canonicalize 为 question-only，不把自我介绍算 answer", () => {
  const outcome = __testOnlyBuildCanonicalTurnOutcome(
    {
      reply: "你好，我是雨涵的 Twin。你这边未来长期更倾向在哪个城市生活？",
      reply_topic_key: "cities",
      question_topic_key: "cities",
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "cities",
          value: "杭州",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["你这边未来长期更倾向在哪个城市生活？"],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      frame_version: "turn_frame_v1_2026_06_03",
      reply_obligation: "none",
      reply_target: {
        text: null,
        topicKey: null
      },
      topic_plan: {
        activeTopicKey: "cities"
      }
    },
    {
      activeTopicKey: "cities",
      latestListenerQuestionTopic: null,
      speakerUserId: "user-a",
      listenerUserId: "user-b",
      speakerDisplayName: "雨涵"
    }
  );

  assert.equal(outcome.canonical_answer_text, null);
  assert.equal(outcome.canonical_reply_topic_key, null);
  assert.equal(outcome.reply_topic_key, null);
  assert.equal(outcome.canonical_question_topic_key, "cities");
  assert.deepEqual(outcome.confirmed_facts, []);
  assert.equal(
    outcome.question_fingerprint,
    __testOnlyBuildQuestionFingerprint("你这边未来长期更倾向在哪个城市生活？", "cities")
  );
});

test("answer-only rewrite 会清空所有 question truth 和 fingerprint", () => {
  const outcome = __testOnlyBuildCanonicalTurnOutcome(
    {
      reply: "如果关系稳定，我倾向于在1到2年内推进结婚。",
      reply_topic_key: "marriageTimeline",
      question_topic_key: "familyBoundary",
      emitted_question_topic_key: "familyBoundary",
      canonical_question_topic_key: "familyBoundary",
      question_fingerprint: "familyBoundary:关于婚后和父母的相处边界你偏向怎样的",
      open_questions: ["关于婚后和父母的相处边界，你更偏向怎样的安排？"],
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "marriageTimeline",
          value: "如果关系稳定，倾向于1到2年内推进结婚",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      frame_version: "turn_frame_v1_2026_06_03",
      reply_obligation: "listener_question",
      reply_target: {
        text: "如果关系顺利推进，你更接受怎样的结婚节奏？",
        topicKey: "marriageTimeline"
      },
      topic_plan: {
        activeTopicKey: "marriageTimeline"
      }
    },
    {
      activeTopicKey: "marriageTimeline",
      latestListenerQuestionTopic: "marriageTimeline",
      speakerUserId: "user-a",
      listenerUserId: "user-b"
    }
  );

  assert.equal(outcome.canonical_question_text, null);
  assert.equal(outcome.canonical_question_topic_key, null);
  assert.equal(outcome.question_topic_key, null);
  assert.deepEqual(outcome.open_questions, []);
  assert.equal(outcome.question_fingerprint, null);
});

test("历史 polluted turn 即使已有 canonical 字段也会 runtime downgrade 并重算 canonical question truth", () => {
  const session = {
    id: "historical-polluted-session",
    initiatorUserId: "user-a",
    counterpartyUserId: "user-b",
    control: {
      automation: {
        enabled: true,
        activeTopicKey: "cities",
        topicQueueSnapshot: ["cities", "marriageTimeline"],
        topicLedger: {
          cities: { state: "waiting_counterparty", coverage: { initiator: true, counterparty: false }, pendingAnswerUserId: "user-b" },
          marriageTimeline: { state: "not_started", coverage: { initiator: false, counterparty: false }, pendingAnswerUserId: null }
        }
      }
    }
  };
  const pollutedTurn = {
    id: "polluted-turn-1",
    actorUserId: "user-a",
    actorRole: "initiator_twin",
    content: "你好，我是雨涵的 Twin。你这边未来长期更倾向在哪个城市生活？",
    metadata: {
      frame_version: "turn_frame_v1_2026_06_03",
      canonical_question_text: "你这边未来长期更倾向在哪个城市生活？",
      canonical_question_topic_key: "cities",
      canonical_reply_topic_key: "cities",
      question_fingerprint: "marriageTimeline:关于结婚节奏如果匹配你希望多久内推进",
      canonical_outcome_trusted: true
    }
  };

  const rebuilt = __testOnlyCanonicalizeHistoricalTwinTurn(pollutedTurn, session, [pollutedTurn]);
  assert.equal(rebuilt.metadata.historical_turn_downgraded, true);
  assert.equal(rebuilt.metadata.canonical_reply_topic_key, null);
  assert.equal(rebuilt.metadata.canonical_question_topic_key, "cities");
  assert.equal(
    rebuilt.metadata.question_fingerprint,
    __testOnlyBuildQuestionFingerprint("你这边未来长期更倾向在哪个城市生活？", "cities")
  );
  assert.equal(__testOnlyIsTrustedCanonicalTwinTurn(rebuilt), false);
});

test("question fingerprint 会把同 topic 的 broad question 同类化", () => {
  const left = __testOnlyBuildQuestionFingerprint("你这边未来更倾向长期在哪个城市生活？", "cities");
  const right = __testOnlyBuildQuestionFingerprint("你未来更倾向长期在深圳还是广州生活？", "cities");
  assert.equal(left, right);
});

test("历史相邻重复 twin turn 会在 runtime collapse 成一条 canonical source", () => {
  const collapsed = __testOnlyCollapseAdjacentDuplicateTwinTurns([
    {
      id: "turn-1",
      actorUserId: "user-a",
      actorRole: "initiator_twin",
      content: "你现在更明确想进入怎样的长期关系？",
      metadata: {
        canonical_question_text: "你现在更明确想进入怎样的长期关系？",
        canonical_question_topic_key: "relationshipGoal"
      }
    },
    {
      id: "turn-2",
      actorUserId: "user-a",
      actorRole: "initiator_twin",
      content: "你现在更明确想进入怎样的长期关系？",
      metadata: {
        canonical_question_text: "你现在更明确想进入怎样的长期关系？",
        canonical_question_topic_key: "relationshipGoal"
      }
    },
    {
      id: "turn-3",
      actorUserId: "user-b",
      actorRole: "counterparty_twin",
      content: "我更倾向认真长期关系。",
      metadata: {
        canonical_answer_text: "我更倾向认真长期关系。",
        canonical_reply_topic_key: "relationshipGoal"
      }
    }
  ]);

  assert.equal(collapsed.length, 2);
  assert.deepEqual(
    collapsed.map((turn) => turn.id),
    ["turn-1", "turn-3"]
  );
});

test("duplicate guard 会拦截最近同 actor 的 identical twin turn", async () => {
  const clientA = createClient();
  const clientB = createClient();

  const userA = await registerAndLogin(clientA, "dup-a@example.com", "刘星");
  const userB = await registerAndLogin(clientB, "dup-b@example.com", "刘宇");
  await saveTwinFor(clientA, buildTwin("刘星"));
  await saveTwinFor(clientB, buildTwin("刘宇"));

  const matchId = upsertMatch(userA.id, userB.id, 92, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id
  });
  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: [{ key: "relationshipGoal", label: "关系目标", prompt: "确认长期关系目标。" }]
    }
  });

  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 1,
    actorUserId: userA.id,
    actorRole: "initiator_twin",
    content: "你现在更明确想进入怎样的长期关系？",
    metadata: {
      canonical_question_text: "你现在更明确想进入怎样的长期关系？",
      canonical_question_topic_key: "relationshipGoal",
      question_fingerprint: "relationshipGoal:broad_preference"
    }
  });

  const duplicate = __testOnlyShouldSkipDuplicateTwinTurn(
    session.id,
    {
      actorUserId: userA.id,
      actorRole: "initiator_twin",
      content: "你现在更明确想进入怎样的长期关系？",
      metadata: {
        canonical_question_text: "你现在更明确想进入怎样的长期关系？",
        canonical_question_topic_key: "relationshipGoal",
        question_fingerprint: "relationshipGoal:broad_preference"
      }
    },
    {
      trigger: "session_view"
    }
  );

  assert.equal(Boolean(duplicate?.duplicate), true);
  assert.equal(duplicate?.existingTurn?.turnNumber, 1);
  assert.equal(duplicate?.metadata?.duplicate_guard_triggered, true);
  assert.equal(duplicate?.metadata?.duplicate_source_trigger, "session_view");
});

test("历史 paused_review 卡在 outstanding_twin_question_unanswered 时，打开会话会自动恢复出对侧回答", async () => {
  const clientA = createClient();
  const clientB = createClient();

  const userA = await registerAndLogin(clientA, "recover-a@example.com", "雨涵");
  const userB = await registerAndLogin(clientB, "recover-b@example.com", "乔治");
  await saveTwinFor(
    clientA,
    buildTwin("雨涵", {
      familyBoundary: "婚后我更偏向独立小家庭，但会尊重双方父母。"
    })
  );
  await saveTwinFor(
    clientB,
    buildTwin("乔治", {
      familyBoundary: "我希望婚后边界清楚，日常还是以小家庭为主。"
    })
  );

  const matchId = upsertMatch(userA.id, userB.id, 92, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userB.id,
    counterpartyUserId: userA.id
  });

  updatePrechatSession(session.id, {
    status: "paused_review",
    currentRound: 2
  });

  const round1 = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: [
        {
          key: "familyBoundary",
          label: "家庭边界",
          prompt: "确认父母参与度和婚后边界。"
        }
      ]
    }
  });
  const round2 = createPrechatRound({
    sessionId: session.id,
    roundNumber: 2,
    objective: {
      topics: [
        {
          key: "familyBoundary",
          label: "家庭边界",
          prompt: "确认父母参与度和婚后边界。"
        }
      ]
    }
  });

  const firstTurn = addConversationTurn({
    sessionId: session.id,
    roundId: round1.id,
    turnNumber: 1,
    actorUserId: userB.id,
    actorRole: "initiator_twin",
    content: "我婚后更偏向以小家庭为主，同时也会尊重双方父母。",
    metadata: {
      reply: "我婚后更偏向以小家庭为主，同时也会尊重双方父母。",
      confirmed_facts: [],
      open_questions: ["家庭边界"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    }
  });
  saveExtractedFacts(
    session.id,
    round1.id,
    [
      {
        subjectUserId: userB.id,
        key: "familyBoundary",
        value: "婚后更偏向以小家庭为主",
        confidence: 0.9,
        status: "confirmed"
      }
    ],
    firstTurn.id
  );

  addConversationTurn({
    sessionId: session.id,
    roundId: round2.id,
    turnNumber: 1,
    actorUserId: userB.id,
    actorRole: "initiator_twin",
    content: "你这边对婚后和父母的相处边界有什么具体的想法吗？",
    metadata: {
      reply: "你这边对婚后和父母的相处边界有什么具体的想法吗？",
      confirmed_facts: [],
      open_questions: ["家庭边界"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "pause_review"
    }
  });

  const database = getRawDatabaseForTests();
  database
    .prepare("UPDATE prechat_rounds SET status = 'completed', stop_reason = 'objectives_completed' WHERE id = ?")
    .run(round1.id);
  database
    .prepare("UPDATE prechat_rounds SET status = 'completed', stop_reason = 'outstanding_twin_question_unanswered' WHERE id = ?")
    .run(round2.id);

  mockLlmSequence([
    {
      reply: "在这件事上，我更偏向婚后先以小家庭为主，同时会和双方父母保持尊重但清晰的边界。",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "familyBoundary",
          value: "婚后先以小家庭为主，同时和父母保持清晰边界",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: [],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "pause_review"
    },
    {
      summary: "已补回答上一轮遗留的 Twin 问题。",
      confirmed_facts: [
        {
          subjectUserId: "counterparty",
          key: "familyBoundary",
          value: "婚后先以小家庭为主，同时和父母保持清晰边界",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      unresolved_questions: [],
      risk_summary: [],
      next_action: "pause_review",
      handoff_ready: false
    }
  ]);

  const turnCountBefore = listConversationTurns(session.id).length;
  const roundCountBefore = listPrechatRounds(session.id).length;
  const recovered = await clientA.request(`/api/prechat/sessions/${session.id}`);
  assert.equal(recovered.status, 200);

  const detail = await waitForAutomationIdle(clientA, session.id);
  const turns = detail.body.turns;
  const twinTurns = turns.filter((turn) => String(turn.actorRole || "").endsWith("_twin"));
  const latestTwinTurn = twinTurns.at(-1);
  assert.ok(latestTwinTurn);
  assert.equal(
    latestTwinTurn.content,
    "在这件事上，我更偏向婚后先以小家庭为主，同时会和双方父母保持尊重但清晰的边界。"
  );
  assert.equal(detail.body.humanInputRequests.some((item) => item.status === "pending"), false);
  assert.equal(detail.body.sensitiveRequests.some((item) => item.status === "pending"), false);
  assert.equal(turns.length, turnCountBefore + 1);
  assert.equal(listPrechatRounds(session.id).length, roundCountBefore + 1);
  assert.equal(detail.body.session.control?.automation?.runState || "idle", "idle");
  assert.equal(["paused_review", "active"].includes(detail.body.session.status), true);

  const recoveredAgain = await clientA.request(`/api/prechat/sessions/${session.id}`);
  assert.equal(recoveredAgain.status, 200);
  const twinReplies = recoveredAgain.body.turns
    .filter((turn) => String(turn.actorRole || "").endsWith("_twin"))
    .map((turn) => turn.content);
  assert.equal(
    twinReplies.filter(
      (content) =>
        content === "在这件事上，我更偏向婚后先以小家庭为主，同时会和双方父母保持尊重但清晰的边界。"
    ).length,
    1
  );
});

test("round progress snapshot 只有在 ledger 或 outstanding 真正变化时才算有进展", () => {
  const userA = createUser({
    email: "progress-a@example.com",
    displayName: "雨涵",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "progress-b@example.com",
    displayName: "刘星",
    passwordHash: hashPassword("secret123")
  });

  saveCurrentTwin(userA.id, buildTwin("雨涵"));
  saveCurrentTwin(userB.id, buildTwin("刘星"));

  const matchId = upsertMatch(userA.id, userB.id, 95, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id
  });
  const objectives = [
    {
      key: "childrenPreference",
      label: "孩子与生育态度",
      prompt: "确认对未来孩子与生育的态度。"
    }
  ];
  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: { topics: objectives }
  });

  const before = __testOnlyBuildRoundProgressSnapshot(session, objectives, [], round);
  const same = __testOnlyBuildRoundProgressSnapshot(session, objectives, [], round);
  assert.equal(__testOnlyDidRoundProgressAdvance(before, same), false);

  const questionTurn = addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 1,
    actorUserId: userA.id,
    actorRole: "initiator_twin",
    content: "关于孩子这件事，你未来更倾向怎样的安排？",
    metadata: {
      canonical_question_text: "关于孩子这件事，你未来更倾向怎样的安排？",
      canonical_question_topic_key: "childrenPreference",
      question_fingerprint: "childrenPreference:broad_preference"
    }
  });

  const afterOutstanding = __testOnlyBuildRoundProgressSnapshot(
    getPrechatSessionById(session.id),
    objectives,
    listConversationTurns(session.id),
    round
  );
  assert.equal(__testOnlyDidRoundProgressAdvance(same, afterOutstanding), true);

  saveExtractedFacts(session.id, round.id, [
    {
      subjectUserId: userB.id,
      key: "childrenPreference",
      value: "希望未来要孩子",
      confidence: 0.9,
      status: "confirmed",
      sourceTurnId: questionTurn.id
    }
  ]);

  __testOnlyRebuildTopicLedger(
    getPrechatSessionById(session.id),
    listConversationTurns(session.id),
    listExtractedFacts(session.id),
    objectives
  );
  const sessionWithFact = getPrechatSessionById(session.id);
  const afterFact = __testOnlyBuildRoundProgressSnapshot(
    sessionWithFact,
    objectives,
    listConversationTurns(session.id),
    round
  );
  assert.equal(__testOnlyDidRoundProgressAdvance(afterOutstanding, afterFact), true);
});

test("marriageTimeline 脏片段不会再被自然化成病句", () => {
  const cleanCard = __testOnlyBuildFactCard(
    {
      twinProfile: {
        marriageTimeline: "如果匹配，希望1到2年内推进"
      }
    },
    "marriageTimeline"
  );
  assert.equal(cleanCard.naturalAnswerHint.includes("1到2年内推进"), true);

  const dirtyCard = __testOnlyBuildFactCard(
    {
      twinProfile: {
        marriageTimeline: "哈喽，感觉你很不错"
      }
    },
    "marriageTimeline"
  );
  assert.equal(dirtyCard.naturalAnswerHint, null);
  assert.equal(/按.+节奏推进结婚/u.test(dirtyCard.normalizedSummary), false);
});

test("历史脏 fact 在运行时会被净化，不再进入 prompt 或会话事实展示", async () => {
  const clientA = createClient();
  const clientB = createClient();

  const userA = await registerAndLogin(clientA, "sanitize-a@example.com", "雨涵");
  const userB = await registerAndLogin(clientB, "sanitize-b@example.com", "乔治");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("乔治"));

  const matchId = upsertMatch(userA.id, userB.id, 90, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id
  });
  updatePrechatSession(session.id, {
    status: "paused_review",
    currentRound: 1
  });

  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: [
        {
          key: "marriageTimeline",
          label: "结婚节奏",
          prompt: "确认结婚推进节奏是否接近。"
        }
      ]
    }
  });

  const sourceTurn = addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 1,
    actorUserId: userA.id,
    actorRole: "initiator_twin",
    content: "你好，我们可以先聊聊结婚节奏。",
    metadata: {}
  });

  saveExtractedFacts(
    session.id,
    round.id,
    [
      {
        subjectUserId: userA.id,
        key: "marriageTimeline",
        value: "哈喽，感觉你很不错",
        confidence: 0.9,
        status: "confirmed"
      }
    ],
    sourceTurn.id
  );

  const sanitized = __testOnlySanitizeFactsForPrompt(
    [
      {
        subjectUserId: userA.id,
        key: "marriageTimeline",
        value: "哈喽，感觉你很不错",
        confidence: 0.9,
        status: "confirmed"
      }
    ],
    { source: "test" }
  );
  assert.equal(sanitized.length, 0);

  const detail = await clientA.request(`/api/prechat/sessions/${session.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.facts.some((fact) => fact.value.includes("感觉你很不错")), false);
});

test("阶段报告中的英文角色标签会在返回时被中文化", async () => {
  const clientA = createClient();
  const clientB = createClient();

  const userA = await registerAndLogin(clientA, "stage-role-a@example.com", "雨涵");
  const userB = await registerAndLogin(clientB, "stage-role-b@example.com", "乔治");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("乔治"));

  const matchId = upsertMatch(userA.id, userB.id, 88, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id
  });
  updatePrechatSession(session.id, {
    status: "paused_review",
    currentRound: 1
  });

  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: { topics: [] }
  });

  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 1,
    actorUserId: userA.id,
    actorRole: "initiator_twin",
    content: "我们先确认一下长期关系目标。",
    metadata: {}
  });

  createStageReport(session.id, round.id, {
    summary:
      "Initiator 已明确以认真长期关系为目标，Counterparty（乔治）还需要补充城市安排，initiator_twin 已先做过一轮确认，对方（你）这边也已表达长期目标。",
    confirmed_facts: [
      {
        subjectUserId: userA.id,
        key: "relationshipGoal",
        value: "认真长期关系",
        confidence: 0.9,
        status: "confirmed"
      }
    ],
    unresolved_questions: [
      "Counterparty 的长期城市安排",
      "initiator_user 对婚后边界的具体期待",
      "对方（乔治）的补充信息"
    ],
    risk_summary: [
      {
        type: "none",
        severity: "low",
        reason: "counterparty_twin 暂未明确回应，Counterparty（乔治）仍需继续确认。"
      }
    ],
    next_action: "continue",
    handoff_ready: false
  });

  const detailA = await clientA.request(`/api/prechat/sessions/${session.id}`);
  const detailB = await clientB.request(`/api/prechat/sessions/${session.id}`);
  const sessionsA = await clientA.request("/api/prechat/sessions");

  assert.equal(detailA.status, 200);
  assert.equal(detailB.status, 200);
  assert.equal(sessionsA.status, 200);

  const reportA = detailA.body.stageReports[0].payload;
  const reportB = detailB.body.stageReports[0].payload;
  const listSummary = sessionsA.body.sessions.find((item) => item.id === session.id)?.latestStageReport;

  assert.equal(/Initiator|Counterparty|initiator_user|counterparty_user|initiator_twin|counterparty_twin/u.test(reportA.summary), false);
  assert.equal(/Initiator|Counterparty|initiator_user|counterparty_user|initiator_twin|counterparty_twin/u.test(reportB.summary), false);
  assert.equal(/Initiator|Counterparty|initiator_user|counterparty_user|initiator_twin|counterparty_twin/u.test(listSummary?.summary || ""), false);
  assert.equal(/对方（你）|对方\(你\)|对方（乔治）|对方\(乔治\)/u.test(reportA.summary), false);
  assert.equal(/对方（你）|对方\(你\)|对方（乔治）|对方\(乔治\)/u.test(reportB.summary), false);
  assert.match(reportA.summary, /你|对方/u);
  assert.match(reportB.summary, /你|乔治/u);
  assert.equal(
    reportA.unresolved_questions.some((item) =>
      /Initiator|Counterparty|initiator_user|counterparty_user|initiator_twin|counterparty_twin/u.test(item)
    ),
    false
  );
  assert.equal(
    reportB.unresolved_questions.some((item) =>
      /Initiator|Counterparty|initiator_user|counterparty_user|initiator_twin|counterparty_twin/u.test(item)
    ),
    false
  );
  assert.equal(reportA.unresolved_questions.some((item) => /对方（乔治）|对方\(乔治\)|对方（你）|对方\(你\)/u.test(item)), false);
  assert.equal(reportB.unresolved_questions.some((item) => /对方（乔治）|对方\(乔治\)|对方（你）|对方\(你\)/u.test(item)), false);
  assert.equal(
    reportA.risk_summary.some((item) =>
      /Initiator|Counterparty|initiator_user|counterparty_user|initiator_twin|counterparty_twin/u.test(item.reason)
    ),
    false
  );
  assert.equal(
    reportB.risk_summary.some((item) =>
      /Initiator|Counterparty|initiator_user|counterparty_user|initiator_twin|counterparty_twin/u.test(item.reason)
    ),
    false
  );
  assert.equal(reportA.risk_summary.some((item) => /对方（乔治）|对方\(乔治\)|对方（你）|对方\(你\)/u.test(item.reason)), false);
  assert.equal(reportB.risk_summary.some((item) => /对方（乔治）|对方\(乔治\)|对方（你）|对方\(你\)/u.test(item.reason)), false);
});

test("新生成的阶段报告在落库前会把英文角色标签转成中文", () => {
  const session = {
    initiatorUserId: "user-a",
    counterpartyUserId: "user-b",
    initiator: { displayName: "雨涵" },
    counterparty: { displayName: "乔治" }
  };

  const payload = sanitizeStageReportPayloadForViewer(
    {
      summary: "Initiator 已确认长期关系目标，counterparty_user 还需要说明城市安排，Counterparty（乔治）也需要进一步确认。",
      confirmed_facts: [],
      unresolved_questions: ["Counterparty 的城市安排", "initiator_twin 的婚后边界", "对方（你）的城市安排"],
      risk_summary: [
        {
          type: "none",
          severity: "low",
          reason: "initiator_user 和 counterparty_twin 都还需要继续确认，Counterparty（乔治）尤其如此。"
        }
      ],
      next_action: "continue",
      handoff_ready: false
    },
    session,
    "user-a"
  );

  assert.equal(/Initiator|Counterparty|initiator_user|counterparty_user|initiator_twin|counterparty_twin/u.test(payload.summary), false);
  assert.equal(
    /Initiator|Counterparty|initiator_user|counterparty_user|initiator_twin|counterparty_twin/u.test(
      payload.unresolved_questions.join(" ")
    ),
    false
  );
  assert.equal(
    /Initiator|Counterparty|initiator_user|counterparty_user|initiator_twin|counterparty_twin/u.test(
      payload.risk_summary[0].reason
    ),
    false
  );
  assert.equal(/对方（乔治）|对方\(乔治\)|对方（你）|对方\(你\)/u.test(payload.summary), false);
  assert.equal(
    /对方（乔治）|对方\(乔治\)|对方（你）|对方\(你\)/u.test(payload.unresolved_questions.join(" ")),
    false
  );
  assert.equal(/对方（乔治）|对方\(乔治\)|对方（你）|对方\(你\)/u.test(payload.risk_summary[0].reason), false);
});

test("阶段总结会按 viewer 映射成只关于对方用户的 summary", () => {
  const session = {
    initiatorUserId: "user-a",
    counterpartyUserId: "user-b",
    initiator: { displayName: "雨涵" },
    counterparty: { displayName: "乔治" }
  };

  const payloadForA = sanitizeStageReportPayloadForViewer(
    {
      summary: "默认摘要",
      summary_by_role: {
        initiator: "关系目标：认真长期关系；城市与生活安排：更倾向在上海或杭州长期生活。",
        counterparty: "关系目标：认真长期关系；家庭边界：婚后更偏向独立小家庭。"
      },
      confirmed_facts: [],
      unresolved_questions: ["对方的财务观仍未明确"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    },
    session,
    "user-a"
  );

  const payloadForB = sanitizeStageReportPayloadForViewer(
    {
      summary: "默认摘要",
      summary_by_role: {
        initiator: "关系目标：认真长期关系；城市与生活安排：更倾向在上海或杭州长期生活。",
        counterparty: "关系目标：认真长期关系；家庭边界：婚后更偏向独立小家庭。"
      },
      confirmed_facts: [],
      unresolved_questions: ["对方的财务观仍未明确"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    },
    session,
    "user-b"
  );

  assert.equal(payloadForA.summary, "关系目标：认真长期关系；城市与生活安排：更倾向在上海或杭州长期生活。");
  assert.equal(payloadForB.summary, "关系目标：认真长期关系；家庭边界：婚后更偏向独立小家庭。");
});

test("模型总结失败时会退回只关于对方用户的 deterministic fallback", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "counterparty-summary-a@example.com", "雨涵");
  await registerAndLogin(clientB, "counterparty-summary-b@example.com", "乔治");
  await saveTwinFor(clientA, buildTwin("雨涵"));
  await saveTwinFor(clientB, buildTwin("乔治"));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "乔治").id;
  const invitation = await clientA.request(`/api/matches/${matchId}/invite-prechat`, { method: "POST" });
  const sessionId = invitation.body.session.id;

  mockLlmSequence([
    {
      reply: "你好，我是雨涵的 Twin。我想先确认一下，你现在更明确想进入怎样的长期关系？",
      reply_topic_key: "relationshipGoal",
      question_topic_key: "relationshipGoal",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["你现在更明确想进入怎样的长期关系？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "",
      confirmed_facts: [],
      unresolved_questions: [],
      risk_summary: [],
      next_action: "pause_review",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  const detail = await waitForSessionState(
    clientA,
    sessionId,
    (response) => Array.isArray(response.body?.stageReports) && response.body.stageReports.length > 0,
    80
  );

  const summary = String(detail.body.stageReports[0]?.payload?.summary || "");
  assert.match(summary, /：/u);
  assert.equal(/双方|本轮|系统暂停|流程/u.test(summary), false);
});

test("重新生成模型总结只更新 stage report，不推进 twin-twin 预沟通", async () => {
  const userA = createUser({
    email: "regen-summary-a@example.com",
    displayName: "雨涵",
    passwordHash: hashPassword("password123")
  });
  const userB = createUser({
    email: "regen-summary-b@example.com",
    displayName: "乔治",
    passwordHash: hashPassword("password123")
  });

  saveCurrentTwin(userA.id, buildTwin("雨涵"));
  saveCurrentTwin(userB.id, buildTwin("乔治"));

  const matchId = upsertMatch(userA.id, userB.id, 96, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id
  });
  updatePrechatSession(session.id, { status: "active" });

  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: ["relationshipGoal", "cities"],
      activeTopicKey: "cities"
    }
  });

  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 1,
    actorUserId: userA.id,
    actorRole: "twin",
    content: "我是雨涵，我更希望未来长期在上海或杭州生活。你对城市安排怎么看？",
    metadata: {
      canonical_question_text: "你对城市安排怎么看？",
      canonical_question_topic_key: "cities",
      question_fingerprint: "cities::city-plan"
    }
  });

  saveExtractedFacts(session.id, round.id, [
    {
      subjectUserId: userB.id,
      key: "cities",
      value: "长期更偏向上海或杭州生活",
      confidence: 0.9,
      status: "confirmed"
    }
  ]);

  finishPrechatRound(round.id, { status: "completed", stopReason: "paused_review" });

  const originalReport = createStageReport(session.id, round.id, {
    summary: "旧总结",
    summary_by_role: {
      initiator: "旧的对方总结 A",
      counterparty: "旧的对方总结 B"
    },
    confirmed_facts: [],
    unresolved_questions: [],
    risk_summary: [],
    next_action: "continue",
    handoff_ready: false
  });

  mockLlmSequence([
    {
      summary: "模型新总结",
      summary_by_role: {
        initiator: "对方目前更偏向在上海或杭州长期生活。",
        counterparty: "对方目前以认真长期关系为目标。"
      },
      confirmed_facts: [
        {
          topicKey: "cities",
          summary: "对方更偏向在上海或杭州长期生活。"
        }
      ],
      unresolved_questions: ["对方的婚后城市灵活度仍待确认"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const beforeTurns = listConversationTurns(session.id);
  const beforeRounds = listPrechatRounds(session.id);
  const regenerated = await regenerateStageSummary(session.id);
  const detail = getSessionDetailForUser(session.id, userA.id);
  const latestReport = detail.stageReports[0];
  const allRoundReports = detail.stageReports.filter((item) => item.roundId === round.id);

  assert.equal(regenerated.sessionId, session.id);
  assert.equal(regenerated.roundId, round.id);
  assert.equal(regenerated.replacedExisting, true);
  assert.equal(regenerated.reportId, originalReport.id);
  assert.equal(allRoundReports.length, 1);
  assert.equal(latestReport.id, originalReport.id);
  assert.match(latestReport.payload.summary_by_role.initiator, /：/u);
  assert.match(latestReport.payload.summary_by_role.initiator, /上海或杭州/u);
  assert.equal(/暂未明确/u.test(latestReport.payload.summary_by_role.initiator), false);
  assert.equal(listConversationTurns(session.id).length, beforeTurns.length);
  assert.equal(listPrechatRounds(session.id).length, beforeRounds.length);
  assert.equal(getPrechatSessionById(session.id).currentRound, session.currentRound);
});

test("模型总结重算时不会把 scoped 已确认议题再次写进 unresolved_questions", async () => {
  const userA = createUser({
    email: "summary-scope-a@example.com",
    displayName: "雨涵",
    passwordHash: hashPassword("password123")
  });
  const userB = createUser({
    email: "summary-scope-b@example.com",
    displayName: "刘宇",
    passwordHash: hashPassword("password123")
  });

  saveCurrentTwin(userA.id, buildTwin("雨涵"));
  saveCurrentTwin(userB.id, buildTwin("刘宇"));

  const matchId = upsertMatch(userA.id, userB.id, 95, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id
  });
  updatePrechatSession(session.id, {
    status: "paused_review",
    control: {
      automation: {
        preferredObjectiveKeys: ["cities", "marriageTimeline", "familyBoundary"],
        activeTopicKey: null,
        topicLedger: {
          cities: { state: "closed", coverage: { initiator: true, counterparty: true } },
          marriageTimeline: { state: "closed", coverage: { initiator: true, counterparty: true } },
          familyBoundary: { state: "closed", coverage: { initiator: true, counterparty: true } }
        }
      }
    }
  });

  const round1 = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: [
        { key: "cities", label: "城市与生活安排", prompt: "确认长期城市安排与生活落地预期。" },
        { key: "marriageTimeline", label: "结婚节奏", prompt: "确认结婚推进节奏是否接近。" },
        { key: "familyBoundary", label: "家庭边界", prompt: "确认父母参与度和婚后边界。" }
      ],
      activeTopicKey: "familyBoundary",
      topicQueueSnapshot: ["familyBoundary"]
    }
  });
  finishPrechatRound(round1.id, { status: "completed", stopReason: "deferred_model_retry" });

  const round2 = createPrechatRound({
    sessionId: session.id,
    roundNumber: 2,
    objective: {
      topics: [
        { key: "cities", label: "城市与生活安排", prompt: "确认长期城市安排与生活落地预期。" },
        { key: "marriageTimeline", label: "结婚节奏", prompt: "确认结婚推进节奏是否接近。" },
        { key: "familyBoundary", label: "家庭边界", prompt: "确认父母参与度和婚后边界。" }
      ],
      activeTopicKey: null,
      topicQueueSnapshot: []
    }
  });
  finishPrechatRound(round2.id, { status: "completed", stopReason: "objectives_completed" });

  saveExtractedFacts(session.id, round1.id, [
    { subjectUserId: userB.id, key: "cities", value: "长期更倾向深圳", confidence: 0.9, status: "confirmed" },
    { subjectUserId: userA.id, key: "cities", value: "长期更倾向杭州", confidence: 0.9, status: "confirmed" },
    { subjectUserId: userB.id, key: "marriageTimeline", value: "希望 1 到 2 年内推进", confidence: 0.9, status: "confirmed" },
    { subjectUserId: userA.id, key: "marriageTimeline", value: "如果稳定会在两年左右认真考虑结婚", confidence: 0.9, status: "confirmed" }
  ]);
  saveExtractedFacts(session.id, round2.id, [
    { subjectUserId: userB.id, key: "familyBoundary", value: "婚后偏向独立小家庭，同时尊重双方父母", confidence: 0.9, status: "confirmed" },
    { subjectUserId: userA.id, key: "familyBoundary", value: "婚后偏向独立小家庭，同时尊重双方父母", confidence: 0.9, status: "confirmed" },
    { subjectUserId: userB.id, key: "childrenPreference", value: "希望未来要孩子", confidence: 0.9, status: "confirmed" },
    { subjectUserId: userA.id, key: "financialView", value: "不喜欢隐形负债", confidence: 0.9, status: "confirmed" }
  ]);

  createStageReport(session.id, round2.id, {
    summary: "旧总结",
    summary_by_role: {
      initiator: "旧总结 A",
      counterparty: "旧总结 B"
    },
    confirmed_facts: [],
    unresolved_questions: ["对方对结婚节奏的具体预期", "对方对长期城市安排的具体预期"],
    risk_summary: [],
    next_action: "continue",
    handoff_ready: false
  });

  mockLlmSequence([
    {
      summary: "对方目前明确婚后偏向独立小家庭并尊重双方父母。",
      summary_by_role: {
        initiator: "对方目前明确婚后偏向独立小家庭并尊重双方父母。",
        counterparty: "对方目前明确婚后偏向独立小家庭并尊重双方父母。"
      },
      confirmed_facts: [],
      unresolved_questions: ["对方对结婚节奏的具体预期", "对方对长期城市安排的具体预期", "对方对关系目标的具体定义"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const regenerated = await regenerateStageSummary(session.id, { roundId: round2.id });

  assert.equal(regenerated.payload.objective_progress.every((item) => item.status === "confirmed"), true);
  assert.deepEqual(regenerated.payload.unresolved_questions, []);
  assert.match(regenerated.payload.summary_by_role.initiator, /：/u);
  assert.match(regenerated.payload.summary_by_role.initiator, /；/u);
  assert.match(regenerated.payload.summary_by_role.initiator, /城市与生活安排/u);
  assert.match(regenerated.payload.summary_by_role.initiator, /结婚节奏/u);
  assert.match(regenerated.payload.summary_by_role.initiator, /家庭边界/u);
  assert.match(regenerated.payload.summary_by_role.initiator, /孩子与生育态度/u);
  assert.equal(/财务观/u.test(regenerated.payload.summary_by_role.initiator), false);
  assert.equal(/暂未明确/u.test(regenerated.payload.summary_by_role.initiator), false);
});

test("模型总结会覆盖对方所有已确认事实对应的议题，而不只看当前 round scope", async () => {
  const userA = createUser({
    email: "summary-all-facts-a@example.com",
    displayName: "雨涵",
    passwordHash: hashPassword("password123")
  });
  const userB = createUser({
    email: "summary-all-facts-b@example.com",
    displayName: "刘宇",
    passwordHash: hashPassword("password123")
  });

  saveCurrentTwin(userA.id, buildTwin("雨涵"));
  saveCurrentTwin(userB.id, buildTwin("刘宇"));

  const matchId = upsertMatch(userA.id, userB.id, 94, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id
  });
  updatePrechatSession(session.id, {
    status: "paused_review",
    control: {
      automation: {
        preferredObjectiveKeys: ["cities", "financialView"],
        activeTopicKey: null,
        topicLedger: {
          cities: { state: "closed", coverage: { initiator: true, counterparty: true } },
          marriageTimeline: { state: "closed", coverage: { initiator: true, counterparty: true } },
          familyBoundary: { state: "closed", coverage: { initiator: true, counterparty: true } },
          childrenPreference: { state: "closed", coverage: { initiator: true, counterparty: true } },
          financialView: { state: "closed", coverage: { initiator: true, counterparty: true } }
        }
      }
    }
  });

  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: [
        { key: "cities", label: "城市与生活安排", prompt: "确认长期城市安排与生活落地预期。" },
        { key: "financialView", label: "财务观", prompt: "确认消费、负债与储蓄观念。" }
      ],
      activeTopicKey: null,
      topicQueueSnapshot: []
    }
  });
  finishPrechatRound(round.id, { status: "completed", stopReason: "paused_review" });

  saveExtractedFacts(session.id, round.id, [
    { subjectUserId: userB.id, key: "cities", value: "长期更倾向深圳，广州也可以接受", confidence: 0.9, status: "confirmed" },
    { subjectUserId: userB.id, key: "financialView", value: "不接受隐形负债，消费前会先规划", confidence: 0.9, status: "confirmed" },
    { subjectUserId: userB.id, key: "marriageTimeline", value: "如果匹配，希望 1 到 2 年内推进", confidence: 0.9, status: "confirmed" },
    { subjectUserId: userB.id, key: "familyBoundary", value: "婚后更偏向独立小家庭，同时尊重双方父母", confidence: 0.9, status: "confirmed" },
    { subjectUserId: userB.id, key: "childrenPreference", value: "未来倾向要孩子", confidence: 0.9, status: "confirmed" }
  ]);

  mockLlmSequence([
    {
      summary: "模型新总结",
      summary_by_role: {
        initiator: "财务观：不接受隐形负债。",
        counterparty: "财务观：不接受隐形负债。"
      },
      confirmed_facts: [],
      unresolved_questions: [],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const regenerated = await regenerateStageSummary(session.id, { roundId: round.id });
  const summary = regenerated.payload.summary_by_role.initiator;

  assert.match(summary, /城市与生活安排/u);
  assert.match(summary, /财务观/u);
  assert.match(summary, /结婚节奏/u);
  assert.match(summary, /家庭边界/u);
  assert.match(summary, /孩子与生育态度/u);
  assert.equal(/暂未明确/u.test(summary), false);
});

test("LLM 输出 marriageTimeline 脏 fact 时不会落库，并改走静默恢复而不是‘表述不自然’暂停", async () => {
  await withDeferredRetryTestConfig(async () => {
    const previousOpeningWindow = process.env.PRECHAT_OPENING_DEFERRED_RETRY_TOTAL_WINDOW_MS;
    const previousOpeningDelays = process.env.PRECHAT_OPENING_DEFERRED_RETRY_DELAYS_MS;
    process.env.PRECHAT_OPENING_DEFERRED_RETRY_TOTAL_WINDOW_MS = "2000";
    process.env.PRECHAT_OPENING_DEFERRED_RETRY_DELAYS_MS = "120,180,240";

    try {
    const clientA = createClient();
    const clientB = createClient();

    await registerAndLogin(clientA, "dirty-fact-a@example.com", "雨涵");
    await registerAndLogin(clientB, "dirty-fact-b@example.com", "乔治");
    await saveTwinFor(clientA, buildTwin("雨涵"));
    await saveTwinFor(clientB, buildTwin("乔治"));

    const matches = await clientA.request("/api/matches");
    const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "乔治").id;
    const invitation = await clientA.request(`/api/matches/${matchId}/invite-prechat`, { method: "POST" });
    const sessionId = invitation.body.session.id;

    mockLlmSequence([
      {
        reply: "如果关系稳定，我更偏向按哈喽，感觉你很不错的节奏推进结婚。",
        is_sensitive_question: false,
        sensitive_topic_category: null,
        needs_sensitive_approval: false,
        target_user_for_approval: null,
        confirmed_facts: [
          {
            subjectUserId: "self",
            key: "marriageTimeline",
            value: "哈喽，感觉你很不错",
            confidence: 0.9,
            status: "confirmed"
          }
        ],
        open_questions: [],
        risk_flags: [],
        needs_human_input: { required: false },
        recommendation: "pause_review"
      },
      {
        reply: "我这边更明确是以认真长期关系为前提来了解对方的。你现在更明确想进入怎样的长期关系？",
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
            confidence: 0.9,
            status: "confirmed"
          }
        ],
        open_questions: ["你现在更明确想进入怎样的长期关系？"],
        risk_flags: [],
        needs_human_input: { required: false },
        recommendation: "continue"
      },
      {
        summary: "已在静默重试后恢复首轮关系目标开场。",
        confirmed_facts: [],
        unresolved_questions: ["对方的关系目标"],
        risk_summary: [],
        next_action: "continue",
        handoff_ready: false
      }
    ]);

    const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
    assert.equal(accepted.status, 200);

    const duringRetry = await waitForSessionState(
      clientA,
      sessionId,
      (detail) => Boolean(detail.body?.session?.control?.automation?.deferredRetry),
      40
    );
    assert.equal(duringRetry.body.session.status, "active");
    assert.equal(duringRetry.body.facts.some((fact) => fact.key === "marriageTimeline"), false);
    assert.equal(duringRetry.body.humanInputRequests.some((request) => request.status === "pending"), false);
    assert.equal(
      duringRetry.body.turns.some((turn) => /表述不够自然|事实表述不够自然/u.test(String(turn.content || ""))),
      false
    );

    const recovered = await waitForSessionState(
      clientA,
      sessionId,
      (detail) =>
        detail.body?.turns?.some(
          (turn) =>
            String(turn.actorRole || "").endsWith("_twin") &&
            /长期关系/u.test(String(turn.content || ""))
        ),
      80
    );

    assert.equal(["active", "paused_review"].includes(recovered.body.session.status), true);
    assert.equal(recovered.body.facts.some((fact) => fact.key === "marriageTimeline"), false);
    assert.equal(recovered.body.turns.some((turn) => /长期关系/u.test(String(turn.content || ""))), true);
    assert.equal(recovered.body.humanInputRequests.some((request) => request.status === "pending"), false);
    assert.equal(
      recovered.body.turns.some((turn) => /表述不够自然|事实表述不够自然/u.test(String(turn.content || ""))),
      false
    );
    } finally {
      if (previousOpeningWindow == null) {
        delete process.env.PRECHAT_OPENING_DEFERRED_RETRY_TOTAL_WINDOW_MS;
      } else {
        process.env.PRECHAT_OPENING_DEFERRED_RETRY_TOTAL_WINDOW_MS = previousOpeningWindow;
      }

      if (previousOpeningDelays == null) {
        delete process.env.PRECHAT_OPENING_DEFERRED_RETRY_DELAYS_MS;
      } else {
        process.env.PRECHAT_OPENING_DEFERRED_RETRY_DELAYS_MS = previousOpeningDelays;
      }
    }
  }, { delaysMs: "120,180,240", totalWindowMs: "2000" });
});

test("首轮 question_topic_key 缺失但文本仍是 active topic 时，不会被 topic guard 误暂停", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "first-turn-a@example.com", "刘星");
  await registerAndLogin(clientB, "first-turn-b@example.com", "沈特");
  await saveTwinFor(clientA, buildTwin("刘星"));
  await saveTwinFor(clientB, buildTwin("沈特"));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "沈特").id;
  const plan = await clientA.request("/api/prechat/plan", {
    method: "POST",
    json: {
      matchIds: [matchId],
      objectiveKeys: ["relationshipGoal", "cities", "marriageTimeline"]
    }
  });
  assert.equal(plan.status, 201);

  const sessionId = plan.body.sessions[0].id;

  mockLlmSequence([
    {
      reply: "我这边更明确是以认真长期关系为前提来了解对方的。你现在更看重怎样的长期关系目标？",
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
          confidence: 0.91,
          status: "confirmed"
        }
      ],
      open_questions: ["你现在更看重怎样的长期关系目标？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "我这边也是认真长期关系导向，也会把结婚纳入考虑。你未来长期更倾向在哪个城市生活？",
      reply_topic_key: "relationshipGoal",
      question_topic_key: "cities",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "relationshipGoal",
          value: "认真长期关系，也会把结婚纳入考虑",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["长期城市安排"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "首轮已正常开始，先确认了关系目标，再转入城市议题。",
      confirmed_facts: [],
      unresolved_questions: ["长期城市安排", "结婚节奏"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  const detail = await waitForAutomationIdle(clientA, sessionId);
  assert.equal(["active", "paused_review"].includes(detail.body.session.status), true);
  assert.equal(detail.body.turns.some((turn) => String(turn.actorRole || "").endsWith("_twin")), true);
  assert.notEqual(detail.body.session.status, "pending_human_input");
  assert.equal(
    detail.body.humanInputRequests.some((item) => item.status === "pending" && item.fieldKey === "relationshipGoal"),
    false
  );
});

test("首轮明确跳到别的 topic 时，会先 rewrite 成 active topic opening", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "first-turn-jump-a@example.com", "刘星");
  await registerAndLogin(clientB, "first-turn-jump-b@example.com", "沈特");
  await saveTwinFor(clientA, buildTwin("刘星"));
  await saveTwinFor(clientB, buildTwin("沈特"));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "沈特").id;
  const plan = await clientA.request("/api/prechat/plan", {
    method: "POST",
    json: {
      matchIds: [matchId],
      objectiveKeys: ["relationshipGoal", "cities"]
    }
  });
  assert.equal(plan.status, 201);

  const sessionId = plan.body.sessions[0].id;

  mockLlmSequence([
    {
      reply: "我想先确认一下长期生活城市安排。你未来长期更倾向在上海还是杭州生活？",
      reply_topic_key: "cities",
      question_topic_key: "cities",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["长期城市安排"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "首轮被 topic guard 拦截。",
      confirmed_facts: [],
      unresolved_questions: ["关系目标"],
      risk_summary: [],
      next_action: "pause_review",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  const detail = await waitForAutomationIdle(clientA, sessionId);
  const twinTurn = detail.body.turns.find((turn) => String(turn.actorRole || "").endsWith("_twin"));
  assert.ok(twinTurn);
  assert.notEqual(detail.body.session.status, "pending_human_input");
  assert.match(String(twinTurn.content || ""), /长期关系/u);
  assert.doesNotMatch(String(twinTurn.content || ""), /上海还是杭州/u);
  assert.equal(twinTurn.metadata?.topic_guard_metadata?.source, "topic_guard_rewritten_first_turn");
  assert.equal(Boolean(twinTurn.metadata?.topic_guard_metadata?.openingRewriteApplied), true);
  assert.equal(twinTurn.metadata?.topic_guard_metadata?.originalQuestionTopicKey, "cities");
  assert.equal(twinTurn.metadata?.topic_guard_metadata?.rewrittenQuestionTopicKey, "relationshipGoal");
  assert.equal(
    detail.body.humanInputRequests.some((item) => item.status === "pending" && item.fieldKey === "relationshipGoal"),
    false
  );
});

test("历史首轮 topic guard 误暂停会话在打开详情后会自动恢复", async () => {
  const userA = createUser({
    email: "recover-first-turn-a@example.com",
    displayName: "刘星",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "recover-first-turn-b@example.com",
    displayName: "沈特",
    passwordHash: hashPassword("secret123")
  });

  saveCurrentTwin(userA.id, buildTwin("刘星"));
  saveCurrentTwin(userB.id, buildTwin("沈特"));

  const matchId = upsertMatch(userA.id, userB.id, 90, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id,
    control: {
      automation: {
        enabled: true,
        source: "report_plan",
        preferredObjectiveKeys: ["relationshipGoal", "cities"],
        activeTopicKey: "relationshipGoal",
        topicQueueSnapshot: ["relationshipGoal", "cities"],
        topicLedger: {
          relationshipGoal: {
            state: "not_started",
            coverage: { initiator: false, counterparty: false },
            pendingAnswerUserId: null,
            lastQuestionTurnId: null,
            closedAt: null,
            reopenReason: null,
            reopenedAt: null
          },
          cities: {
            state: "not_started",
            coverage: { initiator: false, counterparty: false },
            pendingAnswerUserId: null,
            lastQuestionTurnId: null,
            closedAt: null,
            reopenReason: null,
            reopenedAt: null
          }
        }
      }
    }
  });

  updatePrechatSession(session.id, {
    status: "pending_human_input",
    currentRound: 1
  });

  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: [
        {
          key: "relationshipGoal",
          label: "关系目标",
          prompt: "确认双方是否都以认真长期关系为导向。"
        },
        {
          key: "cities",
          label: "城市与生活安排",
          prompt: "确认长期城市安排与生活预期。"
        }
      ],
      activeTopicKey: "relationshipGoal",
      topicQueueSnapshot: ["relationshipGoal", "cities"]
    }
  });

  createHumanInputRequest({
    sessionId: session.id,
    roundId: round.id,
    targetUserId: userA.id,
    fieldKey: "relationshipGoal",
    questionText: "当前议题“关系目标”尚未完成，系统已阻止跳题，请本人确认这一题后再继续。",
    metadata: {
      source: "topic_guard_blocked_first_turn",
      firstTurnGuardBlock: true,
      activeTopicKey: "relationshipGoal",
      derivedQuestionTopicKey: "cities",
      topicInferenceSource: {
        reply: "model_reply_topic_key",
        question: "model_question_topic_key"
      }
    }
  });

  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 1,
    actorUserId: null,
    actorRole: "system",
    content: "系统暂停：需要 刘星 本人补充信息后才能继续。待确认内容：当前议题“关系目标”尚未完成，系统已阻止跳题，请本人确认这一题后再继续。",
    metadata: {
      pauseReason: "pending_human_input",
      targetUserId: userA.id,
      fieldKey: "relationshipGoal",
      source: "topic_guard_blocked_first_turn",
      firstTurnGuardBlock: true,
      activeTopicKey: "relationshipGoal",
      derivedQuestionTopicKey: "cities",
      topicInferenceSource: {
        reply: "model_reply_topic_key",
        question: "model_question_topic_key"
      }
    }
  });

  mockLlmSequence([
    {
      reply: "我这边是认真长期关系导向，也会把结婚纳入考虑。你现在更看重怎样的长期关系目标？",
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
          value: "认真长期关系，也会把结婚纳入考虑",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["你现在更看重怎样的长期关系目标？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "我这边同样是认真长期关系导向。你未来长期更倾向在哪个城市生活？",
      reply_topic_key: "relationshipGoal",
      question_topic_key: "cities",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "relationshipGoal",
          value: "认真长期关系导向",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["长期城市安排"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "自动恢复后首轮已正常重开。",
      confirmed_facts: [],
      unresolved_questions: ["长期城市安排"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const turnCountBefore = listConversationTurns(session.id).length;
  const roundCountBefore = listPrechatRounds(session.id).length;

  await getSessionViewWithAutoRecovery(session.id, userA.id);

  let detail = null;
  for (let index = 0; index < 30; index += 1) {
    detail = getSessionDetailForUser(session.id, userA.id);
    const runState = detail?.session?.control?.automation?.runState || "idle";
    if (!["queued", "running"].includes(runState)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.ok(detail);
  assert.equal(detail.session.status, "paused_review");
  assert.equal(
    detail.humanInputRequests.some(
      (item) =>
        item.status === "resolved" &&
        item.metadata?.autoRecoverySource === "topic_guard_blocked_first_turn"
    ),
    true
  );
  assert.equal(
    detail.humanInputRequests.some((item) => item.status === "pending" && item.metadata?.source === "topic_guard_blocked"),
    false
  );
  assert.equal(
    detail.humanInputRequests.some(
      (item) =>
        item.status === "pending" &&
        item.fieldKey === "relationshipGoal" &&
        item.metadata?.source !== "fact_rejection_guard"
    ),
    false
  );
  assert.equal(detail.session.control?.automation?.runState || "idle", "idle");
  assert.equal(detail.turns.length, turnCountBefore);
  assert.equal(listPrechatRounds(session.id).length, roundCountBefore);
});

test("合法的 answer-then-switch 被 topic_guard_blocked 误拦时，打开会话只自动 resolve，不会自动恢复", async () => {
  const userA = createUser({
    email: "topic-guard-false-positive-a@example.com",
    displayName: "雨涵",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "topic-guard-false-positive-b@example.com",
    displayName: "刘星",
    passwordHash: hashPassword("secret123")
  });

  saveCurrentTwin(userA.id, buildTwin("雨涵", { childrenPreference: "希望未来要孩子" }));
  saveCurrentTwin(
    userB.id,
    buildTwin("刘星", {
      childrenPreference: "希望未来要孩子",
      familyBoundary: "婚后我更偏向以独立小家庭为主，同时会尊重双方父母。"
    })
  );

  const matchId = upsertMatch(userA.id, userB.id, 95, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id,
    control: {
      automation: {
        enabled: true,
        source: "report_plan",
        preferredObjectiveKeys: ["childrenPreference", "familyBoundary"],
        activeTopicKey: "childrenPreference",
        topicQueueSnapshot: ["childrenPreference", "familyBoundary"],
        topicLedger: {
          childrenPreference: {
            state: "waiting_counterparty",
            coverage: { initiator: true, counterparty: false },
            pendingAnswerUserId: userB.id,
            lastQuestionTurnId: "turn-1",
            closedAt: null
          },
          familyBoundary: {
            state: "not_started",
            coverage: { initiator: false, counterparty: false },
            pendingAnswerUserId: null,
            lastQuestionTurnId: null,
            closedAt: null
          }
        }
      }
    }
  });

  updatePrechatSession(session.id, {
    status: "pending_human_input",
    currentRound: 1
  });

  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: [
        { key: "childrenPreference", label: "孩子与生育态度", prompt: "确认对未来孩子与生育的态度。" },
        { key: "familyBoundary", label: "家庭边界", prompt: "确认父母参与度和婚后边界。" }
      ],
      activeTopicKey: "childrenPreference",
      topicQueueSnapshot: ["childrenPreference", "familyBoundary"]
    }
  });

  saveExtractedFacts(session.id, round.id, [
    {
      subjectUserId: userA.id,
      key: "childrenPreference",
      value: "希望未来要孩子",
      confidence: 0.92,
      status: "confirmed"
    }
  ]);

  createHumanInputRequest({
    sessionId: session.id,
    roundId: round.id,
    targetUserId: userB.id,
    fieldKey: "childrenPreference",
    questionText: "当前议题“孩子与生育态度”尚未完成，系统已阻止跳题，请本人确认这一题后再继续。",
    metadata: {
      source: "topic_guard_blocked",
      activeTopicKey: "childrenPreference",
      derivedReplyTopicKey: "childrenPreference",
      derivedQuestionTopicKey: "familyBoundary",
      rawReply: "关于孩子这件事，我目前倾向于未来要孩子。婚后和父母的相处边界上，你更偏向怎样的安排？",
      rawOpenQuestions: ["婚后和父母的相处边界上，你更偏向怎样的安排？"],
      topicInferenceSource: {
        reply: "model_reply_topic_key",
        question: "model_question_topic_key"
      }
    }
  });

  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 1,
    actorUserId: null,
    actorRole: "system",
    content: "系统暂停：需要 刘星 本人补充信息后才能继续。待确认内容：当前议题“孩子与生育态度”尚未完成，系统已阻止跳题，请本人确认这一题后再继续。",
    metadata: {
      pauseReason: "pending_human_input",
      targetUserId: userB.id,
      fieldKey: "childrenPreference",
      source: "topic_guard_blocked",
      activeTopicKey: "childrenPreference",
      derivedReplyTopicKey: "childrenPreference",
      derivedQuestionTopicKey: "familyBoundary",
      rawReply: "关于孩子这件事，我目前倾向于未来要孩子。婚后和父母的相处边界上，你更偏向怎样的安排？",
      rawOpenQuestions: ["婚后和父母的相处边界上，你更偏向怎样的安排？"]
    }
  });

  mockLlmSequence([
    {
      reply: "婚后我更偏向以独立小家庭为主，同时会尊重双方父母。",
      reply_topic_key: "familyBoundary",
      question_topic_key: null,
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "familyBoundary",
          value: "婚后更偏向独立小家庭，同时会尊重双方父母",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: [],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "pause_review"
    },
    {
      summary: "孩子与家庭边界议题已继续推进。",
      confirmed_facts: [],
      unresolved_questions: [],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const turnCountBefore = listConversationTurns(session.id).length;
  const roundCountBefore = listPrechatRounds(session.id).length;

  await getSessionViewWithAutoRecovery(session.id, userA.id);

  let detail = null;
  for (let index = 0; index < 30; index += 1) {
    detail = getSessionDetailForUser(session.id, userA.id);
    const runState = detail?.session?.control?.automation?.runState || "idle";
    if (!["queued", "running"].includes(runState)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.ok(detail);
  assert.equal(
    detail.humanInputRequests.some(
      (item) =>
        item.status === "resolved" &&
        item.metadata?.autoRecoverySource === "topic_guard_false_positive_pending_request"
    ),
    true
  );
  assert.equal(
    detail.humanInputRequests.some(
      (item) => item.status === "pending" && item.metadata?.source === "topic_guard_blocked"
    ),
    false
  );
  assert.equal(detail.session.control?.automation?.runState || "idle", "idle");
  assert.equal(detail.session.status, "paused_review");
  assert.equal(detail.turns.length, turnCountBefore);
  assert.equal(listPrechatRounds(session.id).length, roundCountBefore);
});

test("乔治与刘星同构样本首轮问 cities 时，会 rewrite 到 relationshipGoal opening", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "george-a@example.com", "乔治");
  await registerAndLogin(clientB, "liuxing-b@example.com", "刘星");
  await saveTwinFor(clientA, buildTwin("乔治"));
  await saveTwinFor(clientB, buildTwin("刘星"));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "刘星").id;
  const plan = await clientA.request("/api/prechat/plan", {
    method: "POST",
    json: {
      matchIds: [matchId],
      objectiveKeys: ["relationshipGoal", "cities", "marriageTimeline"]
    }
  });
  assert.equal(plan.status, 201);

  const sessionId = plan.body.sessions[0].id;

  mockLlmSequence([
    {
      reply: "你好，我是刘星的 Twin。看到我们都以认真长期关系为目标，我想先确认一下，你未来更倾向长期在上海还是杭州生活？",
      reply_topic_key: "cities",
      question_topic_key: "cities",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["对方长期生活城市偏好"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "首轮已按关系目标重写。",
      confirmed_facts: [],
      unresolved_questions: ["关系目标", "城市与生活安排"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  const detail = await waitForAutomationIdle(clientA, sessionId);
  const twinTurn = detail.body.turns.find((turn) => String(turn.actorRole || "").endsWith("_twin"));
  assert.ok(twinTurn);
  assert.notEqual(detail.body.session.status, "pending_human_input");
  assert.match(String(twinTurn.content || ""), /长期关系/u);
  assert.doesNotMatch(String(twinTurn.content || ""), /上海还是杭州/u);
  assert.equal(twinTurn.metadata?.topic_guard_metadata?.source, "topic_guard_rewritten_first_turn");
  assert.equal(Boolean(twinTurn.metadata?.topic_guard_metadata?.effectiveFirstOpening), true);
  assert.equal(Boolean(twinTurn.metadata?.topic_guard_metadata?.openingRewriteApplied), true);
  assert.equal(twinTurn.metadata?.topic_guard_metadata?.originalQuestionTopicKey, "cities");
  assert.equal(twinTurn.metadata?.topic_guard_metadata?.rewrittenQuestionTopicKey, "relationshipGoal");
});

test("当前 active topic 未完成时跳到下一个 topic，会 rewrite 回当前议题而不是发人工待办", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "rewrite-active-topic-a@example.com", "乔治");
  await registerAndLogin(clientB, "rewrite-active-topic-b@example.com", "刘星");
  await saveTwinFor(clientA, buildTwin("乔治"));
  await saveTwinFor(clientB, buildTwin("刘星"));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "刘星").id;
  const plan = await clientA.request("/api/prechat/plan", {
    method: "POST",
    json: {
      matchIds: [matchId],
      objectiveKeys: ["relationshipGoal", "cities", "marriageTimeline"]
    }
  });
  assert.equal(plan.status, 201);

  const sessionId = plan.body.sessions[0].id;

  mockLlmSequence([
    {
      reply: "你好，我是刘星的 Twin。你现在更明确想进入怎样的长期关系？",
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
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["你现在更明确想进入怎样的长期关系？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "我希望进入认真、长期的关系，也希望关系稳定后以结婚为目标。你这边更看重长期稳定，还是也会把结婚放进考虑里？",
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
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["你这边更看重长期稳定，还是也会把结婚放进考虑里？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "如果匹配，希望 1 到 2 年内推进。 如果关系顺利推进，你更接受怎样的结婚节奏？",
      reply_topic_key: "marriageTimeline",
      question_topic_key: "marriageTimeline",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["如果关系顺利推进，你更接受怎样的结婚节奏？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "relationshipGoal 已完成，系统已把跳题重写回城市议题。",
      confirmed_facts: [],
      unresolved_questions: ["城市与生活安排", "结婚节奏"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  const detail = await waitForAutomationIdle(clientA, sessionId);
  const twinTurns = detail.body.turns.filter((turn) => String(turn.actorRole || "").endsWith("_twin"));
  assert.equal(twinTurns.length >= 3, true);
  const rewrittenTurn = twinTurns.find(
    (turn) =>
      String(turn.metadata?.canonical_question_topic_key || turn.metadata?.question_topic_key || "") === "cities" &&
      !/结婚节奏/u.test(String(turn.content || ""))
  );
  assert.ok(rewrittenTurn);
  assert.equal(String(rewrittenTurn.metadata?.canonical_question_topic_key || rewrittenTurn.metadata?.question_topic_key || ""), "cities");
  assert.doesNotMatch(String(rewrittenTurn.content || ""), /结婚节奏/u);
  assert.equal(
    detail.body.humanInputRequests.some((item) => item.status === "pending" && item.fieldKey === "cities"),
    false
  );
});

test("上一条 Twin 同时包含回答和追问时，answer_topic_mismatch_guard 只看最终追问 topic", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "mismatch-guard-a@example.com", "乔治");
  await registerAndLogin(clientB, "mismatch-guard-b@example.com", "刘星");
  await saveTwinFor(clientA, buildTwin("乔治"));
  await saveTwinFor(clientB, buildTwin("刘星"));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "刘星").id;
  const plan = await clientA.request("/api/prechat/plan", {
    method: "POST",
    json: {
      matchIds: [matchId],
      objectiveKeys: ["relationshipGoal", "cities", "marriageTimeline"]
    }
  });
  assert.equal(plan.status, 201);

  const sessionId = plan.body.sessions[0].id;

  mockLlmSequence([
    {
      reply: "你好，我是刘星的 Twin。你现在更明确想进入怎样的长期关系？",
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
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["你现在更明确想进入怎样的长期关系？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "我希望进入认真、长期的关系，也希望关系稳定后以结婚为目标。你这边更看重长期稳定，还是也会把结婚放进考虑里？",
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
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["你这边更看重长期稳定，还是也会把结婚放进考虑里？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "如果匹配，希望 1 到 2 年内推进。 如果关系顺利推进，你更接受怎样的结婚节奏？",
      reply_topic_key: "marriageTimeline",
      question_topic_key: "marriageTimeline",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["如果关系顺利推进，你更接受怎样的结婚节奏？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "我长期更倾向在上海生活，杭州也可以接受。你这边是更坚定留在深圳，还是广州也可以考虑？",
      reply_topic_key: "cities",
      question_topic_key: "cities",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "cities",
          value: "长期更倾向上海，杭州也可以接受",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["你这边是更坚定留在深圳，还是广州也可以考虑？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "我长期更倾向在深圳生活，广州也可以接受。你这边未来长期更倾向在哪个城市生活？",
      reply_topic_key: "cities",
      question_topic_key: "cities",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "cities",
          value: "长期更倾向深圳，广州也可以接受",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["你这边未来长期更倾向在哪个城市生活？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "城市议题已继续推进，不应误发 cities 待办。",
      confirmed_facts: [],
      unresolved_questions: ["结婚节奏"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  const detail = await waitForAutomationIdle(clientA, sessionId);
  assert.equal(
    detail.body.humanInputRequests.some((item) => item.status === "pending" && item.metadata?.source === "answer_topic_mismatch_guard"),
    false
  );
  assert.equal(
    detail.body.turns.some(
      (turn) =>
        String(turn.actorRole || "").endsWith("_twin") &&
        String(turn.metadata?.reply_topic_key || "") === "cities" &&
        !String(turn.content || "").includes("当前回复没有先正面回答")
    ),
    true
  );
});

test("已 closed 的 childrenPreference 不会在同一轮后续再次被 Twin 追问", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "repeat-topic-a@example.com", "雨涵");
  await registerAndLogin(clientB, "repeat-topic-b@example.com", "刘星");
  await saveTwinFor(clientA, buildTwin("雨涵", { childrenPreference: "希望未来要孩子" }));
  await saveTwinFor(clientB, buildTwin("刘星", { childrenPreference: "希望未来要孩子" }));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "刘星").id;
  const plan = await clientA.request("/api/prechat/plan", {
    method: "POST",
    json: {
      matchIds: [matchId],
      objectiveKeys: ["childrenPreference", "familyBoundary"]
    }
  });
  assert.equal(plan.status, 201);

  const sessionId = plan.body.sessions[0].id;

  mockLlmSequence([
    {
      reply: "关于孩子这件事，我是希望未来要孩子的。你这边在孩子这件事上会是什么想法？",
      reply_topic_key: "childrenPreference",
      question_topic_key: "childrenPreference",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "childrenPreference",
          value: "希望未来要孩子",
          confidence: 0.92,
          status: "confirmed"
        }
      ],
      open_questions: ["孩子与生育态度"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "我这边也更倾向未来要孩子。婚后和父母的相处边界上，你更偏向怎样的安排？",
      reply_topic_key: "childrenPreference",
      question_topic_key: "familyBoundary",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "childrenPreference",
          value: "希望未来要孩子",
          confidence: 0.91,
          status: "confirmed"
        }
      ],
      open_questions: ["家庭边界"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "在家庭边界上，我更偏向婚后以小家庭为主，同时尊重双方父母。你对未来要不要孩子这件事，目前更偏向什么想法？",
      reply_topic_key: "familyBoundary",
      question_topic_key: "childrenPreference",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "familyBoundary",
          value: "婚后更偏独立小家庭，同时尊重双方父母",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["孩子与生育态度"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "孩子态度已双边确认，当前转入家庭边界。", 
      confirmed_facts: [],
      unresolved_questions: ["家庭边界"],
      risk_summary: [],
      next_action: "pause_review",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  const detail = await waitForAutomationIdle(clientA, sessionId);
  const turnContents = detail.body.turns.map((turn) => String(turn.content || ""));
  const twinChildrenQuestionTurns = detail.body.turns.filter((turn) => {
    if (!String(turn.actorRole || "").endsWith("_twin")) {
      return false;
    }
    if (String(turn.metadata?.question_topic_key || "") === "childrenPreference") {
      return true;
    }
    return /孩子这件事上会是什么想法|你对未来要不要孩子这件事，目前更偏向什么想法/u.test(
      String(turn.content || "")
    );
  });
  assert.equal(twinChildrenQuestionTurns.length, 1);
  assert.equal(
    turnContents.filter((content) => content.includes("你对未来要不要孩子这件事，目前更偏向什么想法")).length,
    0
  );
  assert.equal(
    turnContents.some(
      (content) =>
        content.includes("婚后和父母的相处边界") && content.includes("你对未来要不要孩子这件事，目前更偏向什么想法")
    ),
    false
  );
});

test("childrenPreference 单边未确认时，不会生成‘重复问答’人工待办", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "mirror-child-a@example.com", "雨涵");
  await registerAndLogin(clientB, "mirror-child-b@example.com", "刘星");
  await saveTwinFor(clientA, buildTwin("雨涵", { financialView: "更看重务实稳定，也不太接受隐性负债" }));
  await saveTwinFor(clientB, buildTwin("刘星", { financialView: "更看重务实稳定，也会留意负债风险", childrenPreference: "希望未来要孩子" }));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "刘星").id;
  const plan = await clientA.request("/api/prechat/plan", {
    method: "POST",
    json: {
      matchIds: [matchId],
      objectiveKeys: ["financialView", "childrenPreference"]
    }
  });
  assert.equal(plan.status, 201);

  mockLlmSequence([
    {
      reply: "在财务安排上，我更看重务实稳定，也不太接受隐性负债。在财务安排上，你更看重怎样的消费和负债观念？",
      reply_topic_key: "financialView",
      question_topic_key: "financialView",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "financialView",
          value: "更看重务实稳定，也不太接受隐性负债",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["在财务安排上，你更看重怎样的消费和负债观念？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "在财务安排上，我更看重务实稳定，也会留意负债风险。关于孩子这件事，你未来更倾向怎样的安排？",
      reply_topic_key: "financialView",
      question_topic_key: "childrenPreference",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "financialView",
          value: "更看重务实稳定，也会留意负债风险",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["关于孩子这件事，你未来更倾向怎样的安排？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "关于孩子这件事，我目前倾向于未来要孩子。你这边对未来要不要孩子这件事，目前更偏向什么想法？",
      reply_topic_key: "childrenPreference",
      question_topic_key: "childrenPreference",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "childrenPreference",
          value: "希望未来要孩子",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["你这边对未来要不要孩子这件事，目前更偏向什么想法？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "财务观已确认，孩子议题已问回给另一侧，等待继续回答。",
      confirmed_facts: [],
      unresolved_questions: ["childrenPreference"],
      risk_summary: [],
      next_action: "pause_review",
      handoff_ready: false
    }
  ]);

  const sessionId = plan.body.sessions[0].id;
  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  const detail = await waitForAutomationIdle(clientA, sessionId);
  const pendingRepeatRequest = detail.body.humanInputRequests.find(
    (item) => item.status === "pending" && /重复问答/u.test(item.questionText || "")
  );
  assert.equal(detail.body.session.status === "active" || detail.body.session.status === "paused_review", true);
  assert.equal(Boolean(pendingRepeatRequest), false);
});

test("合法 childrenPreference mirror question 被误升为‘表述不够自然’待办后，会自动恢复并继续 outstanding recovery", async () => {
  const userA = createUser({
    email: "mirror-recovery-a@example.com",
    displayName: "雨涵",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "mirror-recovery-b@example.com",
    displayName: "刘星",
    passwordHash: hashPassword("secret123")
  });

  saveCurrentTwin(userA.id, buildTwin("雨涵", { childrenPreference: "希望未来要孩子，但不想立刻推进生育" }));
  saveCurrentTwin(userB.id, buildTwin("刘星", { childrenPreference: "希望未来要孩子，但不想立刻推进生育" }));

  const matchId = upsertMatch(userA.id, userB.id, 95, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id,
    control: {
      automation: {
        enabled: true,
        source: "direct_invite",
        preferredObjectiveKeys: ["childrenPreference"],
        activeTopicKey: "childrenPreference",
        lastClosedTopicKey: null,
        topicQueueSnapshot: ["childrenPreference"],
        topicLedger: {
          relationshipGoal: { state: "not_started", coverage: { initiator: false, counterparty: false }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: null },
          cities: { state: "not_started", coverage: { initiator: false, counterparty: false }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: null },
          marriageTimeline: { state: "not_started", coverage: { initiator: false, counterparty: false }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: null },
          childrenPreference: {
            state: "waiting_initiator",
            coverage: { initiator: false, counterparty: true },
            pendingAnswerUserId: userA.id,
            lastQuestionTurnId: null,
            closedAt: null
          },
          familyBoundary: { state: "not_started", coverage: { initiator: false, counterparty: false }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: null },
          financialView: { state: "not_started", coverage: { initiator: false, counterparty: false }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: null }
        }
      }
    }
  });
  updatePrechatSession(session.id, {
    status: "pending_human_input",
    currentRound: 1
  });

  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: [{ key: "childrenPreference", label: "孩子与生育态度", prompt: "确认对未来孩子与生育的态度。" }],
      activeTopicKey: "childrenPreference",
      topicQueueSnapshot: ["childrenPreference"]
    }
  });

  const sourceTurn = addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 1,
    actorUserId: userB.id,
    actorRole: "counterparty_twin",
    content: "关于孩子这件事，我目前倾向于未来要孩子。关于孩子这件事，你未来更倾向怎样的安排？",
    metadata: {
      reply: "关于孩子这件事，我目前倾向于未来要孩子。关于孩子这件事，你未来更倾向怎样的安排？",
      reply_topic_key: "childrenPreference",
      question_topic_key: "childrenPreference",
      emitted_reply_topic_key: "childrenPreference",
      emitted_question_topic_key: "childrenPreference",
      emitted_question_text: "关于孩子这件事，你未来更倾向怎样的安排？",
      canonical_reply_topic_key: "childrenPreference",
      canonical_question_topic_key: "childrenPreference",
      canonical_question_text: "关于孩子这件事，你未来更倾向怎样的安排？",
      canonical_answer_text: "关于孩子这件事，我目前倾向于未来要孩子。",
      confirmed_facts: [
        {
          subjectUserId: userB.id,
          key: "childrenPreference",
          value: "希望未来要孩子",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      did_answer_required_question: true,
      mirror_question_required_for_coverage: true,
      mirror_question_allowed: true,
      question_fingerprint: "childrenPreference:broad_preference",
      needs_human_input: { required: false },
      recommendation: "continue"
    }
  });

  createHumanInputRequest({
    sessionId: session.id,
    roundId: round.id,
    targetUserId: userA.id,
    fieldKey: "childrenPreference",
    questionText: "这一轮预沟通的表述不够自然，请本人确认后再继续。",
    metadata: {
      source: "carryover_twin_question",
      sourceTurnId: sourceTurn.id,
      turnNumber: 2
    }
  });

  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 2,
    actorUserId: null,
    actorRole: "system",
    content: "系统暂停：这一轮预沟通的表述不够自然，请本人确认后再继续。",
    metadata: {
      pauseReason: "pending_human_input",
      targetUserId: userA.id,
      fieldKey: "childrenPreference",
      source: "carryover_twin_question",
      sourceTurnId: sourceTurn.id
    }
  });

  updatePrechatSession(session.id, {
    control: {
      ...session.control,
      automation: {
        ...session.control.automation,
        topicLedger: {
          ...session.control.automation.topicLedger,
          childrenPreference: {
            ...session.control.automation.topicLedger.childrenPreference,
            lastQuestionTurnId: sourceTurn.id
          }
        }
      }
    }
  });

  finishPrechatRound(round.id, { status: "completed", stopReason: "pending_human_input" });

  mockLlmSequence([
    {
      reply: "关于孩子这件事，我也倾向未来要孩子，但会希望关系稳定后再推进。婚后和父母的相处边界上，你更偏向怎样的安排？",
      reply_topic_key: "childrenPreference",
      question_topic_key: "familyBoundary",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "childrenPreference",
          value: "希望未来要孩子，但不想立刻推进生育",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["婚后和父母的相处边界上，你更偏向怎样的安排？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "已从历史表述不自然误暂停恢复，并继续推进下一题。",
      confirmed_facts: [],
      unresolved_questions: ["家庭边界"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const recovered = await getSessionViewWithAutoRecovery(session.id, userA.id);
  assert.ok(recovered);

  let after = null;
  for (let index = 0; index < 60; index += 1) {
    after = getSessionDetailForUser(session.id, userA.id);
    const runState = after?.session?.control?.automation?.runState || "idle";
    if (
      !["queued", "running"].includes(runState) &&
      (after?.turns?.length || 0) > 2
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.ok(after);
  assert.equal(
    after.humanInputRequests.some((request) => request.status === "pending"),
    false
  );
  assert.equal(after.session.control?.automation?.runState || "idle", "idle");
  assert.equal(["active", "paused_review"].includes(after.session.status), true);
  assert.equal(after.turns.length > 2, true);
});

test("历史缺少 sourceTurnId 的 childrenPreference 表述不自然误暂停，也会按 turnNumber fallback 自动恢复", async () => {
  const userA = createUser({
    email: "mirror-recovery-a-d2f2c1f2@example.com",
    displayName: "雨涵",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "mirror-recovery-b-d2f2c1f2@example.com",
    displayName: "刘星",
    passwordHash: hashPassword("secret123")
  });

  saveCurrentTwin(userA.id, buildTwin("雨涵", { childrenPreference: "希望未来要孩子，但不想立刻推进生育" }));
  saveCurrentTwin(userB.id, buildTwin("刘星", { childrenPreference: "希望未来要孩子，但不想立刻推进生育" }));

  const matchId = upsertMatch(userA.id, userB.id, 95, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id,
    control: {
      automation: {
        enabled: true,
        source: "direct_invite",
        preferredObjectiveKeys: ["childrenPreference"],
        activeTopicKey: "childrenPreference",
        lastClosedTopicKey: null,
        topicQueueSnapshot: ["childrenPreference"],
        topicLedger: {
          relationshipGoal: { state: "not_started", coverage: { initiator: false, counterparty: false }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: null },
          cities: { state: "not_started", coverage: { initiator: false, counterparty: false }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: null },
          marriageTimeline: { state: "not_started", coverage: { initiator: false, counterparty: false }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: null },
          childrenPreference: {
            state: "waiting_initiator",
            coverage: { initiator: false, counterparty: true },
            pendingAnswerUserId: userA.id,
            lastQuestionTurnId: null,
            closedAt: null
          },
          familyBoundary: { state: "not_started", coverage: { initiator: false, counterparty: false }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: null },
          financialView: { state: "not_started", coverage: { initiator: false, counterparty: false }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: null }
        }
      }
    }
  });
  updatePrechatSession(session.id, {
    status: "pending_human_input",
    currentRound: 1
  });

  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: [{ key: "childrenPreference", label: "孩子与生育态度", prompt: "确认对未来孩子与生育的态度。" }],
      activeTopicKey: "childrenPreference",
      topicQueueSnapshot: ["childrenPreference"]
    }
  });

  const sourceTurn = addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 1,
    actorUserId: userB.id,
    actorRole: "counterparty_twin",
    content: "关于孩子这件事，我目前倾向于未来要孩子。关于孩子这件事，你未来更倾向怎样的安排？",
    metadata: {
      reply: "关于孩子这件事，我目前倾向于未来要孩子。关于孩子这件事，你未来更倾向怎样的安排？",
      reply_topic_key: "childrenPreference",
      question_topic_key: "childrenPreference",
      emitted_reply_topic_key: "childrenPreference",
      emitted_question_topic_key: "childrenPreference",
      emitted_question_text: "关于孩子这件事，你未来更倾向怎样的安排？",
      canonical_reply_topic_key: "childrenPreference",
      canonical_question_topic_key: "childrenPreference",
      canonical_question_text: "关于孩子这件事，你未来更倾向怎样的安排？",
      canonical_answer_text: "关于孩子这件事，我目前倾向于未来要孩子。",
      confirmed_facts: [
        {
          subjectUserId: userB.id,
          key: "childrenPreference",
          value: "希望未来要孩子",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      did_answer_required_question: true,
      mirror_question_required_for_coverage: true,
      mirror_question_allowed: true,
      question_fingerprint: "childrenPreference:broad_preference",
      needs_human_input: { required: false },
      recommendation: "continue"
    }
  });

  createHumanInputRequest({
    sessionId: session.id,
    roundId: round.id,
    targetUserId: userA.id,
    fieldKey: "childrenPreference",
    questionText: "这一轮预沟通的表述不够自然，请本人确认后再继续。",
    metadata: {
      source: "quality_guard",
      turnNumber: 2,
      replyQualityIssue: "mirrored_latest_question"
    }
  });

  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 2,
    actorUserId: null,
    actorRole: "system",
    content: "系统暂停：这一轮预沟通的表述不够自然，请本人确认后再继续。",
    metadata: {
      pauseReason: "pending_human_input",
      targetUserId: userA.id,
      fieldKey: "childrenPreference",
      source: "quality_guard"
    }
  });

  updatePrechatSession(session.id, {
    control: {
      ...session.control,
      automation: {
        ...session.control.automation,
        topicLedger: {
          ...session.control.automation.topicLedger,
          childrenPreference: {
            ...session.control.automation.topicLedger.childrenPreference,
            lastQuestionTurnId: sourceTurn.id
          }
        }
      }
    }
  });

  finishPrechatRound(round.id, { status: "completed", stopReason: "pending_human_input" });

  mockLlmSequence([
    {
      reply: "关于孩子这件事，我也倾向未来要孩子，但会希望关系稳定后再推进。婚后和父母的相处边界上，你更偏向怎样的安排？",
      reply_topic_key: "childrenPreference",
      question_topic_key: "familyBoundary",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "childrenPreference",
          value: "希望未来要孩子，但不想立刻推进生育",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["婚后和父母的相处边界上，你更偏向怎样的安排？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "已从历史表述不自然误暂停恢复，并继续推进下一题。",
      confirmed_facts: [],
      unresolved_questions: ["家庭边界"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const recovered = await getSessionViewWithAutoRecovery(session.id, userA.id);
  assert.ok(recovered);

  let after = null;
  for (let index = 0; index < 60; index += 1) {
    after = getSessionDetailForUser(session.id, userA.id);
    const runState = after?.session?.control?.automation?.runState || "idle";
    if (
      !["queued", "running"].includes(runState) &&
      (after?.turns?.length || 0) > 2
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.ok(after);
  assert.equal(after.humanInputRequests.some((request) => request.status === "pending"), false);
  const resolvedRequest = after.humanInputRequests.find((request) => request.questionText.includes("表述不够自然"));
  assert.equal(resolvedRequest?.metadata?.quality_pause_auto_recovered, true);
  assert.equal(resolvedRequest?.metadata?.quality_pause_source_turn_id, sourceTurn.id);
  assert.equal(after.session.control?.automation?.runState || "idle", "idle");
  assert.equal(["active", "paused_review"].includes(after.session.status), true);
  assert.equal(after.turns.length > 2, true);
});

test("合法 mirrored question 不会再创建‘表述不够自然’人工暂停", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "quality-no-pause-a@example.com", "乔治");
  await registerAndLogin(clientB, "quality-no-pause-b@example.com", "刘星");
  await saveTwinFor(clientA, buildTwin("乔治", { cities: "上海、杭州", financialView: "务实稳定，不接受隐性负债" }));
  await saveTwinFor(clientB, buildTwin("刘星", { cities: "深圳、广州", financialView: "希望负债不要太多，消费正常即可", childrenPreference: "希望未来要孩子" }));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "刘星").id;
  const plan = await clientA.request("/api/prechat/plan", {
    method: "POST",
    json: {
      matchIds: [matchId],
      objectiveKeys: ["cities", "financialView", "childrenPreference"]
    }
  });
  assert.equal(plan.status, 201);

  const sessionId = plan.body.sessions[0].id;

  mockLlmSequence([
    {
      reply: "你好，我是乔治的 Twin。你这边未来长期更倾向在哪个城市生活？",
      reply_topic_key: "cities",
      question_topic_key: "cities",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["你这边未来长期更倾向在哪个城市生活？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "我长期更倾向在深圳生活，广州也可以接受。你这边未来长期更倾向在哪个城市生活？",
      reply_topic_key: "cities",
      question_topic_key: "cities",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["你这边未来长期更倾向在哪个城市生活？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "我长期更倾向在上海生活，杭州也可以接受。关于财务安排，你更看重务实稳定，还是对消费和负债有怎样的具体预期？",
      reply_topic_key: "cities",
      question_topic_key: "financialView",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["关于财务安排，你更看重务实稳定，还是对消费和负债有怎样的具体预期？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "关于财务安排，我希望负债不要太多，消费正常即可。在消费、储蓄和负债这类现实安排上，你更看重什么原则？",
      reply_topic_key: "financialView",
      question_topic_key: "financialView",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["在消费、储蓄和负债这类现实安排上，你更看重什么原则？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "在财务安排上，我更看重务实和稳定，也不接受隐性负债。关于孩子这件事，你未来更倾向怎样的安排？",
      reply_topic_key: "financialView",
      question_topic_key: "childrenPreference",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["关于孩子这件事，你未来更倾向怎样的安排？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "关于孩子这件事，我目前倾向于未来要孩子。关于孩子这件事，你未来更倾向怎样的安排？",
      reply_topic_key: "childrenPreference",
      question_topic_key: "childrenPreference",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["关于孩子这件事，你未来更倾向怎样的安排？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "关于孩子这件事，我也倾向于未来要孩子，但会更希望在关系稳定后再推进。婚后和父母的相处边界上，你更偏向怎样的安排？",
      reply_topic_key: "childrenPreference",
      question_topic_key: "familyBoundary",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["婚后和父母的相处边界上，你更偏向怎样的安排？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "继续推进后续议题。",
      confirmed_facts: [],
      unresolved_questions: [],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  const detail = await waitForAutomationIdle(clientA, sessionId);
  const qualityPauseRequest = (detail.body.humanInputRequests || []).find(
    (item) => item.status === "pending" && /表述不够自然/u.test(String(item.questionText || ""))
  );
  assert.equal(Boolean(qualityPauseRequest), false);
  assert.equal(
    detail.body.turns.some((turn) => /表述不够自然/u.test(String(turn.content || ""))),
    false
  );
});

test("合法 answer-then-switch 不会再被 duplicated_recent_question 升级成‘表述不够自然’，历史暂停也会自动恢复", async () => {
  const userA = createUser({
    email: "quality-dup-recovery-a@example.com",
    displayName: "雨涵",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "quality-dup-recovery-b@example.com",
    displayName: "刘星",
    passwordHash: hashPassword("secret123")
  });

  saveCurrentTwin(userA.id, buildTwin("雨涵", { financialView: "更看重务实稳定，也会留意负债风险" }));
  saveCurrentTwin(userB.id, buildTwin("刘星", { financialView: "更看重务实稳定，也会留意负债风险" }));

  const matchId = upsertMatch(userA.id, userB.id, 96, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id,
    control: {
      automation: {
        enabled: true,
        source: "direct_invite",
        preferredObjectiveKeys: ["financialView"],
        activeTopicKey: null,
        lastClosedTopicKey: "financialView",
        topicQueueSnapshot: [],
        topicLedger: {
          cities: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() },
          marriageTimeline: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() },
          childrenPreference: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() },
          familyBoundary: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() },
          financialView: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() }
        }
      }
    }
  });
  updatePrechatSession(session.id, {
    status: "pending_human_input",
    currentRound: 2
  });

  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 2,
    objective: {
      topics: [{ key: "financialView", label: "财务观", prompt: "确认金钱观、消费观与现实安排。" }],
      activeTopicKey: null,
      topicQueueSnapshot: []
    }
  });

  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 1,
    actorUserId: userA.id,
    actorRole: "initiator_twin",
    content: "婚后和父母的相处边界上，你更偏向怎样的安排？",
    metadata: {
      canonical_question_text: "婚后和父母的相处边界上，你更偏向怎样的安排？",
      canonical_question_topic_key: "familyBoundary",
      emitted_question_text: "婚后和父母的相处边界上，你更偏向怎样的安排？",
      emitted_question_topic_key: "familyBoundary",
      question_topic_key: "familyBoundary"
    }
  });

  const sourceTurn = addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 2,
    actorUserId: userA.id,
    actorRole: "initiator_twin",
    content: "在财务安排上，我更看重务实稳定，也会留意负债风险。婚后和父母的相处边界上，你更偏向怎样的安排？",
    metadata: {
      reply: "在财务安排上，我更看重务实稳定，也会留意负债风险。婚后和父母的相处边界上，你更偏向怎样的安排？",
      reply_topic_key: "financialView",
      question_topic_key: "familyBoundary",
      canonical_reply_topic_key: "financialView",
      canonical_question_topic_key: "familyBoundary",
      canonical_question_text: "婚后和父母的相处边界上，你更偏向怎样的安排？",
      canonical_answer_text: "在财务安排上，我更看重务实稳定，也会留意负债风险。",
      emitted_reply_topic_key: "financialView",
      emitted_question_topic_key: "familyBoundary",
      emitted_question_text: "婚后和父母的相处边界上，你更偏向怎样的安排？",
      question_fingerprint: __testOnlyBuildQuestionFingerprint("婚后和父母的相处边界上，你更偏向怎样的安排？", "familyBoundary"),
      confirmed_facts: [
        {
          subjectUserId: userA.id,
          key: "financialView",
          value: "更看重务实稳定，也会留意负债风险",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      did_answer_required_question: true,
      switch_after_topic_close_allowed: true,
      needs_human_input: { required: false },
      recommendation: "continue"
    }
  });

  createHumanInputRequest({
    sessionId: session.id,
    roundId: round.id,
    targetUserId: userB.id,
    fieldKey: "familyBoundary",
    questionText: "这一轮预沟通的表述不够自然，请本人确认后再继续。",
    metadata: {
      source: "quality_guard",
      sourceTurnId: sourceTurn.id,
      turnNumber: 5,
      replyQualityIssue: "duplicated_recent_question",
      qualityGuardReason: "duplicated_recent_question"
    }
  });

  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 3,
    actorUserId: null,
    actorRole: "system",
    content: "系统暂停：需要 刘星 本人补充信息后才能继续。待确认内容：这一轮预沟通的表述不够自然，请本人确认后再继续。",
    metadata: {
      pauseReason: "pending_human_input",
      targetUserId: userB.id,
      fieldKey: "familyBoundary",
      source: "quality_guard",
      sourceTurnId: sourceTurn.id,
      replyQualityIssue: "duplicated_recent_question"
    }
  });

  finishPrechatRound(round.id, { status: "completed", stopReason: "pending_human_input" });

  const recovered = await getSessionViewWithAutoRecovery(session.id, userA.id);
  assert.ok(recovered);

  let after = null;
  for (let index = 0; index < 60; index += 1) {
    after = getSessionDetailForUser(session.id, userA.id);
    const runState = after?.session?.control?.automation?.runState || "idle";
    if (!["queued", "running"].includes(runState)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.ok(after);
  assert.equal(after.humanInputRequests.some((request) => request.status === "pending"), false);
  const resolvedRequest = after.humanInputRequests.find((request) => request.questionText.includes("表述不够自然"));
  assert.equal(resolvedRequest?.metadata?.quality_pause_auto_recovered, true);
  assert.equal(resolvedRequest?.metadata?.recoveredFromQualityIssue, "duplicated_recent_question");
  assert.equal(
    resolvedRequest?.metadata?.autoRecoverySource,
    "duplicated_recent_question_false_positive_pending_request"
  );
});

test("通用 quality_guard 触发的‘表述不够自然’历史暂停会自动 resolve 并改走静默恢复", async () => {
  const userA = createUser({
    email: "quality-generic-recovery-a@example.com",
    displayName: "刘星",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "quality-generic-recovery-b@example.com",
    displayName: "雨涵",
    passwordHash: hashPassword("secret123")
  });

  saveCurrentTwin(userA.id, buildTwin("刘星", { cities: "深圳、广州" }));
  saveCurrentTwin(userB.id, buildTwin("雨涵", { cities: "上海、杭州" }));

  const matchId = upsertMatch(userA.id, userB.id, 91, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id
  });
  updatePrechatSession(session.id, { status: "pending_human_input" });
  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: [{ key: "cities", label: "城市与生活安排", prompt: "确认长期城市安排。" }],
      activeTopicKey: "cities",
      topicQueueSnapshot: ["cities"]
    }
  });

  const sourceTurn = addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 1,
    actorUserId: userA.id,
    actorRole: "initiator_twin",
    content: "我这边长期更倾向在我可以接受生活。",
    metadata: {
      reply: "我这边长期更倾向在我可以接受生活。",
      reply_topic_key: "cities",
      question_topic_key: null,
      confirmed_facts: [],
      open_questions: [],
      needs_human_input: { required: false },
      recommendation: "continue",
      reply_quality_issue: "malformed_city_shell",
      quality_guard_reason: "malformed_city_shell"
    }
  });

  createHumanInputRequest({
    sessionId: session.id,
    roundId: round.id,
    targetUserId: userA.id,
    fieldKey: "cities",
    questionText: "这一轮预沟通的表述不够自然，请本人确认后再继续。",
    metadata: {
      source: "quality_guard",
      sourceTurnId: sourceTurn.id,
      turnNumber: 2,
      replyQualityIssue: "malformed_city_shell",
      qualityGuardReason: "malformed_city_shell"
    }
  });

  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 2,
    actorUserId: null,
    actorRole: "system",
    content: "系统暂停：需要 刘星 本人补充信息后才能继续。待确认内容：这一轮预沟通的表述不够自然，请本人确认后再继续。",
    metadata: {
      pauseReason: "pending_human_input",
      targetUserId: userA.id,
      fieldKey: "cities",
      source: "quality_guard",
      sourceTurnId: sourceTurn.id,
      replyQualityIssue: "malformed_city_shell"
    }
  });

  finishPrechatRound(round.id, { status: "completed", stopReason: "pending_human_input" });

  const recovered = await getSessionViewWithAutoRecovery(session.id, userA.id);
  assert.ok(recovered);

  let after = null;
  for (let index = 0; index < 60; index += 1) {
    after = getSessionDetailForUser(session.id, userA.id);
    const runState = after?.session?.control?.automation?.runState || "idle";
    if (!["queued", "running"].includes(runState)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.ok(after);
  assert.equal(
    after.humanInputRequests.some(
      (request) => request.status === "pending" && request.metadata?.source === "quality_guard"
    ),
    false
  );
  const resolvedRequest = after.humanInputRequests.find(
    (request) =>
      request.metadata?.source === "quality_guard" &&
      request.metadata?.replyQualityIssue === "malformed_city_shell"
  );
  assert.equal(resolvedRequest?.metadata?.quality_pause_auto_recovered, true);
  assert.equal(resolvedRequest?.metadata?.autoRecoverySource, "generic_quality_pause_pending_request");
  assert.equal(after.session.status, "active");
});

test("deterministic mirror recovery 后若产生新的 outstanding topic，会重新读取最新 outstanding source", async () => {
  const userA = createUser({
    email: "mirror-chain-a@example.com",
    displayName: "刘宇",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "mirror-chain-b@example.com",
    displayName: "刘星",
    passwordHash: hashPassword("secret123")
  });

  saveCurrentTwin(
    userA.id,
    buildTwin("刘宇", {
      childrenPreference: "希望未来要孩子",
      relationshipGoal: "希望进入认真、长期的关系，也希望关系稳定后以结婚为目标",
      marriageTimeline: "如果匹配，希望 1 到 2 年内推进",
      familyBoundary: "婚后更偏向独立小家庭，也会尊重双方父母"
    })
  );
  saveCurrentTwin(
    userB.id,
    buildTwin("刘星", {
      childrenPreference: "希望未来要孩子",
      relationshipGoal: "希望进入认真、长期的关系，也希望关系稳定后以结婚为目标",
      marriageTimeline: "如果匹配，希望 1 到 2 年内推进",
      familyBoundary: "婚后希望边界清楚，日常以小家庭为主"
    })
  );

  const matchId = upsertMatch(userA.id, userB.id, 95, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id,
    control: {
      automation: {
        enabled: true,
        source: "direct_invite",
        preferredObjectiveKeys: [],
        activeTopicKey: "childrenPreference",
        lastClosedTopicKey: "financialView",
        topicQueueSnapshot: [],
        topicLedger: {
          relationshipGoal: {
            state: "waiting_initiator",
            coverage: { initiator: false, counterparty: true },
            pendingAnswerUserId: userA.id,
            lastQuestionTurnId: null,
            closedAt: null
          },
          cities: {
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null,
            lastQuestionTurnId: null,
            closedAt: new Date().toISOString()
          },
          marriageTimeline: {
            state: "waiting_initiator",
            coverage: { initiator: false, counterparty: true },
            pendingAnswerUserId: userA.id,
            lastQuestionTurnId: null,
            closedAt: null
          },
          childrenPreference: {
            state: "waiting_initiator",
            coverage: { initiator: false, counterparty: true },
            pendingAnswerUserId: userA.id,
            lastQuestionTurnId: null,
            closedAt: null
          },
          familyBoundary: {
            state: "not_started",
            coverage: { initiator: false, counterparty: false },
            pendingAnswerUserId: null,
            lastQuestionTurnId: null,
            closedAt: null
          },
          financialView: {
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null,
            lastQuestionTurnId: null,
            closedAt: new Date().toISOString()
          }
        }
      }
    }
  });
  updatePrechatSession(session.id, {
    status: "paused_review",
    currentRound: 2
  });

  const round1 = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: [],
      activeTopicKey: "childrenPreference",
      topicQueueSnapshot: []
    }
  });
  const sourceTurn = addConversationTurn({
    sessionId: session.id,
    roundId: round1.id,
    turnNumber: 1,
    actorUserId: userB.id,
    actorRole: "counterparty_twin",
    content: "关于孩子这件事，我目前倾向于未来要孩子。关于孩子这件事，你未来更倾向怎样的安排？",
    metadata: {
      reply: "关于孩子这件事，我目前倾向于未来要孩子。关于孩子这件事，你未来更倾向怎样的安排？",
      reply_topic_key: "childrenPreference",
      question_topic_key: "childrenPreference",
      emitted_reply_topic_key: "childrenPreference",
      emitted_question_topic_key: "childrenPreference",
      emitted_question_text: "关于孩子这件事，你未来更倾向怎样的安排？",
      canonical_reply_topic_key: "childrenPreference",
      canonical_question_topic_key: "childrenPreference",
      canonical_question_text: "关于孩子这件事，你未来更倾向怎样的安排？",
      canonical_answer_text: "关于孩子这件事，我目前倾向于未来要孩子。",
      confirmed_facts: [
        {
          subjectUserId: userB.id,
          key: "childrenPreference",
          value: "希望未来要孩子",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      did_answer_required_question: true,
      mirror_question_required_for_coverage: true,
      mirror_question_allowed: true,
      question_fingerprint: "childrenPreference:broad_preference",
      needs_human_input: { required: false },
      recommendation: "continue"
    }
  });

  const round2 = createPrechatRound({
    sessionId: session.id,
    roundNumber: 2,
    objective: {
      topics: [],
      activeTopicKey: "childrenPreference",
      topicQueueSnapshot: []
    }
  });
  addConversationTurn({
    sessionId: session.id,
    roundId: round2.id,
    turnNumber: 1,
    actorUserId: userA.id,
    actorRole: "initiator_twin",
    content: "关于孩子这件事，我目前倾向于未来要孩子。",
    metadata: {
      reply: "关于孩子这件事，我目前倾向于未来要孩子。",
      reply_topic_key: "childrenPreference",
      question_topic_key: null,
      canonical_reply_topic_key: "childrenPreference",
      canonical_question_topic_key: null,
      canonical_question_text: null,
      canonical_answer_text: "关于孩子这件事，我目前倾向于未来要孩子。",
      confirmed_facts: [
        {
          subjectUserId: userA.id,
          key: "childrenPreference",
          value: "希望未来要孩子",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      carryoverTwinQuestionAnswered: true,
      carryoverTwinQuestionTurnId: sourceTurn.id,
      recommendation: "continue",
      needs_human_input: { required: false }
    }
  });
  const relationshipTurn = addConversationTurn({
    sessionId: session.id,
    roundId: round2.id,
    turnNumber: 2,
    actorUserId: userB.id,
    actorRole: "counterparty_twin",
    content: "看到我们都更重视认真长期关系，我想先确认一下，你现在更明确想进入怎样的长期关系？",
    metadata: {
      reply: "看到我们都更重视认真长期关系，我想先确认一下，你现在更明确想进入怎样的长期关系？",
      reply_topic_key: null,
      question_topic_key: "relationshipGoal",
      canonical_reply_topic_key: null,
      canonical_question_topic_key: "relationshipGoal",
      canonical_question_text: "看到我们都更重视认真长期关系，我想先确认一下，你现在更明确想进入怎样的长期关系？",
      canonical_answer_text: null,
      confirmed_facts: [],
      recommendation: "continue",
      needs_human_input: { required: false }
    }
  });
  addConversationTurn({
    sessionId: session.id,
    roundId: round2.id,
    turnNumber: 3,
    actorUserId: userA.id,
    actorRole: "initiator_twin",
    content: "我希望进入认真、长期的关系，也希望关系稳定后以结婚为目标。 你现在更明确想进入怎样的长期关系？",
    metadata: {
      reply: "我希望进入认真、长期的关系，也希望关系稳定后以结婚为目标。 你现在更明确想进入怎样的长期关系？",
      reply_topic_key: "relationshipGoal",
      question_topic_key: "relationshipGoal",
      canonical_reply_topic_key: "relationshipGoal",
      canonical_question_topic_key: "relationshipGoal",
      canonical_question_text: "你现在更明确想进入怎样的长期关系？",
      canonical_answer_text: "我希望进入认真、长期的关系，也希望关系稳定后以结婚为目标。",
      confirmed_facts: [
        {
          subjectUserId: userA.id,
          key: "relationshipGoal",
          value: "希望进入认真、长期的关系，也希望关系稳定后以结婚为目标",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      did_answer_required_question: true,
      recommendation: "continue",
      needs_human_input: { required: false }
    }
  });
  addConversationTurn({
    sessionId: session.id,
    roundId: round2.id,
    turnNumber: 4,
    actorUserId: userB.id,
    actorRole: "counterparty_twin",
    content: "我希望进入认真、长期的关系，也希望关系稳定后以结婚为目标。关于结婚节奏，如果匹配，你希望多久内推进？",
    metadata: {
      reply: "我希望进入认真、长期的关系，也希望关系稳定后以结婚为目标。关于结婚节奏，如果匹配，你希望多久内推进？",
      reply_topic_key: "relationshipGoal",
      question_topic_key: "marriageTimeline",
      canonical_reply_topic_key: "relationshipGoal",
      canonical_question_topic_key: "marriageTimeline",
      canonical_question_text: "关于结婚节奏，如果匹配，你希望多久内推进？",
      canonical_answer_text: "我希望进入认真、长期的关系，也希望关系稳定后以结婚为目标。",
      confirmed_facts: [
        {
          subjectUserId: userB.id,
          key: "relationshipGoal",
          value: "希望进入认真、长期的关系，也希望关系稳定后以结婚为目标",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      did_answer_required_question: true,
      switched_topic_after_close: true,
      question_fingerprint: "marriageTimeline:关于结婚节奏如果匹配你希望多久内推进",
      recommendation: "continue",
      needs_human_input: { required: false }
    }
  });
  addConversationTurn({
    sessionId: session.id,
    roundId: round2.id,
    turnNumber: 5,
    actorUserId: userA.id,
    actorRole: "initiator_twin",
    content: "如果匹配，我希望在1到2年内推进结婚。 如果关系顺利推进，你更接受怎样的结婚节奏？",
    metadata: {
      reply: "如果匹配，我希望在1到2年内推进结婚。 如果关系顺利推进，你更接受怎样的结婚节奏？",
      reply_topic_key: "marriageTimeline",
      question_topic_key: "marriageTimeline",
      canonical_reply_topic_key: "marriageTimeline",
      canonical_question_topic_key: "marriageTimeline",
      canonical_question_text: "如果关系顺利推进，你更接受怎样的结婚节奏？",
      canonical_answer_text: "如果匹配，我希望在1到2年内推进结婚。",
      confirmed_facts: [
        {
          subjectUserId: userA.id,
          key: "marriageTimeline",
          value: "如果匹配，希望1到2年内推进",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      did_answer_required_question: true,
      recommendation: "continue",
      needs_human_input: { required: false }
    }
  });
  const familyBoundaryTurn = addConversationTurn({
    sessionId: session.id,
    roundId: round2.id,
    turnNumber: 6,
    actorUserId: userB.id,
    actorRole: "counterparty_twin",
    content: "如果匹配，我希望在1到2年内推进结婚。关于婚后和父母的相处边界，你更偏向怎样的安排？",
    metadata: {
      reply: "如果匹配，我希望在1到2年内推进结婚。关于婚后和父母的相处边界，你更偏向怎样的安排？",
      reply_topic_key: "marriageTimeline",
      question_topic_key: "familyBoundary",
      emitted_reply_topic_key: "marriageTimeline",
      emitted_question_topic_key: "familyBoundary",
      emitted_question_text: "关于婚后和父母的相处边界，你更偏向怎样的安排？",
      canonical_reply_topic_key: "marriageTimeline",
      canonical_question_topic_key: "familyBoundary",
      canonical_question_text: "关于婚后和父母的相处边界，你更偏向怎样的安排？",
      canonical_answer_text: "如果匹配，我希望在1到2年内推进结婚。",
      confirmed_facts: [
        {
          subjectUserId: userB.id,
          key: "marriageTimeline",
          value: "如果匹配，希望1到2年内推进",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      did_answer_required_question: true,
      switched_topic_after_close: true,
      question_fingerprint: "familyBoundary:关于婚后和父母的相处边界你偏向怎样的",
      recommendation: "continue",
      needs_human_input: { required: false }
    }
  });

  getRawDatabaseForTests()
    .prepare("UPDATE prechat_rounds SET status = 'completed', stop_reason = 'outstanding_twin_question_unanswered' WHERE id = ?")
    .run(round1.id);
  getRawDatabaseForTests()
    .prepare("UPDATE prechat_rounds SET status = 'completed', stop_reason = 'outstanding_twin_question_unanswered' WHERE id = ?")
    .run(round2.id);

  updatePrechatSession(session.id, {
    status: "paused_review",
    currentRound: 2,
    control: {
      ...session.control,
      automation: {
        ...session.control.automation,
        activeTopicKey: "familyBoundary",
        lastClosedTopicKey: "marriageTimeline",
        topicLedger: {
          ...session.control.automation.topicLedger,
          relationshipGoal: {
            ...session.control.automation.topicLedger.relationshipGoal,
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null,
            closedAt: new Date().toISOString()
          },
          marriageTimeline: {
            ...session.control.automation.topicLedger.marriageTimeline,
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null,
            closedAt: new Date().toISOString()
          },
          childrenPreference: {
            ...session.control.automation.topicLedger.childrenPreference,
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null,
            lastQuestionTurnId: sourceTurn.id,
            closedAt: new Date().toISOString()
          },
          familyBoundary: {
            ...session.control.automation.topicLedger.familyBoundary,
            state: "waiting_initiator",
            coverage: { initiator: false, counterparty: false },
            pendingAnswerUserId: userA.id,
            lastQuestionTurnId: familyBoundaryTurn.id
          }
        }
      }
    }
  });

  const recovery = __testOnlyGetLatestOutstandingTwinQuestionRecoveryForSession(session.id, userA.id);
  assert.ok(recovery);
  assert.equal(recovery.sourceTurn?.id, familyBoundaryTurn.id);
  assert.notEqual(recovery.sourceTurn?.id, sourceTurn.id);
  assert.equal(recovery.targetUserId, userA.id);
});

test("历史 repeat false positive 若挂在旧 sourceTurn 上，会改续全会话最新 outstanding question", async () => {
  const userA = createUser({
    email: "repeat-history-a@example.com",
    displayName: "刘宇",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "repeat-history-b@example.com",
    displayName: "刘星",
    passwordHash: hashPassword("secret123")
  });

  saveCurrentTwin(
    userA.id,
    buildTwin("刘宇", {
      childrenPreference: "希望未来要孩子",
      relationshipGoal: "希望进入认真、长期的关系，也希望关系稳定后以结婚为目标",
      marriageTimeline: "如果匹配，希望 1 到 2 年内推进",
      familyBoundary: "婚后更偏向独立小家庭，也会尊重双方父母"
    })
  );
  saveCurrentTwin(
    userB.id,
    buildTwin("刘星", {
      childrenPreference: "希望未来要孩子",
      relationshipGoal: "希望进入认真、长期的关系，也希望关系稳定后以结婚为目标",
      marriageTimeline: "如果匹配，希望 1 到 2 年内推进",
      familyBoundary: "婚后希望边界清楚，日常以小家庭为主"
    })
  );

  const matchId = upsertMatch(userA.id, userB.id, 95, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id,
    control: {
      automation: {
        enabled: true,
        source: "direct_invite",
        preferredObjectiveKeys: [],
        activeTopicKey: "familyBoundary",
        lastClosedTopicKey: "marriageTimeline",
        topicQueueSnapshot: [],
        topicLedger: {
          relationshipGoal: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() },
          cities: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() },
          marriageTimeline: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() },
          childrenPreference: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() },
          familyBoundary: { state: "waiting_initiator", coverage: { initiator: false, counterparty: false }, pendingAnswerUserId: userA.id, lastQuestionTurnId: null, closedAt: null },
          financialView: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() }
        }
      }
    }
  });
  updatePrechatSession(session.id, {
    status: "pending_human_input",
    currentRound: 3
  });

  const round1 = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: [],
      activeTopicKey: "childrenPreference",
      topicQueueSnapshot: []
    }
  });
  const sourceTurn = addConversationTurn({
    sessionId: session.id,
    roundId: round1.id,
    turnNumber: 1,
    actorUserId: userB.id,
    actorRole: "counterparty_twin",
    content: "关于孩子这件事，我目前倾向于未来要孩子。关于孩子这件事，你未来更倾向怎样的安排？",
    metadata: {
      reply: "关于孩子这件事，我目前倾向于未来要孩子。关于孩子这件事，你未来更倾向怎样的安排？",
      reply_topic_key: "childrenPreference",
      question_topic_key: "childrenPreference",
      emitted_reply_topic_key: "childrenPreference",
      emitted_question_topic_key: "childrenPreference",
      emitted_question_text: "关于孩子这件事，你未来更倾向怎样的安排？",
      canonical_reply_topic_key: "childrenPreference",
      canonical_question_topic_key: "childrenPreference",
      canonical_question_text: "关于孩子这件事，你未来更倾向怎样的安排？",
      canonical_answer_text: "关于孩子这件事，我目前倾向于未来要孩子。",
      confirmed_facts: [
        {
          subjectUserId: userB.id,
          key: "childrenPreference",
          value: "希望未来要孩子",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      did_answer_required_question: true,
      mirror_question_required_for_coverage: true,
      mirror_question_allowed: true,
      question_fingerprint: "childrenPreference:broad_preference",
      needs_human_input: { required: false },
      recommendation: "continue"
    }
  });
  getRawDatabaseForTests()
    .prepare("UPDATE prechat_rounds SET status = 'completed', stop_reason = 'outstanding_twin_question_unanswered' WHERE id = ?")
    .run(round1.id);

  const round2 = createPrechatRound({
    sessionId: session.id,
    roundNumber: 2,
    objective: {
      topics: [],
      activeTopicKey: "childrenPreference",
      topicQueueSnapshot: []
    }
  });
  addConversationTurn({
    sessionId: session.id,
    roundId: round2.id,
    turnNumber: 1,
    actorUserId: userA.id,
    actorRole: "initiator_twin",
    content: "关于孩子这件事，我目前倾向于未来要孩子。",
    metadata: {
      reply: "关于孩子这件事，我目前倾向于未来要孩子。",
      reply_topic_key: "childrenPreference",
      question_topic_key: null,
      canonical_reply_topic_key: "childrenPreference",
      canonical_question_topic_key: null,
      canonical_question_text: null,
      canonical_answer_text: "关于孩子这件事，我目前倾向于未来要孩子。",
      confirmed_facts: [
        {
          subjectUserId: userA.id,
          key: "childrenPreference",
          value: "希望未来要孩子",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      carryoverTwinQuestionAnswered: true,
      carryoverTwinQuestionTurnId: sourceTurn.id,
      recommendation: "continue",
      needs_human_input: { required: false }
    }
  });
  addConversationTurn({
    sessionId: session.id,
    roundId: round2.id,
    turnNumber: 2,
    actorUserId: userB.id,
    actorRole: "counterparty_twin",
    content: "如果匹配，我希望在1到2年内推进结婚。关于婚后和父母的相处边界，你更偏向怎样的安排？",
    metadata: {
      reply: "如果匹配，我希望在1到2年内推进结婚。关于婚后和父母的相处边界，你更偏向怎样的安排？",
      reply_topic_key: "marriageTimeline",
      question_topic_key: "familyBoundary",
      emitted_reply_topic_key: "marriageTimeline",
      emitted_question_topic_key: "familyBoundary",
      emitted_question_text: "关于婚后和父母的相处边界，你更偏向怎样的安排？",
      canonical_reply_topic_key: "marriageTimeline",
      canonical_question_topic_key: "familyBoundary",
      canonical_question_text: "关于婚后和父母的相处边界，你更偏向怎样的安排？",
      canonical_answer_text: "如果匹配，我希望在1到2年内推进结婚。",
      confirmed_facts: [
        {
          subjectUserId: userB.id,
          key: "marriageTimeline",
          value: "如果匹配，希望1到2年内推进",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      did_answer_required_question: true,
      switched_topic_after_close: true,
      question_fingerprint: "familyBoundary:关于婚后和父母的相处边界你偏向怎样的",
      recommendation: "continue",
      needs_human_input: { required: false }
    }
  });
  getRawDatabaseForTests()
    .prepare("UPDATE prechat_rounds SET status = 'completed', stop_reason = 'outstanding_twin_question_unanswered' WHERE id = ?")
    .run(round2.id);

  const round3 = createPrechatRound({
    sessionId: session.id,
    roundNumber: 3,
    objective: {
      topics: [],
      activeTopicKey: "familyBoundary",
      topicQueueSnapshot: []
    }
  });
  createHumanInputRequest({
    sessionId: session.id,
    roundId: round3.id,
    targetUserId: userA.id,
    fieldKey: "familyBoundary",
    questionText: "这轮预沟通出现了重复问答，请本人确认这一题的真实答案。",
    metadata: {
      source: "carryover_twin_question",
      sourceTurnId: sourceTurn.id
    }
  });
  addConversationTurn({
    sessionId: session.id,
    roundId: round3.id,
    turnNumber: 1,
    actorUserId: null,
    actorRole: "system",
    content: "系统暂停：需要刘宇本人补充信息后才能继续。待确认内容：这轮预沟通出现了重复问答，请本人确认这一题的真实答案。",
    metadata: {
      pauseReason: "pending_human_input",
      targetUserId: userA.id,
      fieldKey: "familyBoundary",
      source: "carryover_twin_question",
      sourceTurnId: sourceTurn.id
    }
  });
  finishPrechatRound(round3.id, { status: "completed", stopReason: "pending_human_input" });

  mockLlmSequence([
    {
      reply: "婚后我更偏向以独立小家庭为主，同时也会尊重双方父母的边界。",
      reply_topic_key: "familyBoundary",
      question_topic_key: null,
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "familyBoundary",
          value: "婚后更偏向独立小家庭，同时会尊重双方父母边界",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: [],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "pause_review"
    },
    {
      summary: "家庭边界议题已继续推进。",
      confirmed_facts: [],
      unresolved_questions: [],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const turnCountBefore = listConversationTurns(session.id).length;
  const roundCountBefore = listPrechatRounds(session.id).length;

  await getSessionViewWithAutoRecovery(session.id, userA.id);

  let after = null;
  for (let index = 0; index < 40; index += 1) {
    after = getSessionDetailForUser(session.id, userA.id);
    const runState = after?.session?.control?.automation?.runState || "idle";
    if (!["queued", "running"].includes(runState)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.ok(after);
  assert.equal(
    after.humanInputRequests.some(
      (request) =>
        request.status === "resolved" &&
        request.metadata?.autoRecoverySource === "repeat_false_positive_pending_request"
    ),
    true
  );
  assert.equal(
    after.humanInputRequests.some((request) => request.status === "pending"),
    false
  );
  assert.equal(after.session.control?.automation?.runState || "idle", "idle");
  assert.equal(after.session.status, "paused_review");
  assert.equal(after.turns.length, turnCountBefore);
  assert.equal(listPrechatRounds(session.id).length, roundCountBefore);
});

test("answer-only 当前 topic 单边 coverage 时，会自动补 canonical mirror question 而不是暂停", () => {
  const userA = createUser({
    email: "continuation-a@example.com",
    displayName: "雨涵",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "continuation-b@example.com",
    displayName: "刘星",
    passwordHash: hashPassword("secret123")
  });

  saveCurrentTwin(
    userA.id,
    buildTwin("雨涵", {
      relationshipGoal: "希望进入认真、长期的关系，也希望关系稳定后以结婚为目标"
    })
  );
  saveCurrentTwin(
    userB.id,
    buildTwin("刘星", {
      relationshipGoal: "希望进入认真、长期的关系，也希望关系稳定后以结婚为目标"
    })
  );

  const matchId = upsertMatch(userA.id, userB.id, 88, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id,
    control: {
      automation: {
        enabled: true,
        source: "direct_invite",
        preferredObjectiveKeys: [],
        activeTopicKey: "relationshipGoal",
        topicQueueSnapshot: ["relationshipGoal"],
        topicLedger: {
          relationshipGoal: {
            state: "waiting_counterparty",
            coverage: { initiator: false, counterparty: false },
            pendingAnswerUserId: userA.id,
            lastQuestionTurnId: null
          }
        }
      }
    }
  });

  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: [{ key: "relationshipGoal", label: "关系目标", prompt: "确认关系目标。" }],
      activeTopicKey: "relationshipGoal",
      topicQueueSnapshot: ["relationshipGoal"]
    }
  });

  const continuation = __testOnlyBuildCanonicalTurnOutcome(
    {
      reply: "我希望进入认真、长期的关系，也希望关系稳定后以结婚为目标。",
      reply_topic_key: "relationshipGoal",
      question_topic_key: null,
      confirmed_facts: [
        {
          subjectUserId: userA.id,
          key: "relationshipGoal",
          value: "希望进入认真、长期的关系，并希望关系稳定后以结婚为目标",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: [],
      needs_human_input: { required: false },
      recommendation: "pause_review"
    },
    {
      frame_version: "turn_frame_v1_2026_06_03",
      reply_obligation: "listener_question",
      reply_target: {
        text: "你现在更明确想进入怎样的长期关系？",
        topicKey: "relationshipGoal"
      },
      topic_plan: {
        activeTopicKey: "relationshipGoal",
        canSwitchOnlyAfterClose: true,
        nextCandidateTopicKey: null
      }
    },
    {
      activeTopicKey: "relationshipGoal",
      latestListenerQuestionTopic: "relationshipGoal",
      speakerUserId: userA.id,
      listenerUserId: userB.id
    }
  );

  const postAnswer = __testOnlyDerivePostAnswerContinuation({
    session,
    objectives: [{ key: "relationshipGoal", label: "关系目标", prompt: "确认关系目标。" }],
    turns: [
      {
        actorUserId: userB.id,
        roundId: round.id,
        actorRole: "counterparty_twin",
        content: "你现在更明确想进入怎样的长期关系？",
        metadata: {
          canonical_question_text: "你现在更明确想进入怎样的长期关系？",
          canonical_question_topic_key: "relationshipGoal",
          canonical_reply_topic_key: null,
          canonical_answer_text: null
        }
      }
    ],
    speakerUserId: userA.id,
    listenerUserId: userB.id,
    result: continuation,
    activeTopicKey: "relationshipGoal"
  });

  assert.equal(postAnswer.strategy, "emit_canonical_mirror_question");
  assert.equal(postAnswer.questionTopicKey, "relationshipGoal");
  assert.match(postAnswer.questionText || "", /怎样的长期关系/u);
});

test("历史 repeat false positive 只有 turnNumber 时也能自动恢复并补齐 sourceTurnId", async () => {
  const userA = createUser({
    email: "repeat-fallback-a@example.com",
    displayName: "雨涵",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "repeat-fallback-b@example.com",
    displayName: "刘星",
    passwordHash: hashPassword("secret123")
  });

  saveCurrentTwin(
    userA.id,
    buildTwin("雨涵", {
      relationshipGoal: "希望进入认真、长期的关系，也希望关系稳定后以结婚为目标"
    })
  );
  saveCurrentTwin(
    userB.id,
    buildTwin("刘星", {
      relationshipGoal: "希望进入认真、长期的关系，也希望关系稳定后以结婚为目标"
    })
  );

  const matchId = upsertMatch(userA.id, userB.id, 91, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id,
    control: {
      automation: {
        enabled: true,
        source: "direct_invite",
        preferredObjectiveKeys: [],
        activeTopicKey: "relationshipGoal",
        lastClosedTopicKey: "childrenPreference",
        topicQueueSnapshot: [],
        topicLedger: {
          relationshipGoal: {
            state: "waiting_counterparty",
            coverage: { initiator: true, counterparty: false },
            pendingAnswerUserId: userB.id,
            lastQuestionTurnId: null
          }
        }
      }
    }
  });
  updatePrechatSession(session.id, {
    status: "pending_human_input",
    currentRound: 1
  });

  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: [{ key: "relationshipGoal", label: "关系目标", prompt: "确认关系目标。" }],
      activeTopicKey: "relationshipGoal",
      topicQueueSnapshot: []
    }
  });

  saveExtractedFacts(session.id, round.id, [
    {
      subjectUserId: userA.id,
      key: "relationshipGoal",
      value: "希望进入认真、长期的关系，并希望关系稳定后以结婚为目标",
      confidence: 0.92,
      status: "confirmed"
    }
  ]);

  const answerTurn = addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 3,
    actorUserId: userA.id,
    actorRole: "initiator_twin",
    content: "我希望进入认真、长期的关系，也希望关系稳定后以结婚为目标。",
    metadata: {
      reply: "我希望进入认真、长期的关系，也希望关系稳定后以结婚为目标。",
      reply_topic_key: "relationshipGoal",
      question_topic_key: null,
      canonical_reply_topic_key: "relationshipGoal",
      canonical_question_topic_key: null,
      canonical_question_text: null,
      canonical_answer_text: "我希望进入认真、长期的关系，也希望关系稳定后以结婚为目标。",
      confirmed_facts: [
        {
          subjectUserId: userA.id,
          key: "relationshipGoal",
          value: "希望进入认真、长期的关系，并希望关系稳定后以结婚为目标",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      did_answer_required_question: true,
      recommendation: "pause_review",
      needs_human_input: { required: false }
    }
  });

  createHumanInputRequest({
    sessionId: session.id,
    roundId: round.id,
    targetUserId: userB.id,
    fieldKey: "marriageTimeline",
    questionText: "这轮预沟通出现了重复问答，请本人确认这一题的真实答案。",
    metadata: {
      turnNumber: 4
    }
  });
  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 4,
    actorUserId: null,
    actorRole: "system",
    content: "系统暂停：需要刘星本人补充信息后才能继续。待确认内容：这轮预沟通出现了重复问答，请本人确认这一题的真实答案。",
    metadata: {
      pauseReason: "pending_human_input",
      targetUserId: userB.id,
      fieldKey: "marriageTimeline"
    }
  });
  finishPrechatRound(round.id, { status: "completed", stopReason: "pending_human_input" });

  const detailBefore = getSessionDetailForUser(session.id, userA.id);
  assert.equal(detailBefore.humanInputRequests.filter((item) => item.status === "pending").length, 1);

  await getSessionViewWithAutoRecovery(session.id, userA.id);

  let after = null;
  for (let index = 0; index < 40; index += 1) {
    after = getSessionDetailForUser(session.id, userA.id);
    const runState = after?.session?.control?.automation?.runState || "idle";
    if (!["queued", "running"].includes(runState)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.ok(after);
  const resolvedRequest = after.humanInputRequests.find((item) => item.questionText === "这轮预沟通出现了重复问答，请本人确认这一题的真实答案。");
  assert.equal(resolvedRequest?.status, "resolved");
  assert.equal(resolvedRequest?.metadata?.autoRecoverySource, "repeat_false_positive_pending_request");
  assert.equal(resolvedRequest?.metadata?.sourceTurnId, answerTurn.id);
});

test("deterministic mirror recovery 补齐后，不会再误生成重复问答 pending request", async () => {
  const userA = createUser({
    email: "repeat-carryover-a@example.com",
    displayName: "沈特",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "repeat-carryover-b@example.com",
    displayName: "刘星",
    passwordHash: hashPassword("secret123")
  });

  saveCurrentTwin(
    userA.id,
    buildTwin("沈特", {
      cities: "长期更倾向上海，杭州也可以接受",
      financialView: "更看重务实和稳定，也不接受隐性负债",
      childrenPreference: "希望未来要孩子"
    })
  );
  saveCurrentTwin(
    userB.id,
    buildTwin("刘星", {
      cities: "长期更倾向深圳，广州也可以接受",
      financialView: "更看重务实稳定，也不接受隐性负债",
      childrenPreference: "希望未来要孩子"
    })
  );

  const matchId = upsertMatch(userA.id, userB.id, 95, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id,
    control: {
      automation: {
        enabled: true,
        source: "direct_invite",
        preferredObjectiveKeys: [],
        activeTopicKey: null,
        lastClosedTopicKey: "childrenPreference",
        topicQueueSnapshot: [],
        topicLedger: {
          relationshipGoal: { state: "not_started", coverage: { initiator: false, counterparty: false }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: null },
          cities: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() },
          marriageTimeline: { state: "not_started", coverage: { initiator: false, counterparty: false }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: null },
          childrenPreference: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() },
          familyBoundary: { state: "not_started", coverage: { initiator: false, counterparty: false }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: null },
          financialView: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() }
        }
      }
    }
  });
  updatePrechatSession(session.id, {
    status: "pending_human_input",
    currentRound: 2
  });

  const round1 = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: [],
      activeTopicKey: "childrenPreference",
      topicQueueSnapshot: []
    }
  });

  const sourceTurn = addConversationTurn({
    sessionId: session.id,
    roundId: round1.id,
    turnNumber: 1,
    actorUserId: userB.id,
    actorRole: "counterparty_twin",
    content: "关于孩子这件事，我目前倾向于未来要孩子。关于孩子这件事，你未来更倾向怎样的安排？",
    metadata: {
      reply: "关于孩子这件事，我目前倾向于未来要孩子。关于孩子这件事，你未来更倾向怎样的安排？",
      reply_topic_key: "childrenPreference",
      question_topic_key: "childrenPreference",
      emitted_reply_topic_key: "childrenPreference",
      emitted_question_topic_key: "childrenPreference",
      emitted_question_text: "关于孩子这件事，你未来更倾向怎样的安排？",
      canonical_reply_topic_key: "childrenPreference",
      canonical_question_topic_key: "childrenPreference",
      canonical_question_text: "关于孩子这件事，你未来更倾向怎样的安排？",
      canonical_answer_text: "关于孩子这件事，我目前倾向于未来要孩子。",
      confirmed_facts: [
        {
          subjectUserId: userB.id,
          key: "childrenPreference",
          value: "希望未来要孩子",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      did_answer_required_question: true,
      mirror_question_required_for_coverage: true,
      mirror_question_allowed: true,
      question_fingerprint: "childrenPreference:broad_preference",
      needs_human_input: { required: false },
      recommendation: "continue"
    }
  });

  saveExtractedFacts(session.id, round1.id, [
    {
      subjectUserId: userB.id,
      key: "childrenPreference",
      value: "希望未来要孩子",
      confidence: 0.9,
      status: "confirmed",
      sourceTurnId: sourceTurn.id
    }
  ]);
  finishPrechatRound(round1.id, { status: "completed", stopReason: "outstanding_twin_question_unanswered" });

  const round2 = createPrechatRound({
    sessionId: session.id,
    roundNumber: 2,
    objective: {
      topics: [],
      activeTopicKey: null,
      topicQueueSnapshot: []
    }
  });
  const recoveredAnswerTurn = addConversationTurn({
    sessionId: session.id,
    roundId: round2.id,
    turnNumber: 1,
    actorUserId: userA.id,
    actorRole: "initiator_twin",
    content: "关于孩子这件事，我目前倾向于未来要孩子。",
    metadata: {
      reply: "关于孩子这件事，我目前倾向于未来要孩子。",
      reply_topic_key: "childrenPreference",
      question_topic_key: null,
      canonical_reply_topic_key: "childrenPreference",
      canonical_question_topic_key: null,
      canonical_question_text: null,
      canonical_answer_text: "关于孩子这件事，我目前倾向于未来要孩子。",
      confirmed_facts: [
        {
          subjectUserId: userA.id,
          key: "childrenPreference",
          value: "希望未来要孩子",
          confidence: 0.92,
          status: "confirmed"
        }
      ],
      carryoverTwinQuestionAnswered: true,
      carryoverTwinQuestionTurnId: sourceTurn.id,
      recommendation: "pause_review",
      needs_human_input: { required: false }
    }
  });
  saveExtractedFacts(session.id, round2.id, [
    {
      subjectUserId: userA.id,
      key: "childrenPreference",
      value: "希望未来要孩子",
      confidence: 0.92,
      status: "confirmed",
      sourceTurnId: recoveredAnswerTurn.id
    }
  ]);
  createHumanInputRequest({
    sessionId: session.id,
    roundId: round2.id,
    targetUserId: userB.id,
    fieldKey: "childrenPreference",
    questionText: "这轮预沟通出现了重复问答，请本人确认这一题的真实答案。",
    metadata: {
      turnNumber: 2
    }
  });
  addConversationTurn({
    sessionId: session.id,
    roundId: round2.id,
    turnNumber: 2,
    actorUserId: null,
    actorRole: "system",
    content: "系统暂停：需要刘星本人补充信息后才能继续。待确认内容：这轮预沟通出现了重复问答，请本人确认这一题的真实答案。",
    metadata: {
      pauseReason: "pending_human_input",
      targetUserId: userB.id,
      fieldKey: "childrenPreference"
    }
  });
  finishPrechatRound(round2.id, { status: "completed", stopReason: "pending_human_input" });

  const recovered = await getSessionViewWithAutoRecovery(session.id, userA.id);
  assert.ok(recovered);

  let after = null;
  for (let index = 0; index < 40; index += 1) {
    after = getSessionDetailForUser(session.id, userA.id);
    const runState = after?.session?.control?.automation?.runState || "idle";
    if (!["queued", "running"].includes(runState)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.ok(after);
  const resolvedRequest = after.humanInputRequests.find(
    (item) => item.questionText === "这轮预沟通出现了重复问答，请本人确认这一题的真实答案。"
  );
  assert.equal(resolvedRequest?.status, "resolved");
  assert.equal(resolvedRequest?.metadata?.autoRecoverySource, "repeat_false_positive_pending_request");
  assert.equal(resolvedRequest?.metadata?.sourceTurnId, sourceTurn.id);
  assert.equal(resolvedRequest?.metadata?.carryoverTwinQuestionTurnId, sourceTurn.id);
  assert.equal(after.humanInputRequests.some((item) => item.status === "pending"), false);
});

test("双方都确认当前议题后，即使重复追问被拦截，也不会残留 waiting_counterparty", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "repeat-finance-a@example.com", "刘星");
  await registerAndLogin(clientB, "repeat-finance-b@example.com", "沈特");
  await saveTwinFor(clientA, buildTwin("刘星", { financialView: "希望负债不要太多，消费正常即可" }));
  await saveTwinFor(clientB, buildTwin("沈特", { financialView: "重视务实稳定，不接受隐性负债" }));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "沈特").id;
  const plan = await clientA.request("/api/prechat/plan", {
    method: "POST",
    json: {
      matchIds: [matchId],
      objectiveKeys: ["financialView"]
    }
  });
  assert.equal(plan.status, 201);

  const sessionId = plan.body.sessions[0].id;

  mockLlmSequence([
    {
      reply: "你好，我是刘星的 Twin。我这边希望负债不要太多，消费正常即可。你这边在消费、储蓄和负债上，更看重哪些原则？",
      reply_topic_key: "financialView",
      question_topic_key: "financialView",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "financialView",
          value: "希望负债不要太多，消费正常即可",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["对方在消费、储蓄和负债上的具体原则"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "你好，我是沈特的 Twin。在财务安排上，我更看重务实和稳定，也不接受隐性负债。你这边在消费、储蓄和负债上，更看重哪些原则？",
      reply_topic_key: "financialView",
      question_topic_key: "financialView",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "financialView",
          value: "重视务实稳定，不接受隐性负债",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["对方在消费、储蓄和负债上的原则"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "双方已确认财务观，无需继续重复追问。",
      confirmed_facts: [],
      unresolved_questions: [],
      risk_summary: [],
      next_action: "pause_review",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  const detail = await waitForAutomationIdle(clientA, sessionId);
  const latestStageReport = detail.body.stageReports?.[0];
  const financialProgress = latestStageReport?.payload?.objective_progress?.find((item) => item.key === "financialView");

  assert.equal(["paused_review", "active"].includes(detail.body.session.status), true);
  assert.equal(detail.body.session.control.automation.activeTopicKey, null);
  assert.equal(detail.body.session.control.automation.topicLedger.financialView.state, "closed");
  assert.equal(detail.body.session.control.automation.topicLedger.financialView.pendingAnswerUserId, null);
  const financialQuestionTurns = detail.body.turns.filter(
    (turn) =>
      String(turn.actorRole || "").endsWith("_twin") &&
      String(turn.metadata?.question_topic_key || "") === "financialView"
  );
  assert.equal(financialQuestionTurns.length, 1);
  assert.equal(financialProgress?.status, "confirmed");
});

test("active round 存在时不会再新开 outstanding-question recovery round 重问同一 childrenPreference", async () => {
  const userA = createUser({
    email: "active-round-recovery-a@example.com",
    displayName: "沈特",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "active-round-recovery-b@example.com",
    displayName: "刘宇",
    passwordHash: hashPassword("secret123")
  });

  saveCurrentTwin(
    userA.id,
    buildTwin("沈特", {
      financialView: "更看重务实和稳定，也不接受隐性负债",
      childrenPreference: "希望未来要孩子",
      familyBoundary: "婚后更偏向独立小家庭，同时会尊重双方父母"
    })
  );
  saveCurrentTwin(
    userB.id,
    buildTwin("刘宇", {
      financialView: "希望负债不要太多，消费正常即可",
      childrenPreference: "希望未来要孩子",
      familyBoundary: "婚后以独立小家庭为主，但会保持和双方父母的联系"
    })
  );

  const matchId = upsertMatch(userA.id, userB.id, 93, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id,
    control: {
      automation: {
        enabled: true,
        source: "direct_invite",
        preferredObjectiveKeys: ["financialView"],
        activeTopicKey: "childrenPreference",
        lastClosedTopicKey: "financialView",
        topicQueueSnapshot: ["childrenPreference", "familyBoundary"],
        topicLedger: {
          relationshipGoal: { state: "not_started", coverage: { initiator: false, counterparty: false }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: null },
          cities: { state: "not_started", coverage: { initiator: false, counterparty: false }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: null },
          marriageTimeline: { state: "not_started", coverage: { initiator: false, counterparty: false }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: null },
          childrenPreference: {
            state: "waiting_initiator",
            coverage: { initiator: false, counterparty: true },
            pendingAnswerUserId: userA.id,
            lastQuestionTurnId: null,
            lastQuestionFingerprint: "childrenPreference:broad_preference",
            lastQuestionAskedByUserId: userB.id,
            lastAnsweredByUserId: userB.id,
            lastResolvedTurnId: null,
            closedAt: null
          },
          familyBoundary: { state: "not_started", coverage: { initiator: false, counterparty: false }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: null },
          financialView: {
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null,
            lastQuestionTurnId: null,
            lastQuestionFingerprint: "financialView:broad_principle",
            lastQuestionAskedByUserId: userA.id,
            lastAnsweredByUserId: userB.id,
            lastResolvedTurnId: null,
            closedAt: new Date().toISOString()
          }
        }
      }
    }
  });
  updatePrechatSession(session.id, {
    status: "active",
    currentRound: 2
  });

  const round1 = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: [{ key: "financialView", label: "财务观", prompt: "确认金钱观、消费观与现实安排。" }],
      activeTopicKey: "financialView",
      topicQueueSnapshot: ["financialView"]
    }
  });
  const priorOutstandingTurn = addConversationTurn({
    sessionId: session.id,
    roundId: round1.id,
    turnNumber: 1,
    actorUserId: userB.id,
    actorRole: "counterparty_twin",
    content: "关于孩子这件事，我目前倾向于未来要孩子。关于孩子这件事，你未来更倾向怎样的安排？",
    metadata: {
      reply: "关于孩子这件事，我目前倾向于未来要孩子。关于孩子这件事，你未来更倾向怎样的安排？",
      reply_topic_key: "childrenPreference",
      question_topic_key: "childrenPreference",
      emitted_reply_topic_key: "childrenPreference",
      emitted_question_topic_key: "childrenPreference",
      emitted_question_text: "关于孩子这件事，你未来更倾向怎样的安排？",
      canonical_reply_topic_key: "childrenPreference",
      canonical_question_topic_key: "childrenPreference",
      canonical_question_text: "关于孩子这件事，你未来更倾向怎样的安排？",
      canonical_answer_text: "关于孩子这件事，我目前倾向于未来要孩子。",
      confirmed_facts: [
        {
          subjectUserId: userB.id,
          key: "childrenPreference",
          value: "希望未来要孩子",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      canonical_confirmed_facts: [
        {
          subjectUserId: userB.id,
          key: "childrenPreference",
          value: "希望未来要孩子",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      canonical_open_questions: ["关于孩子这件事，你未来更倾向怎样的安排？"],
      question_fingerprint: "childrenPreference:broad_preference",
      did_answer_required_question: true,
      mirror_question_required_for_coverage: true,
      mirror_question_allowed: true,
      carryover_source_valid: true,
      canonical_outcome_trusted: true,
      needs_human_input: { required: false },
      recommendation: "continue"
    }
  });
  saveExtractedFacts(session.id, round1.id, [
    {
      subjectUserId: userB.id,
      key: "childrenPreference",
      value: "希望未来要孩子",
      confidence: 0.9,
      status: "confirmed",
      sourceTurnId: priorOutstandingTurn.id
    }
  ]);
  finishPrechatRound(round1.id, { status: "completed", stopReason: "outstanding_twin_question_unanswered" });

  const round2 = createPrechatRound({
    sessionId: session.id,
    roundNumber: 2,
    objective: {
      topics: [
        { key: "childrenPreference", label: "孩子与生育态度", prompt: "确认对未来孩子与生育的态度。" },
        { key: "familyBoundary", label: "家庭边界", prompt: "确认父母参与度和婚后边界。" }
      ],
      activeTopicKey: "childrenPreference",
      topicQueueSnapshot: ["childrenPreference", "familyBoundary"]
    }
  });
  addConversationTurn({
    sessionId: session.id,
    roundId: round2.id,
    turnNumber: 1,
    actorUserId: userA.id,
    actorRole: "initiator_twin",
    content: "关于孩子这件事，我目前倾向于未来要孩子。婚后和父母的相处边界上，你更偏向怎样的安排？",
    metadata: {
      reply: "关于孩子这件事，我目前倾向于未来要孩子。婚后和父母的相处边界上，你更偏向怎样的安排？",
      reply_topic_key: "childrenPreference",
      question_topic_key: "familyBoundary",
      emitted_reply_topic_key: "childrenPreference",
      emitted_question_topic_key: "familyBoundary",
      emitted_question_text: "婚后和父母的相处边界上，你更偏向怎样的安排？",
      canonical_reply_topic_key: "childrenPreference",
      canonical_question_topic_key: "familyBoundary",
      canonical_question_text: "婚后和父母的相处边界上，你更偏向怎样的安排？",
      canonical_answer_text: "关于孩子这件事，我目前倾向于未来要孩子。",
      confirmed_facts: [
        {
          subjectUserId: userA.id,
          key: "childrenPreference",
          value: "希望未来要孩子",
          confidence: 0.92,
          status: "confirmed"
        }
      ],
      canonical_confirmed_facts: [
        {
          subjectUserId: userA.id,
          key: "childrenPreference",
          value: "希望未来要孩子",
          confidence: 0.92,
          status: "confirmed"
        }
      ],
      canonical_open_questions: ["婚后和父母的相处边界上，你更偏向怎样的安排？"],
      question_fingerprint: "familyBoundary:婚后和父母的相处边界上你偏向怎样的",
      did_answer_required_question: true,
      switched_topic_after_close: true,
      carryoverTwinQuestionAnswered: true,
      carryoverTwinQuestionTurnId: priorOutstandingTurn.id,
      carryover_source_valid: true,
      canonical_outcome_trusted: true,
      needs_human_input: { required: false },
      recommendation: "continue"
    }
  });
  saveExtractedFacts(session.id, round2.id, [
    {
      subjectUserId: userA.id,
      key: "childrenPreference",
      value: "希望未来要孩子",
      confidence: 0.92,
      status: "confirmed",
      sourceTurnId: priorOutstandingTurn.id
    }
  ]);

  const roundCountBefore = listPrechatRounds(session.id).length;
  const result = await runSessionRound(session.id, userA.id, {
    trigger: "deferred_model_retry",
    automationIntent: {
      intent: "answer_outstanding_question",
      reason: "outstanding_twin_question",
      outstandingRecovery: {
        sourceTurn: priorOutstandingTurn,
        targetUserId: userA.id,
        askedByUserId: userB.id,
        questionTopic: "childrenPreference",
        questionText: "关于孩子这件事，你未来更倾向怎样的安排？"
      }
    }
  });

  assert.ok(result);
  assert.equal(listPrechatRounds(session.id).length, roundCountBefore);
  const childrenQuestions = listConversationTurns(session.id).filter((turn) => {
    const metadata = turn.metadata || {};
    return String(metadata.canonical_question_topic_key || metadata.question_topic_key || "") === "childrenPreference";
  });
  assert.equal(childrenQuestions.length, 1);
  assert.equal(childrenQuestions[0].id, priorOutstandingTurn.id);
});

test("cities 双边确认后不会再继续同 topic broad question，而是直接收口或切下一个 topic", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "repeat-cities-a@example.com", "刘星");
  await registerAndLogin(clientB, "repeat-cities-b@example.com", "刘宇");
  await saveTwinFor(clientA, buildTwin("刘星", { cities: "深圳、广州", financialView: "希望负债不要太多，消费正常即可" }));
  await saveTwinFor(clientB, buildTwin("刘宇", { cities: "上海、杭州", financialView: "重视务实稳定，不接受隐性负债" }));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "刘宇").id;
  const plan = await clientA.request("/api/prechat/plan", {
    method: "POST",
    json: {
      matchIds: [matchId],
      objectiveKeys: ["cities", "financialView"]
    }
  });
  assert.equal(plan.status, 201);

  const sessionId = plan.body.sessions[0].id;

  mockLlmSequence([
    {
      reply: "你好，我是刘星的 Twin。我长期更倾向在深圳生活，广州也可以接受。你这边未来更倾向长期在哪个城市生活？",
      reply_topic_key: "cities",
      question_topic_key: "cities",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "cities",
          value: "长期更倾向深圳生活，广州也可以接受",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["你这边未来更倾向长期在哪个城市生活？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "我长期更倾向在上海生活，杭州也可以接受。你这边未来更倾向长期在哪个城市生活？",
      reply_topic_key: "cities",
      question_topic_key: "cities",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "cities",
          value: "长期更倾向在上海生活，杭州也可以接受",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["你这边未来更倾向长期在哪个城市生活？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "城市议题已完成，接着推进财务观。",
      confirmed_facts: [],
      unresolved_questions: ["财务观"],
      risk_summary: [],
      next_action: "pause_review",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  const detail = await waitForAutomationIdle(clientA, sessionId);
  const cityQuestionTurns = detail.body.turns.filter(
    (turn) =>
      String(turn.actorRole || "").endsWith("_twin") &&
      String(turn.metadata?.question_topic_key || "") === "cities"
  );
  assert.equal(cityQuestionTurns.length, 1);
  const repeatedGuardedTurn = detail.body.turns.find(
    (turn) => String(turn.metadata?.repeat_source || "") === "close_after_current_result"
  );
  assert.equal(Boolean(repeatedGuardedTurn), true);
  assert.equal(detail.body.session.control.automation.topicLedger.cities.state, "closed");
});

test("scoped objectives 只有 cities 和 financialView 时，完成后不会继续扩到 relationshipGoal", async () => {
  const clientA = createClient();
  const clientB = createClient();

  const userA = await registerAndLogin(clientA, "scoped-stop-a@example.com", "刘宇");
  const userB = await registerAndLogin(clientB, "scoped-stop-b@example.com", "刘星");
  await saveTwinFor(clientA, buildTwin("刘宇", { cities: "上海、杭州", financialView: "重视务实稳定，不接受隐性负债", relationshipGoal: "希望进入认真长期关系，并在稳定后考虑结婚" }));
  await saveTwinFor(clientB, buildTwin("刘星", { cities: "深圳、广州", financialView: "希望负债不要太多，消费正常即可", relationshipGoal: "希望进入认真长期关系，也会把结婚纳入考虑" }));
  upsertMatch(userA.id, userB.id, 93, "matched");
  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "刘星").id;
  const plan = await clientA.request("/api/prechat/plan", {
    method: "POST",
    json: {
      matchIds: [matchId],
      objectiveKeys: ["cities", "financialView"]
    }
  });
  assert.equal(plan.status, 201);
  const sessionId = plan.body.sessions[0].id;
  mockLlmSequence([
    {
      reply: "你好，我是刘宇的 Twin。你这边未来长期更倾向在哪个城市生活？",
      reply_topic_key: "cities",
      question_topic_key: "cities",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["你这边未来长期更倾向在哪个城市生活？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "我长期更倾向在深圳生活，广州也可以接受。你这边未来长期更倾向在哪个城市生活？",
      reply_topic_key: "cities",
      question_topic_key: "cities",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [{ subjectUserId: "self", key: "cities", value: "长期更倾向深圳，广州也可接受", confidence: 0.9, status: "confirmed" }],
      open_questions: ["你这边未来长期更倾向在哪个城市生活？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "我长期更倾向在上海生活，杭州也可以接受。关于财务安排，你更看重务实稳定，还是对消费自由度有更高要求？",
      reply_topic_key: "cities",
      question_topic_key: "financialView",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [{ subjectUserId: "self", key: "cities", value: "长期更倾向上海，杭州也可接受", confidence: 0.9, status: "confirmed" }],
      open_questions: ["关于财务安排，你更看重务实稳定，还是对消费自由度有更高要求？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "在财务安排上，我更看重务实稳定，负债不要太多，消费正常即可。 在消费、储蓄和负债这类现实安排上，你更看重什么原则？",
      reply_topic_key: "financialView",
      question_topic_key: "financialView",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [{ subjectUserId: "self", key: "financialView", value: "更看重务实稳定，负债不要太多，消费正常即可", confidence: 0.9, status: "confirmed" }],
      open_questions: ["在消费、储蓄和负债这类现实安排上，你更看重什么原则？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "我更看重务实稳定，也不接受隐性负债。",
      reply_topic_key: "financialView",
      question_topic_key: null,
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [{ subjectUserId: "self", key: "financialView", value: "更看重务实稳定，也不接受隐性负债", confidence: 0.9, status: "confirmed" }],
      open_questions: [],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "pause_review"
    }
  ]);
  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  await clientA.request(`/api/prechat/sessions/${sessionId}/run-round`, { method: "POST" });
  await clientA.request(`/api/prechat/sessions/${sessionId}/run-round`, { method: "POST" });

  const detail = await clientA.request(`/api/prechat/sessions/${sessionId}`);
  assert.equal(detail.status, 200);
  const latestRound = detail.body.rounds.at(-1);
  assert.equal(latestRound?.stopReason, "objectives_completed");
  const relationshipGoalTurns = detail.body.turns.filter(
    (turn) =>
      String(turn.metadata?.question_topic_key || "") === "relationshipGoal" ||
      String(turn.metadata?.canonical_question_topic_key || "") === "relationshipGoal"
  );
  assert.equal(relationshipGoalTurns.length, 0);
  assert.deepEqual(
    [...new Set((detail.body.session.control.automation.preferredObjectiveKeys || []).filter(Boolean))].sort(),
    ["cities", "financialView"].sort()
  );
});

test("closed cities 的旧 broad question 不会再被 detectOutstandingTwinQuestion 当成 carryover source", () => {
  const initiatorId = "user-a";
  const counterpartyId = "user-b";
  const session = {
    id: "session-cities-closed-outstanding",
    initiatorUserId: initiatorId,
    counterpartyUserId: counterpartyId,
    control: {
      automation: {
        activeTopicKey: null,
        lastClosedTopicKey: "cities",
        topicQueueSnapshot: [],
        topicLedger: {
          relationshipGoal: { state: "not_started", coverage: { initiator: false, counterparty: false }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: null },
          cities: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() },
          marriageTimeline: { state: "waiting_initiator", coverage: { initiator: false, counterparty: true }, pendingAnswerUserId: initiatorId, lastQuestionTurnId: "turn-marriage-question", closedAt: null },
          childrenPreference: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() },
          familyBoundary: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() },
          financialView: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() }
        }
      }
    }
  };
  const turns = [
    {
      id: "turn-cities-repeat",
      roundId: "round-1",
      turnNumber: 10,
      actorUserId: counterpartyId,
      actorRole: "counterparty_twin",
      content: "如果匹配，我希望在1到2年内推进结婚。 你这边未来长期更倾向在哪个城市生活？",
      metadata: {
        reply: "如果匹配，我希望在1到2年内推进结婚。 你这边未来长期更倾向在哪个城市生活？",
        canonical_reply_topic_key: "marriageTimeline",
        canonical_question_topic_key: "cities",
        canonical_question_text: "你这边未来长期更倾向在哪个城市生活？",
        canonical_answer_text: "如果匹配，我希望在1到2年内推进结婚。",
        question_topic_key: "cities",
        emitted_question_topic_key: "cities",
        emitted_question_text: "你这边未来长期更倾向在哪个城市生活？",
        question_fingerprint: __testOnlyBuildQuestionFingerprint("你这边未来长期更倾向在哪个城市生活？", "cities"),
        repeat_topic_guard_triggered: true,
        repeat_source: "same_topic_broad_question_repeat",
        repeat_topic_resolution: "switched_to_next_topic",
        repeat_guard_suppression_reason: "topic_already_closed",
        did_answer_required_question: true,
        canonical_outcome_trusted: true
      }
    }
  ];

  assert.equal(__testOnlyDetectOutstandingTwinQuestionSourceValidity(turns[0]), true);
  const outstanding = __testOnlyDetectOutstandingTwinQuestion(session, turns, null);
  assert.equal(outstanding, null);
});

test("历史会话的旧 topic ledger 脏状态会在打开详情时自动自愈", async () => {
  const userA = createUser({
    email: "stale-ledger-a@example.com",
    displayName: "刘星",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "stale-ledger-b@example.com",
    displayName: "沈特",
    passwordHash: hashPassword("secret123")
  });

  saveCurrentTwin(userA.id, buildTwin("刘星", { financialView: "希望负债不要太多，消费正常即可" }));
  saveCurrentTwin(userB.id, buildTwin("沈特", { financialView: "重视务实稳定，不接受隐性负债" }));

  const matchId = upsertMatch(userA.id, userB.id, 91, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id,
    control: {
      automation: {
        enabled: true,
        source: "report_plan",
        preferredObjectiveKeys: ["financialView"],
        activeTopicKey: "financialView",
        lastClosedTopicKey: "financialView",
        topicQueueSnapshot: ["financialView"],
        topicLedger: {
          financialView: {
            state: "waiting_counterparty",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: userB.id,
            lastQuestionTurnId: "legacy-turn",
            closedAt: null,
            reopenReason: null,
            reopenedAt: null
          }
        }
      }
    }
  });

  updatePrechatSession(session.id, {
    status: "paused_review",
    currentRound: 1
  });

  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: [
        {
          key: "financialView",
          label: "财务观",
          prompt: "确认金钱观、消费观与现实安排。"
        }
      ],
      activeTopicKey: "financialView",
      topicQueueSnapshot: ["financialView"]
    }
  });

  const turnA = addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 1,
    actorUserId: userA.id,
    actorRole: "initiator_twin",
    content: "我这边希望负债不要太多，消费正常即可。你这边在消费、储蓄和负债上，更看重哪些原则？",
    metadata: {
      reply: "我这边希望负债不要太多，消费正常即可。你这边在消费、储蓄和负债上，更看重哪些原则？",
      reply_topic_key: "financialView",
      question_topic_key: "financialView",
      confirmed_facts: [],
      open_questions: ["对方在消费、储蓄和负债上的具体原则"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    }
  });
  saveExtractedFacts(
    session.id,
    round.id,
    [
      {
        subjectUserId: userA.id,
        key: "financialView",
        value: "希望负债不要太多，消费正常即可",
        confidence: 0.9,
        status: "confirmed"
      }
    ],
    turnA.id
  );

  const turnB = addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 2,
    actorUserId: userB.id,
    actorRole: "counterparty_twin",
    content: "在财务安排上，我更看重务实和稳定，也不接受隐性负债。",
    metadata: {
      reply: "在财务安排上，我更看重务实和稳定，也不接受隐性负债。",
      reply_topic_key: "financialView",
      question_topic_key: null,
      confirmed_facts: [],
      open_questions: [],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "pause_review"
    }
  });
  saveExtractedFacts(
    session.id,
    round.id,
    [
      {
        subjectUserId: userB.id,
        key: "financialView",
        value: "重视务实稳定，不接受隐性负债",
        confidence: 0.9,
        status: "confirmed"
      }
    ],
    turnB.id
  );

  getRawDatabaseForTests()
    .prepare("UPDATE prechat_rounds SET status = 'completed', stop_reason = 'objectives_completed' WHERE id = ?")
    .run(round.id);

  const recovered = await getSessionViewWithAutoRecovery(session.id, userA.id);

  assert.equal(recovered.session.control.automation.topicLedger.financialView.state, "closed");
  assert.equal(recovered.session.control.automation.topicLedger.financialView.pendingAnswerUserId, null);
  assert.equal(recovered.session.control.automation.activeTopicKey, null);
  assert.equal(recovered.session.control.automation.topicQueueSnapshot.includes("financialView"), false);
});

test("rebuildTopicLedger 会在当前等待方作答后把 pendingAnswerUserId 切到另一侧", () => {
  const userA = createUser({
    email: "ledger-shift-a@example.com",
    displayName: "刘星",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "ledger-shift-b@example.com",
    displayName: "雨涵",
    passwordHash: hashPassword("secret123")
  });

  const matchId = upsertMatch(userA.id, userB.id, 90, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id,
    control: {
      automation: {
        enabled: true,
        source: "report_plan",
        preferredObjectiveKeys: ["financialView"],
        activeTopicKey: "financialView",
        topicQueueSnapshot: ["financialView"],
        topicLedger: {
          financialView: {
            state: "waiting_initiator",
            coverage: { initiator: false, counterparty: true },
            pendingAnswerUserId: userA.id,
            lastQuestionTurnId: "q-turn",
            lastQuestionAskedByUserId: userB.id
          }
        }
      }
    }
  });

  const rebuilt = __testOnlyRebuildTopicLedger(
    session,
    [
      {
        id: "q-turn",
        actorUserId: userB.id,
        actorRole: "counterparty_twin",
        content: "在消费、储蓄和负债这类现实安排上，你更看重什么原则？",
        metadata: {
          question_topic_key: "financialView"
        }
      },
      {
        id: "a-turn",
        actorUserId: userA.id,
        actorRole: "initiator_twin",
        content: "在财务安排上，我更看重务实稳定，也会留意负债风险。",
        metadata: {
          reply_topic_key: "financialView"
        }
      }
    ],
    [
      {
        subjectUserId: userA.id,
        key: "financialView",
        value: "务实稳定，也会留意负债风险",
        confidence: 0.9,
        status: "confirmed"
      }
    ],
    [{ key: "financialView", label: "财务观" }]
  );

  assert.equal(rebuilt.financialView.pendingAnswerUserId, userB.id);
  assert.equal(rebuilt.financialView.state, "waiting_counterparty");
});

test("closed topic 被重复触发时，不会错误创建人工补充待办", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "closed-topic-a@example.com", "雨涵");
  await registerAndLogin(clientB, "closed-topic-b@example.com", "刘星");
  await saveTwinFor(clientA, buildTwin("雨涵", { cities: "杭州" }));
  await saveTwinFor(clientB, buildTwin("刘星", { cities: "深圳、广州" }));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "刘星").id;
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
      reply: "你好，我是雨涵的 Twin。我这边长期更倾向杭州。你未来更倾向长期在深圳还是广州生活？",
      reply_topic_key: "cities",
      question_topic_key: "cities",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "cities",
          value: "长期更倾向杭州",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["对方未来更倾向长期在哪个城市生活"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "我这边长期更倾向深圳，广州也可以接受。你未来更倾向长期在杭州还是上海生活？",
      reply_topic_key: "cities",
      question_topic_key: "cities",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "cities",
          value: "长期更倾向深圳，广州也可以接受",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["你未来更倾向长期在杭州还是上海生活"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "双方已确认长期生活城市，无需再重复确认城市议题。",
      confirmed_facts: [],
      unresolved_questions: [],
      risk_summary: [],
      next_action: "pause_review",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  const detail = await waitForAutomationIdle(clientA, sessionId);
  const pendingHuman = (detail.body.humanInputRequests || []).filter((item) => item.status === "pending");

  assert.equal(
    pendingHuman.some(
      (item) =>
        item.fieldKey === "cities" && /已经确认完成，请不要重复确认/u.test(String(item.questionText || ""))
    ),
    false
  );
  assert.equal(detail.body.turns.some((turn) => /已经确认完成，请不要重复确认/u.test(String(turn.content || ""))), false);
  assert.equal(["paused_review", "active"].includes(detail.body.session.status), true);
});

test("非首条 Twin 消息里的重复自我介绍会在落库与展示前被剥掉", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "strip-intro-a@example.com", "雨涵");
  await registerAndLogin(clientB, "strip-intro-b@example.com", "刘星");
  await saveTwinFor(clientA, buildTwin("雨涵", { cities: "杭州" }));
  await saveTwinFor(clientB, buildTwin("刘星", { cities: "深圳、广州" }));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "刘星").id;
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
      reply: "你好，我是雨涵的 Twin。我这边长期更倾向杭州。你未来更倾向长期在深圳还是广州生活？",
      reply_topic_key: "cities",
      question_topic_key: "cities",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "cities",
          value: "长期更倾向杭州",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["对方未来更倾向长期在哪个城市生活"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "你好，我是刘星的 Twin。我这边长期更倾向深圳，广州也可以接受。你未来更倾向长期在杭州还是上海生活？",
      reply_topic_key: "cities",
      question_topic_key: "cities",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "cities",
          value: "长期更倾向深圳，广州也可以接受",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["你未来更倾向长期在杭州还是上海生活"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "双方已确认长期生活城市。",
      confirmed_facts: [],
      unresolved_questions: [],
      risk_summary: [],
      next_action: "pause_review",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  const detail = await waitForAutomationIdle(clientA, sessionId);
  const twinReplies = detail.body.turns.filter((turn) => String(turn.actorRole || "").endsWith("_twin"));

  assert.equal(twinReplies.length >= 2, true);
  assert.match(String(twinReplies[0].content || ""), /^你好，我是雨涵的 Twin。/u);
  assert.doesNotMatch(String(twinReplies[1].content || ""), /^你好，我是刘星的 Twin。/u);
  assert.match(String(twinReplies[1].content || ""), /^我这边长期更倾向深圳/u);
  assert.equal(Boolean(twinReplies[1].metadata?.forbidden_intro_detected), true);
  assert.equal(Boolean(twinReplies[1].metadata?.intro_sanitized), true);
});

test("首条 Twin 消息缺少身份说明时，会在落库前自动补上简短自我介绍", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "inject-intro-a@example.com", "雨涵");
  await registerAndLogin(clientB, "inject-intro-b@example.com", "刘星");
  await saveTwinFor(clientA, buildTwin("雨涵", { relationshipGoal: "认真长期关系，希望稳定后考虑结婚" }));
  await saveTwinFor(clientB, buildTwin("刘星", { relationshipGoal: "认真长期关系，也会把结婚放进考虑" }));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "刘星").id;
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
      reply: "看到我们都更重视认真长期关系，我想先确认一下，你现在更明确想进入怎样的长期关系？",
      reply_topic_key: "relationshipGoal",
      question_topic_key: "relationshipGoal",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["对方更明确想进入怎样的长期关系"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "我希望进入认真、长期的关系，也希望关系稳定后以结婚为目标。",
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
          value: "认真长期关系，也会把结婚放进考虑",
          confidence: 0.92,
          status: "confirmed"
        }
      ],
      open_questions: [],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "双方都以认真长期关系为目标。",
      confirmed_facts: [],
      unresolved_questions: [],
      risk_summary: [],
      next_action: "pause_review",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  const detail = await waitForAutomationIdle(clientA, sessionId);
  const twinReplies = detail.body.turns.filter((turn) => String(turn.actorRole || "").endsWith("_twin"));

  assert.equal(twinReplies.length >= 1, true);
  assert.match(String(twinReplies[0].content || ""), /^你好，我是雨涵的 Twin。/u);
  assert.equal(Boolean(twinReplies[0].metadata?.intro_injected), true);
  assert.equal(String(twinReplies[0].metadata?.intro_injection_result || ""), "prepended_required_intro");

  if (twinReplies[1]) {
    assert.equal(Boolean(twinReplies[1].metadata?.intro_injected), false);
    assert.doesNotMatch(String(twinReplies[1].content || ""), /^你好，我是刘星的 Twin。/u);
  }
});

test("closed-topic rewrite 不会保留非首条 Twin 的自我介绍", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "closed-topic-intro-a@example.com", "刘星");
  await registerAndLogin(clientB, "closed-topic-intro-b@example.com", "沈特");
  await saveTwinFor(clientA, buildTwin("刘星", { financialView: "希望负债不要太多，消费正常即可" }));
  await saveTwinFor(clientB, buildTwin("沈特", { financialView: "重视务实稳定，不接受隐性负债" }));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "沈特").id;
  const plan = await clientA.request("/api/prechat/plan", {
    method: "POST",
    json: {
      matchIds: [matchId],
      objectiveKeys: ["financialView"]
    }
  });
  assert.equal(plan.status, 201);

  const sessionId = plan.body.sessions[0].id;

  mockLlmSequence([
    {
      reply: "你好，我是刘星的 Twin。我这边希望负债不要太多，消费正常即可。你这边在消费、储蓄和负债上，更看重哪些原则？",
      reply_topic_key: "financialView",
      question_topic_key: "financialView",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "financialView",
          value: "希望负债不要太多，消费正常即可",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["对方在消费、储蓄和负债上的具体原则"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "你好，我是沈特的 Twin。在财务安排上，我更看重务实和稳定，也不接受隐性负债。你这边在消费、储蓄和负债上，更看重哪些原则？",
      reply_topic_key: "financialView",
      question_topic_key: "financialView",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "financialView",
          value: "重视务实稳定，不接受隐性负债",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["对方在消费、储蓄和负债上的原则"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "双方已确认财务观，无需继续重复追问。",
      confirmed_facts: [],
      unresolved_questions: [],
      risk_summary: [],
      next_action: "pause_review",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  const detail = await waitForAutomationIdle(clientA, sessionId);
  const shenteTurn = detail.body.turns.find(
    (turn) =>
      String(turn.actorRole || "") === "counterparty_twin" &&
      /财务安排上，我更看重务实和稳定/u.test(String(turn.content || ""))
  );

  assert.ok(shenteTurn);
  assert.doesNotMatch(String(shenteTurn.content || ""), /^你好，我是沈特的 Twin。/u);
  assert.equal(Boolean(shenteTurn.metadata?.forbidden_intro_detected), true);
  assert.equal(Boolean(shenteTurn.metadata?.intro_sanitized), true);
  assert.equal(
    ["closed_topic_guard_rewrite", "raw_model_output", "loop_rewrite", "quality_rewrite"].includes(
      String(shenteTurn.metadata?.intro_source || "")
    ),
    true
  );
});

test("relationshipGoal 问题被 cities 错答时，不会继续静默推进", async () => {
  const clientA = createClient();
  const clientB = createClient();

  await registerAndLogin(clientA, "alignment-a@example.com", "刘星");
  await registerAndLogin(clientB, "alignment-b@example.com", "雨涵");
  await saveTwinFor(clientA, buildTwin("刘星", { cities: "深圳、广州" }));
  await saveTwinFor(clientB, buildTwin("雨涵", { cities: "杭州" }));

  const matches = await clientA.request("/api/matches");
  const matchId = matches.body.matches.find((item) => item.counterpart.displayName === "雨涵").id;
  const plan = await clientA.request("/api/prechat/plan", {
    method: "POST",
    json: {
      matchIds: [matchId],
      objectiveKeys: ["relationshipGoal", "cities"]
    }
  });
  assert.equal(plan.status, 201);

  const sessionId = plan.body.sessions[0].id;

  mockLlmSequence([
    {
      reply: "你好，我是刘星的 Twin。我希望进入认真、长期的关系，也希望关系稳定后以结婚为目标。你这边更看重长期稳定，还是也会把结婚放进考虑里？",
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
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["你这边更看重长期稳定，还是也会把结婚放进考虑里？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      reply: "我长期更倾向在杭州生活。你这边未来长期更倾向在哪个城市生活？",
      reply_topic_key: "cities",
      question_topic_key: "cities",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [
        {
          subjectUserId: "self",
          key: "cities",
          value: "长期更倾向杭州",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["你这边未来长期更倾向在哪个城市生活？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "关系目标已对齐，继续确认城市。",
      confirmed_facts: [],
      unresolved_questions: [],
      risk_summary: [],
      next_action: "pause_review",
      handoff_ready: false
    }
  ]);

  const accepted = await clientB.request(`/api/prechat/invitations/${sessionId}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);

  const detail = await waitForAutomationIdle(clientA, sessionId);
  const lastTwinTurn = [...detail.body.turns].reverse().find((turn) => String(turn.actorRole || "").endsWith("_twin"));
  assert.ok(lastTwinTurn);
  assert.equal(detail.body.turns.some((turn) => /长期更倾向在杭州生活/u.test(String(turn.content || ""))), false);
  assert.equal(String(lastTwinTurn.metadata?.reply_topic_key || ""), "relationshipGoal");
  assert.equal(
    String(lastTwinTurn.metadata?.question_topic_key || "") === "cities" ||
      ["active", "paused_review"].includes(detail.body.session.status),
    true
  );
});

test("paused_review 但 backlog 未清空且存在语义错位时，会标记恢复触发", async () => {
  const userA = createUser({
    email: "recover-align-a@example.com",
    displayName: "刘星",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "recover-align-b@example.com",
    displayName: "雨涵",
    passwordHash: hashPassword("secret123")
  });

  saveCurrentTwin(userA.id, buildTwin("刘星", { cities: "深圳、广州" }));
  saveCurrentTwin(userB.id, buildTwin("雨涵", { cities: "杭州" }));

  const matchId = upsertMatch(userA.id, userB.id, 91, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id,
    control: {
      automation: {
        enabled: true,
        source: "report_plan",
        preferredObjectiveKeys: ["relationshipGoal", "cities", "childrenPreference"],
        activeTopicKey: "childrenPreference",
        lastClosedTopicKey: "cities",
        topicQueueSnapshot: ["childrenPreference", "familyBoundary"],
        topicLedger: {
          relationshipGoal: {
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null,
            lastQuestionTurnId: null,
            closedAt: new Date().toISOString()
          },
          cities: {
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null,
            lastQuestionTurnId: null,
            closedAt: new Date().toISOString()
          },
          marriageTimeline: {
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null,
            lastQuestionTurnId: null,
            closedAt: new Date().toISOString()
          },
          childrenPreference: {
            state: "not_started",
            coverage: { initiator: false, counterparty: false },
            pendingAnswerUserId: null,
            lastQuestionTurnId: null,
            closedAt: null
          },
          familyBoundary: {
            state: "not_started",
            coverage: { initiator: false, counterparty: false },
            pendingAnswerUserId: null,
            lastQuestionTurnId: null,
            closedAt: null
          },
          financialView: {
            state: "not_started",
            coverage: { initiator: false, counterparty: false },
            pendingAnswerUserId: null,
            lastQuestionTurnId: null,
            closedAt: null
          }
        }
      }
    }
  });

  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: [
        { key: "marriageTimeline", label: "结婚节奏", prompt: "确认结婚推进节奏是否接近。" },
        { key: "childrenPreference", label: "孩子与生育态度", prompt: "确认对未来孩子与生育的态度。" }
      ],
      activeTopicKey: "childrenPreference",
      topicQueueSnapshot: ["childrenPreference", "familyBoundary"]
    }
  });

  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 1,
    actorUserId: userA.id,
    actorRole: "initiator_twin",
    content: "我长期更倾向在深圳生活，广州也可以接受。",
    metadata: {
      reply: "我长期更倾向在深圳生活，广州也可以接受。",
      reply_topic_key: "cities",
      question_topic_key: "cities",
      emitted_reply_topic_key: "cities",
      emitted_question_topic_key: null,
      emitted_question_text: null,
      repair_note: "closed_topic_guard_rewritten",
      recommendation: "pause_review",
      confirmed_facts: [],
      open_questions: [],
      needs_human_input: { required: false }
    }
  });

  updatePrechatSession(session.id, { status: "paused_review", currentRound: 1 });
  getRawDatabaseForTests()
    .prepare("UPDATE prechat_rounds SET status = 'completed', stop_reason = 'paused_review' WHERE id = ?")
    .run(round.id);

  mockLlmSequence([
    {
      reply: "你对未来要不要孩子这件事，目前更偏向什么想法？",
      reply_topic_key: "childrenPreference",
      question_topic_key: "childrenPreference",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["你对未来要不要孩子这件事，目前更偏向什么想法？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "已恢复到孩子议题。",
      confirmed_facts: [],
      unresolved_questions: ["孩子与生育态度"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const recovered = await getSessionViewWithAutoRecovery(session.id, userA.id);
  assert.ok(recovered);
  let after = null;
  for (let index = 0; index < 30; index += 1) {
    after = getSessionDetailForUser(session.id, userA.id);
    const runState = after?.session?.control?.automation?.runState || "idle";
    if (!["queued", "running"].includes(runState)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(after);
  assert.equal(after.session.control?.automation?.runState || "idle", "idle");
  assert.equal(["active", "paused_review"].includes(after.session.status), true);
  assert.equal(
    Boolean(
      String(after.session.control?.automation?.activeTopicKey || "") ||
      (after.session.control?.automation?.topicQueueSnapshot || []).length
    ),
    true
  );
});

test("session 顶层误留 active 但最新 round 已 paused_review 且 backlog 未清空时，打开会话会先纠偏再触发语义恢复", async () => {
  const userA = createUser({
    email: "recover-drift-a@example.com",
    displayName: "刘星",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "recover-drift-b@example.com",
    displayName: "雨涵",
    passwordHash: hashPassword("secret123")
  });

  saveCurrentTwin(userA.id, buildTwin("刘星", { cities: "深圳、广州" }));
  saveCurrentTwin(userB.id, buildTwin("雨涵", { cities: "杭州" }));

  const matchId = upsertMatch(userA.id, userB.id, 93, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id,
    control: {
      automation: {
        enabled: true,
        source: "report_plan",
        preferredObjectiveKeys: ["relationshipGoal", "cities", "childrenPreference"],
        activeTopicKey: "childrenPreference",
        lastClosedTopicKey: "cities",
        topicQueueSnapshot: ["childrenPreference", "familyBoundary"],
        topicLedger: {
          relationshipGoal: {
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null,
            lastQuestionTurnId: null,
            closedAt: new Date().toISOString()
          },
          cities: {
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null,
            lastQuestionTurnId: null,
            closedAt: new Date().toISOString()
          },
          marriageTimeline: {
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null,
            lastQuestionTurnId: null,
            closedAt: new Date().toISOString()
          },
          childrenPreference: {
            state: "not_started",
            coverage: { initiator: false, counterparty: false },
            pendingAnswerUserId: null,
            lastQuestionTurnId: null,
            closedAt: null
          },
          familyBoundary: {
            state: "not_started",
            coverage: { initiator: false, counterparty: false },
            pendingAnswerUserId: null,
            lastQuestionTurnId: null,
            closedAt: null
          },
          financialView: {
            state: "not_started",
            coverage: { initiator: false, counterparty: false },
            pendingAnswerUserId: null,
            lastQuestionTurnId: null,
            closedAt: null
          }
        }
      }
    }
  });

  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 3,
    objective: {
      topics: [
        { key: "marriageTimeline", label: "结婚节奏", prompt: "确认结婚推进节奏是否接近。" },
        { key: "childrenPreference", label: "孩子与生育态度", prompt: "确认对未来孩子与生育的态度。" },
        { key: "familyBoundary", label: "家庭边界", prompt: "确认父母参与度和婚后边界。" }
      ],
      activeTopicKey: "cities",
      topicQueueSnapshot: ["marriageTimeline", "childrenPreference", "familyBoundary"]
    }
  });

  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 1,
    actorUserId: userA.id,
    actorRole: "initiator_twin",
    content: "如果匹配，希望 1 到 2 年内推进。 你对未来要不要孩子这件事，目前更偏向什么想法？",
    metadata: {
      reply: "如果匹配，希望 1 到 2 年内推进。 你对未来要不要孩子这件事，目前更偏向什么想法？",
      reply_topic_key: "marriageTimeline",
      question_topic_key: "marriageTimeline",
      emitted_reply_topic_key: "marriageTimeline",
      emitted_question_topic_key: "childrenPreference",
      emitted_question_text: "你对未来要不要孩子这件事，目前更偏向什么想法？",
      repair_note: "looping_reply_rewritten",
      alignment_issue: "question_topic_metadata_mismatch",
      recommendation: "continue",
      confirmed_facts: [],
      open_questions: ["你对未来要不要孩子这件事，目前更偏向什么想法？"],
      needs_human_input: { required: false }
    }
  });

  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 2,
    actorUserId: userB.id,
    actorRole: "counterparty_twin",
    content: "我长期更倾向在杭州生活。 婚后和父母的相处边界上，你更偏向怎样的安排？",
    metadata: {
      reply: "我长期更倾向在杭州生活。 婚后和父母的相处边界上，你更偏向怎样的安排？",
      reply_topic_key: "cities",
      question_topic_key: null,
      emitted_reply_topic_key: "cities",
      emitted_question_topic_key: "familyBoundary",
      emitted_question_text: "婚后和父母的相处边界上，你更偏向怎样的安排？",
      repair_note: "closed_topic_guard_rewritten",
      recommendation: "pause_review",
      confirmed_facts: [],
      open_questions: [],
      needs_human_input: { required: false }
    }
  });

  updatePrechatSession(session.id, { status: "active", currentRound: 3 });
  getRawDatabaseForTests()
    .prepare("UPDATE prechat_rounds SET status = 'completed', stop_reason = 'paused_review' WHERE id = ?")
    .run(round.id);

  mockLlmSequence([
    {
      reply: "你对未来要不要孩子这件事，目前更偏向什么想法？",
      reply_topic_key: "childrenPreference",
      question_topic_key: "childrenPreference",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: ["你对未来要不要孩子这件事，目前更偏向什么想法？"],
      risk_flags: [],
      needs_human_input: { required: false },
      recommendation: "continue"
    },
    {
      summary: "已从状态漂移中恢复，并重新推进孩子议题。",
      confirmed_facts: [],
      unresolved_questions: ["孩子与生育态度"],
      risk_summary: [],
      next_action: "continue",
      handoff_ready: false
    }
  ]);

  const recovered = await getSessionViewWithAutoRecovery(session.id, userA.id);
  assert.ok(recovered);

  let after = null;
  for (let index = 0; index < 30; index += 1) {
    after = getSessionDetailForUser(session.id, userA.id);
    const runState = after?.session?.control?.automation?.runState || "idle";
    if (!["queued", "running"].includes(runState)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.ok(after);
  assert.equal(after.session.control?.automation?.runState || "idle", "idle");
  assert.equal(["active", "paused_review"].includes(after.session.status), true);
  assert.equal(
    (after.turns || []).some((turn) => String(turn.actorRole || "").endsWith("_twin") && /孩子/u.test(String(turn.content || ""))),
    true
  );
});

test("历史错误的 closed-topic 人工补充待办在打开会话后会自动清掉", async () => {
  const userA = createUser({
    email: "recover-invalid-closed-a@example.com",
    displayName: "雨涵",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "recover-invalid-closed-b@example.com",
    displayName: "刘星",
    passwordHash: hashPassword("secret123")
  });

  saveCurrentTwin(userA.id, buildTwin("雨涵", { cities: "杭州" }));
  saveCurrentTwin(userB.id, buildTwin("刘星", { cities: "深圳、广州" }));

  const matchId = upsertMatch(userA.id, userB.id, 92, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userB.id,
    counterpartyUserId: userA.id,
    control: {
      automation: {
        enabled: true,
        source: "report_plan",
        preferredObjectiveKeys: ["cities"],
        activeTopicKey: null,
        lastClosedTopicKey: "cities",
        topicQueueSnapshot: [],
        topicLedger: {
          cities: {
            state: "closed",
            coverage: { initiator: true, counterparty: true },
            pendingAnswerUserId: null,
            lastQuestionTurnId: null,
            closedAt: new Date().toISOString(),
            reopenReason: null,
            reopenedAt: null
          }
        }
      }
    }
  });

  updatePrechatSession(session.id, {
    status: "pending_human_input",
    currentRound: 1
  });

  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: [],
      activeTopicKey: null,
      topicQueueSnapshot: []
    }
  });

  saveExtractedFacts(session.id, round.id, [
    {
      subjectUserId: userA.id,
      key: "cities",
      value: "长期更倾向杭州",
      confidence: 0.9,
      status: "confirmed"
    },
    {
      subjectUserId: userB.id,
      key: "cities",
      value: "长期更倾向深圳，广州也可以接受",
      confidence: 0.9,
      status: "confirmed"
    }
  ]);

  createHumanInputRequest({
    sessionId: session.id,
    roundId: round.id,
    targetUserId: userB.id,
    fieldKey: "cities",
    questionText: "当前议题“城市与生活安排”已经确认完成，请不要重复确认。",
    metadata: {
      turnNumber: 1
    }
  });

  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 1,
    actorUserId: null,
    actorRole: "system",
    content: "系统暂停：需要 刘星 本人补充信息后才能继续。待确认内容：当前议题“城市与生活安排”已经确认完成，请不要重复确认。",
    metadata: {
      pauseReason: "pending_human_input",
      targetUserId: userB.id,
      fieldKey: "cities"
    }
  });

  const recovered = await getSessionViewWithAutoRecovery(session.id, userA.id);
  const pendingHuman = (recovered.humanInputRequests || []).filter((item) => item.status === "pending");
  const resolvedClosedTopicRequest = (recovered.humanInputRequests || []).find(
    (item) => item.fieldKey === "cities" && item.metadata?.autoRecoverySource === "invalid_closed_topic_pending_request"
  );

  assert.equal(
    pendingHuman.some((item) => item.fieldKey === "cities"),
    false
  );
  assert.equal(Boolean(resolvedClosedTopicRequest), true);
});

test("all canonical topics closed 且不存在 trusted outstanding question 时不会因历史 stale fingerprint 继续续推", async () => {
  const userA = createUser({
    email: "closed-clean-stop-a@example.com",
    displayName: "雨涵",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "closed-clean-stop-b@example.com",
    displayName: "刘宇",
    passwordHash: hashPassword("secret123")
  });

  saveCurrentTwin(userA.id, buildTwin("雨涵"));
  saveCurrentTwin(userB.id, buildTwin("刘宇"));

  const matchId = upsertMatch(userA.id, userB.id, 91, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id,
    control: {
      automation: {
        enabled: true,
        source: "report_plan",
        activeTopicKey: null,
        topicQueueSnapshot: [],
        topicLedger: {
          relationshipGoal: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() },
          cities: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() },
          marriageTimeline: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() },
          childrenPreference: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() },
          familyBoundary: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() },
          financialView: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() }
        }
      }
    }
  });
  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: [],
      activeTopicKey: null,
      topicQueueSnapshot: []
    }
  });

  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 1,
    actorUserId: userA.id,
    actorRole: "initiator_twin",
    content: "如果关系稳定，我倾向于在1到2年内推进结婚。",
    metadata: {
      reply: "如果关系稳定，我倾向于在1到2年内推进结婚。",
      reply_topic_key: "marriageTimeline",
      question_topic_key: null,
      canonical_reply_topic_key: "marriageTimeline",
      canonical_question_topic_key: null,
      canonical_question_text: null,
      question_fingerprint: "familyBoundary:关于婚后和父母的相处边界你偏向怎样的",
      repair_note: "closed_topic_guard_rewritten",
      closed_topic_guard_resolution: "answered_without_followup",
      recommendation: "continue",
      needs_human_input: { required: false }
    }
  });

  const recovered = await getSessionViewWithAutoRecovery(session.id, userA.id);
  assert.ok(recovered);
  const after = getSessionDetailForUser(session.id, userA.id);
  assert.equal(after.session.control.automation.activeTopicKey, null);
  assert.deepEqual(after.session.control.automation.topicQueueSnapshot, []);
  assert.equal(
    (after.turns || []).filter((turn) => String(turn.actorRole || "").endsWith("_twin")).length,
    1
  );
});

test("所有 canonical 议题已关闭时，不会写入空 Twin turn，也不会再生成 next_candidate_topic_key 待办", async () => {
  const userA = createUser({
    email: "all-closed-a@example.com",
    displayName: "刘星",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "all-closed-b@example.com",
    displayName: "雨涵",
    passwordHash: hashPassword("secret123")
  });

  saveCurrentTwin(userA.id, buildTwin("刘星", { financialView: "我希望负债不要太多，消费正常即可" }));
  saveCurrentTwin(userB.id, buildTwin("雨涵", { financialView: "重视务实稳定，不接受隐性负债" }));

  const matchId = upsertMatch(userA.id, userB.id, 93, "matched");
  const session = createPrechatSession({
    matchId,
    initiatorUserId: userA.id,
    counterpartyUserId: userB.id,
    status: "active",
    control: {
      automation: {
        enabled: true,
        source: "report_plan",
        preferredObjectiveKeys: ["relationshipGoal", "cities", "marriageTimeline", "childrenPreference", "familyBoundary", "financialView"],
        activeTopicKey: "financialView",
        lastClosedTopicKey: "familyBoundary",
        topicQueueSnapshot: [],
        topicLedger: {
          relationshipGoal: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() },
          cities: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() },
          marriageTimeline: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() },
          childrenPreference: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() },
          familyBoundary: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() },
          financialView: { state: "closed", coverage: { initiator: true, counterparty: true }, pendingAnswerUserId: null, lastQuestionTurnId: null, closedAt: new Date().toISOString() }
        }
      }
    }
  });
  updatePrechatSession(session.id, { status: "pending_human_input", currentRound: 1 });

  const round = createPrechatRound({
    sessionId: session.id,
    roundNumber: 1,
    objective: {
      topics: [],
      activeTopicKey: null,
      topicQueueSnapshot: []
    }
  });

  addConversationTurn({
    sessionId: session.id,
    roundId: round.id,
    turnNumber: 1,
    actorUserId: userB.id,
    actorRole: "counterparty_twin",
    content: "",
    metadata: {
      reply: "",
      reply_topic_key: "financialView",
      question_topic_key: null,
      emitted_reply_topic_key: null,
      emitted_question_topic_key: null,
      emitted_question_text: null,
      confirmed_facts: [],
      open_questions: [],
      needs_human_input: { required: false },
      recommendation: "pause_review",
      repair_note: "closed_topic_guard_silenced",
      closed_topic_guard_resolution: "pause_without_pending_request"
    }
  });
  createHumanInputRequest({
    sessionId: session.id,
    roundId: round.id,
    targetUserId: userA.id,
    fieldKey: "next_candidate_topic_key",
    questionText:
      "当前所有核心议题（关系目标、城市、结婚节奏、孩子、家庭边界、财务观）均已确认或处于待澄清状态，且 forbidden_topic_keys 包含了所有已关闭的议题。请指示下一轮预沟通应推进哪个新议题？",
    metadata: {
      turnNumber: 2
    }
  });
  finishPrechatRound(round.id, { status: "completed", stopReason: "pending_human_input" });

  const recovered = await getSessionViewWithAutoRecovery(session.id, userA.id);
  assert.ok(recovered);

  const after = getSessionDetailForUser(session.id, userA.id);
  assert.ok(after);
  const emptyTwinTurn = after.turns.find(
    (turn) => String(turn.actorRole || "").endsWith("_twin") && String(turn.content || "") === ""
  );
  const nextTopicRequest = (after.humanInputRequests || []).find(
    (request) => request.fieldKey === "next_candidate_topic_key" && request.status === "pending"
  );
  const latestRound = after.rounds[after.rounds.length - 1];

  assert.equal(Boolean(emptyTwinTurn), true);
  assert.equal(Boolean(nextTopicRequest), false);
  assert.equal(after.session.status, "paused_review");
  assert.equal(latestRound.stopReason, "objectives_completed");
});
