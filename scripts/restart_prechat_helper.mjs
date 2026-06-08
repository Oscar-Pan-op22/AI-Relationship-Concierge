import fs from "node:fs/promises";
import process from "node:process";
import {
  getAllUsers,
  getCurrentTwin,
  listMatchesForUser,
  createPrechatSession
} from "../src/lib/database.js";
import { refreshMatchesForUser } from "../src/lib/matchService.js";
import { createPrechatInvitation, acceptInvitation } from "../src/lib/prechatService.js";

function parseWaitMs(rawValue) {
  const parsed = Number(rawValue || "1500");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1500;
}

function isRealUser(user) {
  const name = String(user?.displayName || "").trim();
  return Boolean(name) && !/^\?+$/u.test(name) && !/^\uFFFD+$/u.test(name);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function maybeWriteSummary(summaryPath, payload) {
  if (!summaryPath) {
    return;
  }
  await fs.writeFile(summaryPath, JSON.stringify(payload, null, 2), "utf8");
}

async function runRestart(waitMs) {
  const users = getAllUsers().filter(isRealUser).filter((user) => getCurrentTwin(user.id));

  for (const user of users) {
    refreshMatchesForUser(user.id);
  }

  const seenMatchIds = new Set();
  const createdSessions = [];

  for (const user of users) {
    const matches = listMatchesForUser(user.id);
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

  if (waitMs > 0) {
    await sleep(waitMs);
  }

  return {
    userCount: users.length,
    sessionCount: createdSessions.length,
    acceptedSessions
  };
}

async function main() {
  const waitMs = parseWaitMs(process.argv[2]);
  const summaryPath = process.argv[3] || "";
  const startedAt = new Date().toISOString();
  const summary = await runRestart(waitMs);
  const payload = {
    startedAt,
    completedAt: new Date().toISOString(),
    waitMs,
    ...summary
  };

  await maybeWriteSummary(summaryPath, payload);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main().catch(async (error) => {
  const summaryPath = process.argv[3] || "";
  const payload = {
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    waitMs: parseWaitMs(process.argv[2]),
    error: String(error?.stack || error?.message || error)
  };
  try {
    await maybeWriteSummary(summaryPath, payload);
  } catch {
    // Ignore summary write failures during crash handling.
  }
  process.stderr.write(`${payload.error}\n`);
  process.exitCode = 1;
});
