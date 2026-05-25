import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REALITY_FIELD_DEFS, SENSITIVE_TOPIC_CATEGORIES } from "./lib/constants.js";
import {
  getCandidatePool,
  getCandidatePoolCount,
  getDatabasePath,
  getProfile,
  listProfiles,
  loadReports,
  saveProfile,
  saveReport
} from "./lib/database.js";
import { buildMatchReport, REPORT_SCHEMA_VERSION } from "./lib/matchingEngine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");
const port = Number(process.env.PORT || 3000);
const phase = "phase_1_matching_shortlist";
const phaseLabel = "用户单侧建档与数据库初筛";

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function sendText(response, statusCode, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, { "Content-Type": contentType });
  response.end(body);
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";

    request.on("data", (chunk) => {
      raw += chunk;

      if (raw.length > 1_000_000) {
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
  if (filePath.endsWith(".svg")) return "image/svg+xml";
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

function serveStatic(requestPath, response) {
  const filePath = resolvePublicFile(requestPath);

  if (!filePath) {
    sendText(response, 404, "未找到页面。");
    return;
  }

  sendText(response, 200, fs.readFileSync(filePath), getContentType(filePath));
}

function extractProfileId(pathname) {
  const prefix = "/api/profiles/";
  return pathname.startsWith(prefix) ? decodeURIComponent(pathname.slice(prefix.length)) : "";
}

function requireTwinProfile(payload) {
  if (!payload?.twinProfile || typeof payload.twinProfile !== "object") {
    throw new Error("缺少 Twin 档案内容。");
  }
}

function buildReportFromProfile(profileId, rawTwinProfile) {
  const candidatePool = getCandidatePool();
  const report = buildMatchReport({ twinProfile: rawTwinProfile }, { candidatePool });
  return saveReport(report, profileId);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, {
        ok: true,
        phase,
        phaseLabel,
        databasePath: getDatabasePath()
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
        realityFieldDefs: REALITY_FIELD_DEFS
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/profiles") {
      sendJson(response, 200, { profiles: listProfiles() });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/profiles/")) {
      const profileId = extractProfileId(url.pathname);
      const profile = getProfile(profileId);

      if (!profile) {
        sendJson(response, 404, { error: "未找到该 Twin 档案。" });
        return;
      }

      sendJson(response, 200, { profile });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/profiles") {
      const payload = await parseBody(request);
      requireTwinProfile(payload);
      const profile = saveProfile({
        id: payload.profileId || payload.id || "",
        twinProfile: payload.twinProfile
      });
      sendJson(response, 201, { profile });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/reports") {
      sendJson(response, 200, {
        reports: loadReports({
          schemaVersion: REPORT_SCHEMA_VERSION,
          profileId: url.searchParams.get("profileId") || ""
        })
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/reports") {
      const payload = await parseBody(request);
      let profile = null;

      if (payload.twinProfile) {
        profile = saveProfile({
          id: payload.profileId || "",
          twinProfile: payload.twinProfile
        });
      } else if (payload.profileId) {
        profile = getProfile(payload.profileId);
      }

      if (!profile) {
        throw new Error("生成匹配报告前，需要先提供或保存 Twin 档案。");
      }

      const report = buildReportFromProfile(profile.id, profile.twinProfile);
      sendJson(response, 201, { report, profile });
      return;
    }

    if (request.method === "GET") {
      serveStatic(url.pathname, response);
      return;
    }

    sendJson(response, 404, { error: "接口不存在。" });
  } catch (error) {
    sendJson(response, 400, { error: error.message || "发生了未预期的错误。" });
  }
});

server.listen(port, () => {
  console.log(`同频 Phase 1 工作台已启动：http://localhost:${port}`);
});
