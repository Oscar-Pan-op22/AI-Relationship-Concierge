import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateSessionToken,
  hashPassword,
  normalizeEmail,
  parseCookies,
  serializeExpiredSessionCookie,
  serializeSessionCookie,
  sessionExpiryDate,
  verifyPassword
} from "./lib/auth.js";
import {
  countUsers,
  createPrechatSession,
  createUser,
  createUserSession,
  deleteUserSession,
  getCandidatePool,
  getCandidatePoolCount,
  getCurrentTwin,
  getDatabasePath,
  getInboxForUser,
  getMatchForUser,
  getReport,
  getSessionDetailForUser,
  getSessionParticipantProfiles,
  getUserByEmail,
  getUserById,
  getUserBySessionToken,
  listPrechatSessionsForUser,
  loadReports,
  saveCurrentTwin,
  saveReport
} from "./lib/database.js";
import { getLlmRuntimeConfig } from "./lib/llmAdapter.js";
import { buildMatchesForUser, refreshMatchesForUser } from "./lib/matchService.js";
import {
  acceptInvitation,
  applySessionDecision,
  approveSensitiveQuestion,
  createPrechatInvitation,
  getSessionViewWithAutoRecovery,
  getSessionView,
  rejectInvitation,
  rejectSensitiveQuestion,
  runSessionRound,
  sendManualMessage,
  submitHumanInput
} from "./lib/prechatService.js";
import { REALITY_FIELD_DEFS, SENSITIVE_TOPIC_CATEGORIES } from "./lib/constants.js";
import { buildMatchReport, REPORT_SCHEMA_VERSION } from "./lib/matchingEngine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");
const defaultPort = Number(process.env.PORT || 3000);
const phase = "phase_2_twin_twin_prechat";
const phaseLabel = "双真实用户 Twin-Twin 预沟通";

function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendText(response, statusCode, body, contentType = "text/plain; charset=utf-8", headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    ...headers
  });
  response.end(body);
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";

    request.on("data", (chunk) => {
      raw += chunk;

      if (raw.length > 1_500_000) {
        reject(new Error("请求体过大。"));
      }
    });

    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("JSON 请求体格式无效。"));
      }
    });

    request.on("error", reject);
  });
}

function getContentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function resolvePublicFile(requestPath) {
  const normalizedPath = requestPath === "/" ? "/index.html" : path.posix.normalize(requestPath);
  const filePath = path.resolve(publicDir, `.${normalizedPath}`);
  const inPublicDir = filePath === publicDir || filePath.startsWith(`${publicDir}${path.sep}`);

  if (!inPublicDir) {
    return null;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return null;
  }

  return filePath;
}

function extractId(pathname, prefix, suffix = "") {
  if (!pathname.startsWith(prefix) || (suffix && !pathname.endsWith(suffix))) {
    return "";
  }

  const start = prefix.length;
  const end = suffix ? pathname.length - suffix.length : pathname.length;
  return decodeURIComponent(pathname.slice(start, end));
}

function buildPublicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName
  };
}

function requireTwinProfile(payload) {
  if (!payload?.twinProfile || typeof payload.twinProfile !== "object") {
    throw new Error("缺少 Twin 信息。");
  }
}

function requireAuthenticatedUser(request) {
  const cookies = parseCookies(request.headers.cookie || "");
  const token = cookies.tongpin_session;

  if (!token) {
    return null;
  }

  return getUserBySessionToken(token);
}

function requireUserOrThrow(request) {
  const user = requireAuthenticatedUser(request);

  if (!user) {
    const error = new Error("请先登录。");
    error.statusCode = 401;
    throw error;
  }

  return user;
}

function serveStatic(requestPath, response) {
  const filePath = resolvePublicFile(requestPath);

  if (!filePath) {
    sendText(response, 404, "未找到页面。");
    return;
  }

  sendText(response, 200, fs.readFileSync(filePath), getContentType(filePath));
}

function buildReportFromTwin(userId, twin) {
  const report = buildMatchReport(
    { twinProfile: twin.twinProfile },
    { candidatePool: getCandidatePool() }
  );
  return saveReport(userId, report, twin.twinVersionId, twin.twinVersionNumber);
}

async function ensureAutoPrechatSessions(userId) {
  const matches = refreshMatchesForUser(userId);
  const createdSessions = [];

  for (const match of matches) {
    const session = await createPrechatInvitation(match.id, userId, createPrechatSession);
    createdSessions.push({ matchId: match.id, sessionId: session.id });
  }

  return createdSessions;
}

function saveUserPrechatPlan(userId, matchIds, objectiveKeys) {
  const currentTwin = getCurrentTwin(userId);

  if (!currentTwin) {
    throw new Error("确认预沟通计划前，需要先保存当前 Twin。");
  }

  const nextProfile = {
    ...currentTwin.twinProfile,
    prechatGoals: {
      selectedMatchIds: [...new Set(matchIds)],
      selectedObjectiveKeys: [...new Set(objectiveKeys)],
      confirmedAt: new Date().toISOString()
    }
  };

  return saveCurrentTwin(userId, nextProfile);
}

async function activatePrechatPlan(userId, matchIds, objectiveKeys) {
  const availableMatches = refreshMatchesForUser(userId);
  const availableIds = new Set(availableMatches.map((match) => match.id));
  const selectedMatchIds = [...new Set(matchIds)].filter((id) => availableIds.has(id));
  const selectedObjectiveKeys = [...new Set(objectiveKeys)].filter(Boolean);

  if (!selectedMatchIds.length) {
    throw new Error("请先至少选择 1 个要进入预沟通的对象。");
  }

  if (!selectedObjectiveKeys.length) {
    throw new Error("请先至少确认 1 个预沟通目标。");
  }

  const twin = saveUserPrechatPlan(userId, selectedMatchIds, selectedObjectiveKeys);
  const sessions = [];

  for (const matchId of selectedMatchIds) {
    const session = await createPrechatInvitation(matchId, userId, createPrechatSession);
    sessions.push(session);
  }

  return {
    twin,
    sessions,
    prechatOverview: buildPrechatOverview(userId)
  };
}

function buildPrechatOverview(userId) {
  const matches = buildMatchesForUser(userId);
  const items = matches
    .filter((match) => match.openSession)
    .map((match) => ({
      matchId: match.id,
      sessionId: match.openSession.id,
      status: match.openSession.status,
      score: match.score,
      scoreLabel: match.scoreLabel,
      counterpart: match.counterpart,
      reasons: match.reasons || []
    }));

  return {
    totalSessions: items.length,
    activeCount: items.filter((item) => item.status === "active").length,
    waitingAcceptanceCount: items.filter((item) => item.status === "awaiting_counterparty_acceptance").length,
    waitingSensitiveApprovalCount: items.filter((item) => item.status === "pending_sensitive_approval").length,
    pausedCount: items.filter((item) => item.status === "paused_review").length,
    handoffReadyCount: items.filter((item) => item.status === "handoff_ready").length,
    items
  };
}

function attachPrechatOverview(report, userId) {
  return {
    ...report,
    prechatOverview: buildPrechatOverview(userId)
  };
}

function buildInboxView(userId) {
  return getInboxForUser(userId).map((item) => {
    if (item.type === "invitation") {
      const initiator = getUserById(item.payload.initiatorUserId);
      return {
        ...item,
        payload: {
          ...item.payload,
          initiator: initiator ? buildPublicUser(initiator) : null
        }
      };
    }

    if (item.type === "sensitive_request") {
      const requester = getUserById(item.payload.requestingUserId);
      return {
        ...item,
        payload: {
          ...item.payload,
          requester: requester ? buildPublicUser(requester) : null
        }
      };
    }

    return item;
  });
}

function buildSessionSummary(session, currentUserId) {
  const detail = getSessionDetailForUser(session.id, currentUserId);
  const participants = getSessionParticipantProfiles(session);

  return {
    ...session,
    initiator: participants.initiator
      ? { id: participants.initiator.userId, displayName: participants.initiator.displayName }
      : null,
    counterparty: participants.counterparty
      ? { id: participants.counterparty.userId, displayName: participants.counterparty.displayName }
      : null,
    latestStageReport: detail?.stageReports?.[0]?.payload || null
  };
}

export function createAppServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);

    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, {
          ok: true,
          phase,
          phaseLabel,
          databasePath: getDatabasePath(),
          llm: getLlmRuntimeConfig()
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/config") {
        sendJson(response, 200, {
          phase,
          phaseLabel,
          reportSchemaVersion: REPORT_SCHEMA_VERSION,
          candidatePoolSize: getCandidatePoolCount(),
          sensitiveTopicCategories: SENSITIVE_TOPIC_CATEGORIES,
          realityFieldDefs: REALITY_FIELD_DEFS,
          userCount: countUsers()
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/auth/register") {
        const payload = await parseBody(request);
        const email = normalizeEmail(payload.email);
        const displayName = String(payload.displayName || "").trim();
        const password = String(payload.password || "");

        if (!email || !displayName || password.length < 6) {
          throw new Error("注册信息不完整，且密码至少需要 6 位。");
        }

        if (getUserByEmail(email)) {
          throw new Error("该邮箱已经注册。");
        }

        const user = createUser({
          email,
          displayName,
          passwordHash: hashPassword(password)
        });
        const token = generateSessionToken();
        const expiresAt = sessionExpiryDate();
        createUserSession(user.id, token, expiresAt.toISOString());

        sendJson(
          response,
          201,
          { user: buildPublicUser(user) },
          { "Set-Cookie": serializeSessionCookie(token, expiresAt) }
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const payload = await parseBody(request);
        const email = normalizeEmail(payload.email);
        const password = String(payload.password || "");
        const user = getUserByEmail(email);

        if (!user || !verifyPassword(password, user.passwordHash)) {
          const error = new Error("邮箱或密码不正确。");
          error.statusCode = 401;
          throw error;
        }

        const token = generateSessionToken();
        const expiresAt = sessionExpiryDate();
        createUserSession(user.id, token, expiresAt.toISOString());

        sendJson(
          response,
          200,
          { user: buildPublicUser(user) },
          { "Set-Cookie": serializeSessionCookie(token, expiresAt) }
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        const cookies = parseCookies(request.headers.cookie || "");

        if (cookies.tongpin_session) {
          deleteUserSession(cookies.tongpin_session);
        }

        sendJson(
          response,
          200,
          { ok: true },
          { "Set-Cookie": serializeExpiredSessionCookie() }
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/auth/me") {
        const user = requireAuthenticatedUser(request);

        if (!user) {
          sendJson(response, 401, { error: "未登录。" });
          return;
        }

        sendJson(response, 200, {
          user: buildPublicUser(user),
          twin: getCurrentTwin(user.id)
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/twin") {
        const user = requireUserOrThrow(request);
        sendJson(response, 200, { twin: getCurrentTwin(user.id) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/twin") {
        const user = requireUserOrThrow(request);
        const payload = await parseBody(request);
        requireTwinProfile(payload);
        const twin = saveCurrentTwin(user.id, payload.twinProfile);
        sendJson(response, 201, { twin });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/reports") {
        const user = requireUserOrThrow(request);
        sendJson(response, 200, {
          reports: loadReports(user.id, { schemaVersion: REPORT_SCHEMA_VERSION }).map((report) =>
            attachPrechatOverview(report, user.id)
          )
        });
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/reports/")) {
        const user = requireUserOrThrow(request);
        const reportId = extractId(url.pathname, "/api/reports/");
        const report = getReport(user.id, reportId, { schemaVersion: REPORT_SCHEMA_VERSION });

        if (!report) {
          sendJson(response, 404, { error: "未找到该匹配报告。" });
          return;
        }

        sendJson(response, 200, { report: attachPrechatOverview(report, user.id) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/reports") {
        const user = requireUserOrThrow(request);
        const payload = await parseBody(request);
        const twin = payload.twinProfile
          ? saveCurrentTwin(user.id, payload.twinProfile)
          : getCurrentTwin(user.id);

        if (!twin) {
          throw new Error("生成匹配报告前，需要先保存当前 Twin。");
        }

        const report = buildReportFromTwin(user.id, twin);
        sendJson(response, 201, { report: attachPrechatOverview(report, user.id), twin });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/matches") {
        const user = requireUserOrThrow(request);
        const matches = refreshMatchesForUser(user.id);
        sendJson(response, 200, { matches });
        return;
      }

      if (request.method === "POST" && /^\/api\/matches\/[^/]+\/invite-prechat$/u.test(url.pathname)) {
        const user = requireUserOrThrow(request);
        const matchId = extractId(url.pathname, "/api/matches/", "/invite-prechat");
        const match = getMatchForUser(matchId, user.id);

        if (!match) {
          sendJson(response, 404, { error: "未找到该匹配。" });
          return;
        }

        const session = await createPrechatInvitation(matchId, user.id, createPrechatSession);
        sendJson(response, 201, { session });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/prechat/plan") {
        const user = requireUserOrThrow(request);
        const payload = await parseBody(request);
        const result = await activatePrechatPlan(
          user.id,
          Array.isArray(payload.matchIds) ? payload.matchIds : [],
          Array.isArray(payload.objectiveKeys) ? payload.objectiveKeys : []
        );
        sendJson(response, 201, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/inbox") {
        const user = requireUserOrThrow(request);
        sendJson(response, 200, { items: buildInboxView(user.id) });
        return;
      }

      if (request.method === "POST" && /^\/api\/prechat\/invitations\/[^/]+\/accept$/u.test(url.pathname)) {
        const user = requireUserOrThrow(request);
        const invitationId = extractId(url.pathname, "/api/prechat/invitations/", "/accept");
        const session = await acceptInvitation(invitationId, user.id);
        sendJson(response, 200, { session });
        return;
      }

      if (request.method === "POST" && /^\/api\/prechat\/invitations\/[^/]+\/reject$/u.test(url.pathname)) {
        const user = requireUserOrThrow(request);
        const invitationId = extractId(url.pathname, "/api/prechat/invitations/", "/reject");
        const session = await rejectInvitation(invitationId, user.id);
        sendJson(response, 200, { session });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/prechat/sessions") {
        const user = requireUserOrThrow(request);
        const sessions = listPrechatSessionsForUser(user.id).map((session) =>
          buildSessionSummary(session, user.id)
        );
        sendJson(response, 200, { sessions });
        return;
      }

      if (request.method === "GET" && /^\/api\/prechat\/sessions\/[^/]+$/u.test(url.pathname)) {
        const user = requireUserOrThrow(request);
        const sessionId = extractId(url.pathname, "/api/prechat/sessions/");
        const session = await getSessionViewWithAutoRecovery(sessionId, user.id);

        if (!session) {
          sendJson(response, 404, { error: "未找到该预沟通会话。" });
          return;
        }

        sendJson(response, 200, session);
        return;
      }

      if (request.method === "POST" && /^\/api\/prechat\/sessions\/[^/]+\/run-round$/u.test(url.pathname)) {
        const user = requireUserOrThrow(request);
        const sessionId = extractId(url.pathname, "/api/prechat/sessions/", "/run-round");
        const result = await runSessionRound(sessionId, user.id);
        const session = getSessionView(sessionId, user.id);
        sendJson(response, 200, { result, session });
        return;
      }

      if (request.method === "POST" && /^\/api\/prechat\/sessions\/[^/]+\/decision$/u.test(url.pathname)) {
        const user = requireUserOrThrow(request);
        const sessionId = extractId(url.pathname, "/api/prechat/sessions/", "/decision");
        const payload = await parseBody(request);
        const session = applySessionDecision(sessionId, user.id, payload.action);
        sendJson(response, 200, { session });
        return;
      }

      if (request.method === "POST" && /^\/api\/prechat\/sessions\/[^/]+\/human-input$/u.test(url.pathname)) {
        const user = requireUserOrThrow(request);
        const sessionId = extractId(url.pathname, "/api/prechat/sessions/", "/human-input");
        const payload = await parseBody(request);

        if (!payload.requestId || !payload.responseText) {
          throw new Error("缺少人工补充请求编号或回复内容。");
        }

        const session = await submitHumanInput(payload.requestId, user.id, payload.responseText);
        sendJson(response, 200, { session, sessionId });
        return;
      }

      if (request.method === "POST" && /^\/api\/prechat\/sessions\/[^/]+\/manual-message$/u.test(url.pathname)) {
        const user = requireUserOrThrow(request);
        const sessionId = extractId(url.pathname, "/api/prechat/sessions/", "/manual-message");
        const payload = await parseBody(request);

        if (!payload.content) {
          throw new Error("缺少要发送的消息内容。");
        }

        const session = await sendManualMessage(sessionId, user.id, payload.content);
        sendJson(response, 201, { session, sessionId });
        return;
      }

      if (request.method === "POST" && /^\/api\/sensitive-requests\/[^/]+\/approve$/u.test(url.pathname)) {
        const user = requireUserOrThrow(request);
        const requestId = extractId(url.pathname, "/api/sensitive-requests/", "/approve");
        const result = await approveSensitiveQuestion(requestId, user.id);
        sendJson(response, 200, { result });
        return;
      }

      if (request.method === "POST" && /^\/api\/sensitive-requests\/[^/]+\/reject$/u.test(url.pathname)) {
        const user = requireUserOrThrow(request);
        const requestId = extractId(url.pathname, "/api/sensitive-requests/", "/reject");
        const result = await rejectSensitiveQuestion(requestId, user.id);
        sendJson(response, 200, { result });
        return;
      }

      if (request.method === "GET" && url.pathname === "/") {
        const user = requireAuthenticatedUser(request);
        serveStatic(user ? "/index.html" : "/auth.html", response);
        return;
      }

      if (request.method === "GET") {
        serveStatic(url.pathname, response);
        return;
      }

      sendJson(response, 404, { error: "接口不存在。" });
    } catch (error) {
      const statusCode = error?.statusCode || 400;
      sendJson(response, statusCode, {
        error: error instanceof Error ? error.message : "发生了未预期的错误。"
      });
    }
  });
}

export function startServer(port = defaultPort) {
  const server = createAppServer();
  server.listen(port, () => {
    console.log(`同频 Phase 2 已启动：http://localhost:${port}`);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startServer(defaultPort);
}
