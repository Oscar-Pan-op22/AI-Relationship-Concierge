import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
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
  clearPrechatHistoryData,
  countUsers,
  createPrechatSession,
  createUser,
  createUserSession,
  deleteUserSession,
  getCandidatePoolCount,
  getCurrentTwin,
  getDatabasePath,
  getAllUsers,
  getInboxForUser,
  getMatchForUser,
  getPrechatSessionById,
  getReport,
  getSessionDetailForUser,
  getSessionParticipantProfiles,
  getUserByEmail,
  getUserById,
  getUserBySessionToken,
  listPrechatSessionsForUser,
  loadReports,
  saveManualTwinProfile,
  saveTwinRuntimeState,
  saveReport
} from "./lib/database.js";
import { getLlmRuntimeConfig } from "./lib/llmAdapter.js";
import { buildMatchesForUser, refreshMatchesForUser } from "./lib/matchService.js";
import { buildPublicSummary, sanitizePublicCities } from "./lib/phase2MatchEngine.js";
import {
  acceptInvitation,
  applySessionDecision,
  approveSensitiveQuestion,
  clearInMemoryPrechatAutomationState,
  createPrechatInvitation,
  deleteMessageForCurrentUser,
  editMessage,
  getSessionViewWithAutoRecovery,
  getSessionView,
  reactToMessage,
  recallMessage,
  rejectInvitation,
  rejectSensitiveQuestion,
  runSessionRound,
  sendManualMessage,
  sanitizeStageReportPayloadForViewer,
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
const prechatResetJobs = new Map();

function nowIso() {
  return new Date().toISOString();
}

function isLocalRequest(request) {
  const remoteAddress = String(request.socket?.remoteAddress || "");
  return (
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1"
  );
}

function createPrechatResetJob(waitMs) {
  const id = crypto.randomUUID();
  const job = {
    id,
    kind: "reset_and_restart_prechat",
    status: "queued",
    waitMs,
    createdAt: nowIso(),
    startedAt: null,
    completedAt: null,
    summary: null,
    error: null
  };
  prechatResetJobs.set(id, job);
  return job;
}

async function runPrechatResetJob(job) {
  job.status = "running";
  job.startedAt = nowIso();

  const waitMs = Math.max(0, Number(job.waitMs || 0));
  const isRealUser = (user) => {
    const name = String(user?.displayName || "").trim();
    return Boolean(name) && !/^\?+$/u.test(name) && !/^\uFFFD+$/u.test(name);
  };

  try {
    clearInMemoryPrechatAutomationState();
    clearPrechatHistoryData();
    const users = getAllUsers().filter(isRealUser).filter((user) => getCurrentTwin(user.id));

    for (const user of users) {
      refreshMatchesForUser(user.id);
    }

    const seenMatchIds = new Set();
    const createdSessions = [];
    for (const user of users) {
      const matches = buildMatchesForUser(user.id).filter((match) => !match.openSession);
      for (const match of matches) {
        if (seenMatchIds.has(match.id)) {
          continue;
        }
        seenMatchIds.add(match.id);
        const session = await createPrechatInvitation(match.id, user.id, createPrechatSession, {
          source: "direct_invite",
          preferredObjectiveKeys: []
        });
        createdSessions.push(session);
      }
    }

    const acceptedSessions = [];
    for (const session of createdSessions) {
      try {
        const accepted = await acceptInvitation(session.id, session.counterpartyUserId);
        acceptedSessions.push({
          id: accepted.id,
          status: accepted.status,
          initiatorUserId: accepted.initiatorUserId,
          counterpartyUserId: accepted.counterpartyUserId
        });
      } catch (error) {
        acceptedSessions.push({
          id: session.id,
          error: String(error?.message || error)
        });
      }
    }

    job.status = "completed";
    job.completedAt = nowIso();
    job.summary = {
      userCount: users.length,
      sessionCount: createdSessions.length,
      waitMs,
      acceptedSessions
    };
  } catch (error) {
    job.status = "failed";
    job.completedAt = nowIso();
    job.error = String(error?.stack || error?.message || error);
  }
}

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

function extractMessageRouteIds(pathname) {
  const parts = pathname.split("/");
  return {
    sessionId: decodeURIComponent(parts[4] || ""),
    turnId: decodeURIComponent(parts[6] || "")
  };
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

  sendText(response, 200, fs.readFileSync(filePath), getContentType(filePath), {
    "Cache-Control": "no-store"
  });
}

function deriveReportBand(score) {
  if (score >= 82) {
    return { key: "strong", label: "优先进入预沟通" };
  }

  if (score >= 68) {
    return { key: "promising", label: "值得进入预沟通" };
  }

  if (score >= 52) {
    return { key: "needs-clarification", label: "需要先补充信息" };
  }

  return { key: "weak", label: "当前不优先" };
}

function buildRealUserShortlist(userId) {
  return refreshMatchesForUser(userId)
    .slice(0, 4)
    .map((match) => {
      const band = deriveReportBand(match.score);
      const cities = String(match.counterpart.cities || "").trim();
      const profileLabel = String(match.counterpart.profileLabel || "").trim();

      return {
        candidateId: match.counterpart.id,
        displayName: match.counterpart.displayName,
        age: null,
        city: cities,
        occupation: "",
        verificationLevel: "平台注册用户",
        trustLevel: "已完成 Twin 建档",
        profileLabel,
        summary: match.counterpart.summary || "当前资料还在完善中。",
        matchScore: match.score,
        matchBandKey: band.key,
        matchBandLabel: band.label,
        statusSummary: match.scoreLabel,
        highlights: profileLabel ? [profileLabel] : [],
        matchedReasons: match.reasons || [],
        cautionPoints: [],
        nextPhaseFocus: [
          "继续由 Twin-Twin 预沟通确认双方长期关系目标。",
          cities ? `优先确认长期生活城市是否能落到${cities}。` : "继续确认长期生活城市安排。"
        ],
        unresolvedMustHaves: [],
        matrix: [],
        risks: [],
        hardStopMatches: [],
        realityFindings: [],
        realitySummary: cities
          ? [{ key: "cities", label: "长期生活城市", value: cities, valueLabel: cities }]
          : [],
        openSession: match.openSession
      };
    });
}

function buildReportOverview(shortlist, userPoolCount) {
  const nextPhaseReadyCount = shortlist.filter((candidate) =>
    ["strong", "promising"].includes(candidate.matchBandKey)
  ).length;

  return {
    candidatePoolSize: userPoolCount,
    shortlistCount: shortlist.length,
    nextPhaseReadyCount,
    excludedByRealityCount: 0,
    headline: `已在真实用户池 ${userPoolCount} 人中完成初筛，产出 ${shortlist.length} 位 shortlist 对象。`
  };
}

function buildReportNextSteps(baseReport, shortlist) {
  const nextSteps = [];
  const topCandidate = shortlist[0];

  if ((baseReport.profileGaps || []).some((gap) => gap.priority === "high")) {
    nextSteps.push("先补齐高优先级画像字段，再重新生成初筛结果。");
  }

  if ((baseReport.suggestedCompletions || []).length) {
    nextSteps.push("可以继续补充现实条件层的选填字段，让真实用户匹配更贴近可推进性。");
  }

  if (topCandidate) {
    nextSteps.push(`优先围绕 ${topCandidate.displayName} 开启 Twin-Twin 预沟通，并继续核实长期目标与城市安排。`);
  } else {
    nextSteps.push("当前还没有足够合适的真实平台用户进入 shortlist，建议先等待更多用户完成 Twin 建档。");
  }

  nextSteps.push("下一阶段会直接面向真实平台用户开启 Twin-Twin 预沟通，不再使用 demo 候选池。");
  return [...new Set(nextSteps)];
}

function buildReportFromTwin(userId, twin) {
  const baseReport = buildMatchReport({ twinProfile: twin.twinProfile });
  const shortlist = buildRealUserShortlist(userId);
  const userPoolCount = Math.max(0, countUsers() - 1);
  const report = {
    ...baseReport,
    realityPreferenceFindings: [],
    shortlist,
    overview: buildReportOverview(shortlist, userPoolCount),
    nextSteps: buildReportNextSteps(baseReport, shortlist)
  };

  return saveReport(userId, report, twin.twinVersionId, twin.twinVersionNumber);
}

function saveUserPrechatPlan(userId, matchIds, objectiveKeys) {
  const currentTwin = getCurrentTwin(userId);

  if (!currentTwin) {
    throw new Error("确认预沟通计划前，需要先保存当前 Twin。");
  }

  return saveTwinRuntimeState(userId, {
    prechatGoals: {
      selectedMatchIds: [...new Set(matchIds)],
      selectedObjectiveKeys: [...new Set(objectiveKeys)],
      confirmedAt: new Date().toISOString()
    }
  });
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
    const session = await createPrechatInvitation(matchId, userId, createPrechatSession, {
      source: "report_plan",
      preferredObjectiveKeys: selectedObjectiveKeys
    });
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
    ...sanitizeReportForResponse(report),
    prechatOverview: buildPrechatOverview(userId)
  };
}

function sanitizeShortlistCandidateSummary(candidate, safeCities) {
  const snapshotProfile = {
    relationshipGoal: String(candidate?.relationshipGoal || "").trim(),
    cities: safeCities,
    communicationStyle: String(candidate?.communicationStyle || "").trim()
  };
  const rebuilt = buildPublicSummary(snapshotProfile);
  const currentSummary = String(candidate?.summary || "").trim();

  if (rebuilt !== "当前 Twin 资料还在完善中。") {
    return rebuilt;
  }

  if (!currentSummary) {
    return rebuilt;
  }

  const fallbackSummary = currentSummary
    .replace(/(?:^|；)\s*偏好城市：[^；]*/u, "")
    .replace(/^；|；$/gu, "")
    .trim();

  return fallbackSummary || rebuilt;
}

function sanitizeShortlistCandidateNextPhaseFocus(candidate, safeCities) {
  const currentFocus = Array.isArray(candidate?.nextPhaseFocus)
    ? candidate.nextPhaseFocus
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    : [];

  return currentFocus.map((item) => {
    if (/(长期生活城市|城市安排|城市偏好|能落到)/u.test(item)) {
      return safeCities ? `优先确认长期生活城市是否能落到${safeCities}。` : "继续确认长期生活城市安排。";
    }

    return item;
  });
}

function sanitizeShortlistCandidateForResponse(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return candidate;
  }

  const safeCities = sanitizePublicCities(candidate.city || "");
  const realitySummary = Array.isArray(candidate.realitySummary)
    ? candidate.realitySummary
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }

          if (item.key !== "cities") {
            return item;
          }

          const itemCities = sanitizePublicCities(item.valueLabel || item.value || "");

          if (!itemCities) {
            return null;
          }

          return {
            ...item,
            value: itemCities,
            valueLabel: itemCities
          };
        })
        .filter(Boolean)
    : [];

  return {
    ...candidate,
    city: safeCities,
    realitySummary,
    summary: sanitizeShortlistCandidateSummary(candidate, safeCities),
    nextPhaseFocus: sanitizeShortlistCandidateNextPhaseFocus(candidate, safeCities)
  };
}

function sanitizeReportForResponse(report) {
  if (!report || typeof report !== "object") {
    return report;
  }

  return {
    ...report,
    shortlist: Array.isArray(report.shortlist)
      ? report.shortlist.map((candidate) => sanitizeShortlistCandidateForResponse(candidate))
      : []
  };
}

function isSessionManualPauseActive(session) {
  const control = session?.control && typeof session.control === "object" ? session.control : {};
  const manualPause = control.manualPause && typeof control.manualPause === "object" ? control.manualPause : {};
  const legacyActive = Boolean(manualPause.active);
  const initiatorEnded = Boolean(
    manualPause.initiatorEnded == null ? legacyActive : manualPause.initiatorEnded
  );
  const counterpartyEnded = Boolean(
    manualPause.counterpartyEnded == null ? legacyActive : manualPause.counterpartyEnded
  );

  return initiatorEnded || counterpartyEnded;
}

function localizeSessionReviewSummary(payload, session, userId) {
  if (!payload || typeof payload !== "object" || !session?.id || !userId) {
    return payload;
  }

  const detail = getSessionDetailForUser(session.id, userId);
  const stageReports = Array.isArray(detail?.stageReports) ? detail.stageReports : [];
  const matchingReport =
    stageReports.find((report) => report?.roundId && report.roundId === payload.roundId) || stageReports[0] || null;

  if (!matchingReport?.payload) {
    return payload;
  }

  const localizedPayload = sanitizeStageReportPayloadForViewer(
    matchingReport.payload,
    session,
    userId,
    {
      source: "inbox_session_review_stage_report",
      sessionId: session.id,
      roundId: matchingReport.roundId || payload.roundId || null
    }
  );

  return {
    ...payload,
    summary: String(localizedPayload?.summary || payload.summary || "").trim()
  };
}

function buildInboxView(userId) {
  return getInboxForUser(userId)
    .map((item) => {
      if (item.type === "human_input_request" || item.type === "sensitive_request") {
        const session = getPrechatSessionById(item.payload.sessionId);
        if (session && isSessionManualPauseActive(session)) {
          return null;
        }
      }

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

      if (item.type === "human_input_request") {
        const session = getPrechatSessionById(item.payload.sessionId);
        const counterpartUserId = session
          ? session.initiatorUserId === userId
            ? session.counterpartyUserId
            : session.initiatorUserId
          : null;
        const counterpart = counterpartUserId ? getUserById(counterpartUserId) : null;

        return {
          ...item,
          payload: {
            ...item.payload,
            counterpart: counterpart ? buildPublicUser(counterpart) : null
          }
        };
      }

      if (item.type === "session_review") {
        const session = getPrechatSessionById(item.payload.sessionId);
        const counterpartUserId = session
          ? session.initiatorUserId === userId
            ? session.counterpartyUserId
            : session.initiatorUserId
          : null;
        const counterpart = counterpartUserId ? getUserById(counterpartUserId) : null;
        const localizedPayload = session
          ? localizeSessionReviewSummary(item.payload, session, userId)
          : item.payload;

        return {
          ...item,
          payload: {
            ...localizedPayload,
            counterpart: counterpart ? buildPublicUser(counterpart) : null
          }
        };
      }

      if (item.type === "session_pause") {
        const session = getPrechatSessionById(item.payload.sessionId);
        const counterpartUserId = session
          ? session.initiatorUserId === userId
            ? session.counterpartyUserId
            : session.initiatorUserId
          : null;
        const counterpart = counterpartUserId ? getUserById(counterpartUserId) : null;

        return {
          ...item,
          payload: {
            ...item.payload,
            counterpart: counterpart ? buildPublicUser(counterpart) : null
          }
        };
      }

      return item;
    })
    .filter(Boolean);
}

function buildSessionSummary(session, currentUserId) {
  const detail = getSessionDetailForUser(session.id, currentUserId);
  const participants = getSessionParticipantProfiles(session);
  const latestStageReport = detail?.stageReports?.[0]
    ? {
        ...detail.stageReports[0],
        payload: sanitizeStageReportPayloadForViewer(detail.stageReports[0].payload, session, currentUserId, {
          source: "session_summary_stage_report",
          sessionId: session.id,
          roundId: detail.stageReports[0].roundId
        })
      }
    : null;

  return {
    ...session,
    initiator: participants.initiator
      ? { id: participants.initiator.userId, displayName: participants.initiator.displayName }
      : null,
    counterparty: participants.counterparty
      ? { id: participants.counterparty.userId, displayName: participants.counterparty.displayName }
      : null,
    latestStageReport: latestStageReport?.payload || null
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
        const twin = saveManualTwinProfile(user.id, payload.twinProfile);
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
          ? saveManualTwinProfile(user.id, payload.twinProfile)
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
        const matches = refreshMatchesForUser(user.id).filter((match) => !match.openSession);
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

        const session = await createPrechatInvitation(matchId, user.id, createPrechatSession, {
          source: "direct_invite",
          preferredObjectiveKeys: []
        });
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

      if (request.method === "POST" && url.pathname === "/api/admin/reset-and-restart-prechat") {
        if (!isLocalRequest(request)) {
          sendJson(response, 403, { error: "仅允许本机请求。" });
          return;
        }

        const payload = await parseBody(request);
        const waitMs = Math.max(0, Number(payload?.waitMs || 0));
        const job = createPrechatResetJob(waitMs);
        queueMicrotask(() => {
          runPrechatResetJob(job).catch((error) => {
            job.status = "failed";
            job.completedAt = nowIso();
            job.error = String(error?.stack || error?.message || error);
          });
        });
        sendJson(response, 202, {
          job: {
            id: job.id,
            kind: job.kind,
            status: job.status,
            waitMs: job.waitMs,
            createdAt: job.createdAt
          }
        });
        return;
      }

      if (request.method === "GET" && /^\/api\/admin\/reset-and-restart-prechat\/[^/]+$/u.test(url.pathname)) {
        if (!isLocalRequest(request)) {
          sendJson(response, 403, { error: "仅允许本机请求。" });
          return;
        }

        const jobId = extractId(url.pathname, "/api/admin/reset-and-restart-prechat/");
        const job = prechatResetJobs.get(jobId);
        if (!job) {
          sendJson(response, 404, { error: "未找到该重启任务。" });
          return;
        }

        sendJson(response, 200, { job });
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
        const result = await runSessionRound(sessionId, user.id, { trigger: "run_round" });
        const session = getSessionView(sessionId, user.id);
        sendJson(response, 200, { result, session });
        return;
      }

      if (request.method === "POST" && /^\/api\/prechat\/sessions\/[^/]+\/decision$/u.test(url.pathname)) {
        const user = requireUserOrThrow(request);
        const sessionId = extractId(url.pathname, "/api/prechat/sessions/", "/decision");
        const payload = await parseBody(request);
        const session = await applySessionDecision(sessionId, user.id, payload.action);
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

        const session = await submitHumanInput(payload.requestId, user.id, payload.responseText, {
          quotedTurnId: payload.quotedTurnId
        });
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

        const session = await sendManualMessage(sessionId, user.id, payload.content, {
          quotedTurnId: payload.quotedTurnId
        });
        sendJson(response, 201, { session, sessionId });
        return;
      }

      if (
        request.method === "POST" &&
        /^\/api\/prechat\/sessions\/[^/]+\/messages\/[^/]+\/delete$/u.test(url.pathname)
      ) {
        const user = requireUserOrThrow(request);
        const { sessionId, turnId } = extractMessageRouteIds(url.pathname);
        const session = await deleteMessageForCurrentUser(sessionId, turnId, user.id);
        sendJson(response, 200, { session });
        return;
      }

      if (
        request.method === "POST" &&
        /^\/api\/prechat\/sessions\/[^/]+\/messages\/[^/]+\/recall$/u.test(url.pathname)
      ) {
        const user = requireUserOrThrow(request);
        const { sessionId, turnId } = extractMessageRouteIds(url.pathname);
        const session = await recallMessage(sessionId, turnId, user.id);
        sendJson(response, 200, { session });
        return;
      }

      if (
        request.method === "POST" &&
        /^\/api\/prechat\/sessions\/[^/]+\/messages\/[^/]+\/edit$/u.test(url.pathname)
      ) {
        const user = requireUserOrThrow(request);
        const { sessionId, turnId } = extractMessageRouteIds(url.pathname);
        const payload = await parseBody(request);

        if (!payload.content) {
          throw new Error("缺少修改后的消息内容。");
        }

        const session = await editMessage(sessionId, turnId, user.id, payload.content);
        sendJson(response, 200, { session });
        return;
      }

      if (
        request.method === "POST" &&
        /^\/api\/prechat\/sessions\/[^/]+\/messages\/[^/]+\/react$/u.test(url.pathname)
      ) {
        const user = requireUserOrThrow(request);
        const { sessionId, turnId } = extractMessageRouteIds(url.pathname);
        const payload = await parseBody(request);

        if (!payload.emoji) {
          throw new Error("缺少消息反应。");
        }

        const session = await reactToMessage(sessionId, turnId, user.id, payload.emoji);
        sendJson(response, 200, { session });
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
