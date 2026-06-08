import fs from "node:fs/promises";
import process from "node:process";
import { getPrechatSessionById, listPrechatRounds } from "../src/lib/database.js";
import { regenerateStageSummary } from "../src/lib/prechatService.js";

function parseArgs(argv) {
  const args = {
    sessionIds: [],
    roundId: "",
    all: false,
    output: ""
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = String(argv[index] || "").trim();

    if (!token) {
      continue;
    }

    if (token === "--all") {
      args.all = true;
      continue;
    }

    if (token === "--session-id") {
      args.sessionIds.push(String(argv[index + 1] || "").trim());
      index += 1;
      continue;
    }

    if (token === "--round-id") {
      args.roundId = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }

    if (token === "--output") {
      args.output = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
  }

  return args;
}

async function maybeWriteOutput(outputPath, payload) {
  if (!outputPath) {
    return;
  }

  await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), "utf8");
}

function dedupe(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

async function listSessionIdsForAllMode() {
  const databasePath = process.env.TONGPIN_DB_PATH || "";

  if (!databasePath) {
    throw new Error("缺少 TONGPIN_DB_PATH，无法扫描全部预沟通会话。");
  }

  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    const rows = database
      .prepare(`
        SELECT id
        FROM prechat_sessions
        ORDER BY created_at ASC
      `)
      .all();
    return rows.map((row) => String(row.id || "").trim()).filter(Boolean);
  } finally {
    database.close();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = new Date().toISOString();
  const requestedSessionIds = dedupe(args.sessionIds);
  const sessionIds = args.all ? await listSessionIdsForAllMode() : requestedSessionIds;

  if (!sessionIds.length) {
    throw new Error("请传入 --session-id <id>，或使用 --all。");
  }

  const results = [];

  for (const sessionId of sessionIds) {
    const session = getPrechatSessionById(sessionId);

    if (!session) {
      results.push({
        sessionId,
        status: "missing_session"
      });
      continue;
    }

    const rounds = listPrechatRounds(sessionId);
    if (!rounds.length) {
      results.push({
        sessionId,
        status: "no_rounds"
      });
      continue;
    }

    const regenerated = await regenerateStageSummary(sessionId, {
      roundId: args.roundId || null
    });

    results.push({
      sessionId,
      roundId: regenerated.roundId,
      reportId: regenerated.reportId,
      replacedExisting: regenerated.replacedExisting,
      status: "regenerated"
    });
  }

  const payload = {
    startedAt,
    completedAt: new Date().toISOString(),
    sessionCount: sessionIds.length,
    regeneratedCount: results.filter((item) => item.status === "regenerated").length,
    results
  };

  await maybeWriteOutput(args.output, payload);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main().catch(async (error) => {
  const args = parseArgs(process.argv);
  const payload = {
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: String(error?.stack || error?.message || error)
  };
  try {
    await maybeWriteOutput(args.output, payload);
  } catch {
    // Ignore secondary write failures.
  }
  process.stderr.write(`${payload.error}\n`);
  process.exitCode = 1;
});
