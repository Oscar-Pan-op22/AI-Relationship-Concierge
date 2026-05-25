import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SENSITIVE_TOPIC_CATEGORIES } from "./lib/constants.js";
import { buildScreeningReport } from "./lib/screeningEngine.js";
import { loadReports, saveReport } from "./lib/storage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");
const port = Number(process.env.PORT || 3000);

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
      } catch (error) {
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

function serveStatic(requestPath, response) {
  const safePath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.join(publicDir, safePath);

  if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendText(response, 404, "未找到页面。");
    return;
  }

  sendText(response, 200, fs.readFileSync(filePath), getContentType(filePath));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, phase: "phase_1_due_diligence" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/config") {
      sendJson(response, 200, { sensitiveTopicCategories: SENSITIVE_TOPIC_CATEGORIES });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/reports") {
      sendJson(response, 200, { reports: loadReports() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/reports") {
      const payload = await parseBody(request);
      const report = buildScreeningReport(payload);
      saveReport(report);
      sendJson(response, 201, { report });
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
