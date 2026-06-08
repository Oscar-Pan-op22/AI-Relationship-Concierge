import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MOCK_CANDIDATE_POOL } from "./mockCandidatePool.js";

let activeDatabase = null;
let activeDatabasePath = "";
let overriddenDatabasePath = "";

function nowIso() {
  return new Date().toISOString();
}

function resolveDatabasePath() {
  return (
    overriddenDatabasePath ||
    process.env.TONGPIN_DB_PATH ||
    path.join(process.cwd(), "data", "tongpin.sqlite")
  );
}

function ensureParentDir(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
}

function parseJson(value, fallback = null) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stableStringify(value) {
  return JSON.stringify(value ?? {});
}

function getSessionParticipantRole(session, userId) {
  return session?.initiatorUserId === userId ? "initiator" : "counterparty";
}

function getObjectivesCompletedReviewInboxEntry(session) {
  const reviewInbox = session?.control?.reviewInbox;
  const entry = reviewInbox?.objectivesCompleted;

  if (!entry || typeof entry !== "object") {
    return null;
  }

  return {
    roundId: String(entry.roundId || "").trim() || null,
    roundNumber: Number.isFinite(Number(entry.roundNumber)) ? Math.max(0, Number(entry.roundNumber)) : 0,
    emittedAt: String(entry.emittedAt || "").trim() || null,
    seenByRole: {
      initiator: String(entry?.seenByRole?.initiator || "").trim() || null,
      counterparty: String(entry?.seenByRole?.counterparty || "").trim() || null
    }
  };
}

function shouldShowObjectivesCompletedReviewInbox(session, latestRound, userId) {
  if (!session || !latestRound) {
    return false;
  }

  if (session.status !== "paused_review" || latestRound.stopReason !== "objectives_completed") {
    return false;
  }
  return true;
}

function getPauseKindFromSessionAndRound(session, latestRound) {
  const stopReason = String(latestRound?.stopReason || "").trim();

  if (stopReason === "outstanding_twin_question_unanswered") {
    return "outstanding_twin_question";
  }

  if (stopReason === "max_turns_reached") {
    return "max_turns_reached";
  }

  if (stopReason === "paused_review") {
    return session?.status === "active" ? "automation_stuck_active_round_paused" : "generic_paused_review";
  }

  return null;
}

function getPauseSummary(stopReason, pauseKind) {
  if (stopReason === "outstanding_twin_question_unanswered" || pauseKind === "outstanding_twin_question") {
    return "当前预沟通暂停，对方还有一个 Twin 问题未完成处理，点击查看会话。";
  }

  if (stopReason === "max_turns_reached" || pauseKind === "max_turns_reached") {
    return "当前轮次已达到上限，预沟通暂停，点击进入会话查看最新进展。";
  }

  if (stopReason === "paused_review") {
    return "当前预沟通已暂停，系统未继续自动推进，点击查看会话。";
  }

  return "当前预沟通已暂停，点击查看会话。";
}

function getPauseNoticeReviewInboxEntry(session) {
  const reviewInbox = session?.control?.reviewInbox;
  const entry = reviewInbox?.pauseNotice;

  if (!entry || typeof entry !== "object") {
    return null;
  }

  return {
    roundId: String(entry.roundId || "").trim() || null,
    roundNumber: Number.isFinite(Number(entry.roundNumber)) ? Math.max(0, Number(entry.roundNumber)) : 0,
    stopReason: String(entry.stopReason || "").trim() || null,
    pauseKind: String(entry.pauseKind || "").trim() || null,
    emittedAt: String(entry.emittedAt || "").trim() || null,
    seenByRole: {
      initiator: String(entry?.seenByRole?.initiator || "").trim() || null,
      counterparty: String(entry?.seenByRole?.counterparty || "").trim() || null
    }
  };
}

function shouldShowPauseNoticeReviewInbox(session, latestRound, userId) {
  if (!session || !latestRound) {
    return false;
  }

  const stopReason = String(latestRound.stopReason || "").trim();
  if (stopReason === "deferred_model_retry") {
    return false;
  }
  const isPauseLikeStop = ["outstanding_twin_question_unanswered", "paused_review", "max_turns_reached"].includes(stopReason);
  const isEffectivePausedStatus = session.status === "paused_review";

  if (!isEffectivePausedStatus || !isPauseLikeStop || stopReason === "objectives_completed") {
    return false;
  }
  return true;
}

function canonicalPair(userAId, userBId) {
  return [userAId, userBId].sort();
}

function dedupeRowsBy(rows, getKey) {
  const seen = new Set();
  const nextRows = [];

  for (const row of rows) {
    const key = getKey(row);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    nextRows.push(row);
  }

  return nextRows;
}

function isBrokenPlaceholderText(value) {
  const text = String(value || "").trim();

  if (!text) {
    return true;
  }

  return /^\?{2,}$/u.test(text) || /^\uFFFD+$/u.test(text);
}

function initializeSchema(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS twin_profile_versions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      display_name TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, version_number)
    );

    CREATE TABLE IF NOT EXISTS current_twin_state_users (
      user_id TEXT PRIMARY KEY,
      twin_version_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      runtime_state_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (twin_version_id) REFERENCES twin_profile_versions(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS candidate_profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      city TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS match_reports (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      twin_version_id TEXT,
      schema_version INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (twin_version_id) REFERENCES twin_profile_versions(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      user_a_id TEXT NOT NULL,
      user_b_id TEXT NOT NULL,
      score REAL NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_a_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (user_b_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_a_id, user_b_id)
    );

    CREATE TABLE IF NOT EXISTS prechat_sessions (
      id TEXT PRIMARY KEY,
      match_id TEXT NOT NULL,
      initiator_user_id TEXT NOT NULL,
      counterparty_user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      current_round INTEGER NOT NULL DEFAULT 0,
      latest_stage_report_id TEXT,
      control_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
      FOREIGN KEY (initiator_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (counterparty_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS prechat_rounds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      round_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      stop_reason TEXT,
      objective_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES prechat_sessions(id) ON DELETE CASCADE,
      UNIQUE(session_id, round_number)
    );

    CREATE TABLE IF NOT EXISTS conversation_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      round_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      actor_user_id TEXT,
      actor_role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES prechat_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (round_id) REFERENCES prechat_rounds(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS extracted_facts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      round_id TEXT NOT NULL,
      subject_user_id TEXT,
      fact_key TEXT NOT NULL,
      fact_value TEXT NOT NULL,
      confidence REAL NOT NULL,
      source_turn_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES prechat_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (round_id) REFERENCES prechat_rounds(id) ON DELETE CASCADE,
      FOREIGN KEY (source_turn_id) REFERENCES conversation_turns(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS stage_reports (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      round_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES prechat_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (round_id) REFERENCES prechat_rounds(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sensitive_question_requests (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      round_id TEXT NOT NULL,
      requesting_user_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      question_text TEXT NOT NULL,
      topic_category TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      metadata_json TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES prechat_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (round_id) REFERENCES prechat_rounds(id) ON DELETE CASCADE,
      FOREIGN KEY (requesting_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS human_input_requests (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      round_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      field_key TEXT NOT NULL,
      question_text TEXT NOT NULL,
      status TEXT NOT NULL,
      response_text TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      metadata_json TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES prechat_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (round_id) REFERENCES prechat_rounds(id) ON DELETE CASCADE,
      FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_a ON matches(user_a_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_b ON matches(user_b_id);
    CREATE INDEX IF NOT EXISTS idx_prechat_user_a ON prechat_sessions(initiator_user_id);
    CREATE INDEX IF NOT EXISTS idx_prechat_user_b ON prechat_sessions(counterparty_user_id);
    CREATE INDEX IF NOT EXISTS idx_sensitive_target ON sensitive_question_requests(target_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_human_input_target ON human_input_requests(target_user_id, status);
  `);

  ensureColumn(database, "match_reports", "user_id", "TEXT");
  ensureColumn(database, "twin_profile_versions", "user_id", "TEXT");
  ensureColumn(database, "prechat_sessions", "control_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(database, "current_twin_state_users", "runtime_state_json", "TEXT NOT NULL DEFAULT '{}'");
  backfillTwinVersionUserIds(database);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_reports_user ON match_reports(user_id, created_at DESC);`);
}

function ensureColumn(database, tableName, columnName, columnDefinition) {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all();
  const hasColumn = columns.some((column) => column.name === columnName);

  if (!hasColumn) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
}

function backfillTwinVersionUserIds(database) {
  const columns = database.prepare(`PRAGMA table_info(twin_profile_versions)`).all();
  const hasUserId = columns.some((column) => column.name === "user_id");

  if (!hasUserId) {
    return;
  }

  database.exec(`
    UPDATE twin_profile_versions
    SET user_id = (
      SELECT current_twin_state_users.user_id
      FROM current_twin_state_users
      WHERE current_twin_state_users.twin_version_id = twin_profile_versions.id
      LIMIT 1
    )
    WHERE user_id IS NULL
  `);
}

function seedCandidatePool(database) {
  const upsert = database.prepare(`
    INSERT INTO candidate_profiles (
      id, display_name, city, payload_json, active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      city = excluded.city,
      payload_json = excluded.payload_json,
      active = 1,
      updated_at = excluded.updated_at
  `);
  const timestamp = nowIso();

  database.exec("BEGIN");

  try {
    for (const candidate of MOCK_CANDIDATE_POOL) {
      upsert.run(
        candidate.id,
        candidate.displayName,
        candidate.city,
        JSON.stringify(candidate),
        timestamp,
        timestamp
      );
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function getDatabase() {
  const databasePath = resolveDatabasePath();

  if (activeDatabase && activeDatabasePath === databasePath) {
    return activeDatabase;
  }

  if (activeDatabase) {
    activeDatabase.close();
  }

  ensureParentDir(databasePath);

  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  initializeSchema(database);
  seedCandidatePool(database);

  activeDatabase = database;
  activeDatabasePath = databasePath;

  return database;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function toCurrentTwin(row) {
  if (!row) {
    return null;
  }

  const manualProfile = parseJson(row.payload_json, {});
  const runtimeState = parseJson(row.runtime_state_json, {});

  return {
    userId: row.user_id,
    twinVersionId: row.twin_version_id,
    twinVersionNumber: row.version_number,
    displayName: row.display_name,
    twinProfile: manualProfile,
    manualProfile,
    runtimeState,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toMatchRow(row, currentUserId) {
  const counterpartId = row.user_a_id === currentUserId ? row.user_b_id : row.user_a_id;
  const counterpart =
    row.user_a_id === currentUserId
      ? {
          id: row.user_b_id,
          displayName: row.user_b_name,
          email: row.user_b_email
        }
      : {
          id: row.user_a_id,
          displayName: row.user_a_name,
          email: row.user_a_email
        };

  return {
    id: row.id,
    userAId: row.user_a_id,
    userBId: row.user_b_id,
    counterpartId,
    counterpart,
    score: row.score,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function getDatabasePath() {
  return resolveDatabasePath();
}

export function clearPrechatHistoryData() {
  const database = getDatabase();
  const tables = [
    "conversation_turns",
    "stage_reports",
    "human_input_requests",
    "sensitive_question_requests",
    "prechat_rounds",
    "prechat_sessions"
  ];

  database.exec("BEGIN");
  try {
    for (const table of tables) {
      database.exec(`DELETE FROM ${table}`);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function resetDatabaseForTests(databasePath = "") {
  if (activeDatabase) {
    activeDatabase.close();
    activeDatabase = null;
    activeDatabasePath = "";
  }

  overriddenDatabasePath = databasePath;
}

export function createUser({ email, displayName, passwordHash }) {
  const database = getDatabase();
  const id = crypto.randomUUID();
  const timestamp = nowIso();

  database
    .prepare(`
      INSERT INTO users (id, email, display_name, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(id, email.toLowerCase(), displayName.trim(), passwordHash, timestamp, timestamp);

  return getUserById(id);
}

export function getUserById(userId) {
  const database = getDatabase();
  const row = database
    .prepare(`
      SELECT id, email, display_name, password_hash, created_at, updated_at
      FROM users
      WHERE id = ?
    `)
    .get(userId);

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function getUserByEmail(email) {
  const database = getDatabase();
  const row = database
    .prepare(`
      SELECT id, email, display_name, password_hash, created_at, updated_at
      FROM users
      WHERE email = ?
    `)
    .get(email.toLowerCase());

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createUserSession(userId, rawToken, expiresAt) {
  const database = getDatabase();
  const id = crypto.randomUUID();
  const timestamp = nowIso();

  database
    .prepare(`
      INSERT INTO user_sessions (id, user_id, session_token_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(id, userId, hashToken(rawToken), timestamp, expiresAt);

  return { id, userId, createdAt: timestamp, expiresAt };
}

export function getUserBySessionToken(rawToken) {
  const database = getDatabase();
  const tokenHash = hashToken(rawToken);
  const row = database
    .prepare(`
      SELECT
        users.id,
        users.email,
        users.display_name,
        users.password_hash,
        users.created_at,
        users.updated_at,
        user_sessions.expires_at
      FROM user_sessions
      JOIN users ON users.id = user_sessions.user_id
      WHERE user_sessions.session_token_hash = ?
    `)
    .get(tokenHash);

  if (!row) {
    return null;
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    deleteUserSession(rawToken);
    return null;
  }

  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function deleteUserSession(rawToken) {
  const database = getDatabase();

  database
    .prepare(`DELETE FROM user_sessions WHERE session_token_hash = ?`)
    .run(hashToken(rawToken));
}

export function getCurrentTwin(userId) {
  if (!userId) {
    return null;
  }

  const database = getDatabase();
  const row = database
    .prepare(`
      SELECT
        current_twin_state_users.user_id,
        current_twin_state_users.twin_version_id,
        current_twin_state_users.display_name,
        current_twin_state_users.payload_json,
        current_twin_state_users.runtime_state_json,
        current_twin_state_users.created_at,
        current_twin_state_users.updated_at,
        twin_profile_versions.version_number
      FROM current_twin_state_users
      JOIN twin_profile_versions
        ON twin_profile_versions.id = current_twin_state_users.twin_version_id
      WHERE current_twin_state_users.user_id = ?
    `)
    .get(userId);

  return toCurrentTwin(row);
}

export function saveCurrentTwin(userId, twinProfile) {
  return saveManualTwinProfile(userId, twinProfile);
}

export function saveManualTwinProfile(userId, twinProfile) {
  const database = getDatabase();
  const currentTwin = getCurrentTwin(userId);
  const payloadJson = stableStringify(twinProfile);
  const displayName = String(twinProfile?.displayName || "").trim() || "未命名用户";

  if (currentTwin && stableStringify(currentTwin.manualProfile) === payloadJson) {
    return currentTwin;
  }

  const timestamp = nowIso();
  const versionRow = database
    .prepare(`
      SELECT COALESCE(MAX(version_number), 0) AS max_version
      FROM twin_profile_versions
      WHERE user_id = ?
    `)
    .get(userId);
  const versionId = crypto.randomUUID();
  const versionNumber = Number(versionRow?.max_version || 0) + 1;

  database.exec("BEGIN");

  try {
    database
      .prepare(`
        INSERT INTO twin_profile_versions (
          id, user_id, version_number, display_name, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(versionId, userId, versionNumber, displayName, payloadJson, timestamp);

    database
      .prepare(`
        INSERT INTO current_twin_state_users (
          user_id, twin_version_id, display_name, payload_json, runtime_state_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          twin_version_id = excluded.twin_version_id,
          display_name = excluded.display_name,
          payload_json = excluded.payload_json,
          runtime_state_json = COALESCE(current_twin_state_users.runtime_state_json, '{}'),
          updated_at = excluded.updated_at
      `)
      .run(
        userId,
        versionId,
        displayName,
        payloadJson,
        JSON.stringify(currentTwin?.runtimeState || {}),
        currentTwin?.createdAt || timestamp,
        timestamp
      );

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return getCurrentTwin(userId);
}

export function saveTwinRuntimeState(userId, runtimePatch) {
  const database = getDatabase();
  const currentTwin = getCurrentTwin(userId);

  if (!currentTwin) {
    throw new Error("未找到当前 Twin。");
  }

  const nextRuntimeState = {
    ...(currentTwin.runtimeState || {}),
    ...(runtimePatch && typeof runtimePatch === "object" ? runtimePatch : {})
  };
  const nextRuntimeJson = JSON.stringify(nextRuntimeState);

  if (stableStringify(currentTwin.runtimeState || {}) === nextRuntimeJson) {
    return currentTwin;
  }

  database
    .prepare(`
      UPDATE current_twin_state_users
      SET runtime_state_json = ?, updated_at = ?
      WHERE user_id = ?
    `)
    .run(nextRuntimeJson, nowIso(), userId);

  return getCurrentTwin(userId);
}

export function listMatchableUsers(excludedUserId) {
  const database = getDatabase();
  const rows = database
    .prepare(`
      SELECT
        users.id,
        users.email,
        users.display_name,
        current_twin_state_users.twin_version_id,
        current_twin_state_users.payload_json,
        current_twin_state_users.runtime_state_json,
        twin_profile_versions.version_number
      FROM current_twin_state_users
      JOIN users ON users.id = current_twin_state_users.user_id
      JOIN twin_profile_versions
        ON twin_profile_versions.id = current_twin_state_users.twin_version_id
      WHERE users.id <> ?
      ORDER BY users.created_at ASC
    `)
    .all(excludedUserId);

  return rows
    .map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      twinVersionId: row.twin_version_id,
      twinVersionNumber: row.version_number,
      twinProfile: parseJson(row.payload_json, {}),
      manualProfile: parseJson(row.payload_json, {}),
      runtimeState: parseJson(row.runtime_state_json, {})
    }))
    .filter((user) => {
      const twinDisplayName = String(user.twinProfile?.displayName || user.displayName || "").trim();
      return !isBrokenPlaceholderText(user.displayName) && !isBrokenPlaceholderText(twinDisplayName);
    });
}

export function upsertMatch(userAId, userBId, score, status = "matched") {
  const database = getDatabase();
  const [leftId, rightId] = canonicalPair(userAId, userBId);
  const existing = database
    .prepare(`SELECT id, created_at FROM matches WHERE user_a_id = ? AND user_b_id = ?`)
    .get(leftId, rightId);
  const timestamp = nowIso();
  const matchId = existing?.id || crypto.randomUUID();

  database
    .prepare(`
      INSERT INTO matches (id, user_a_id, user_b_id, score, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_a_id, user_b_id) DO UPDATE SET
        score = excluded.score,
        status = excluded.status,
        updated_at = excluded.updated_at
    `)
    .run(
      matchId,
      leftId,
      rightId,
      score,
      status,
      existing?.created_at || timestamp,
      timestamp
    );

  return matchId;
}

export function listMatchesForUser(userId) {
  const database = getDatabase();
  const rows = database
    .prepare(`
      SELECT
        matches.*,
        ua.email AS user_a_email,
        ua.display_name AS user_a_name,
        ub.email AS user_b_email,
        ub.display_name AS user_b_name
      FROM matches
      JOIN users ua ON ua.id = matches.user_a_id
      JOIN users ub ON ub.id = matches.user_b_id
      WHERE matches.user_a_id = ? OR matches.user_b_id = ?
      ORDER BY matches.score DESC, matches.updated_at DESC
    `)
    .all(userId, userId);

  return rows.map((row) => toMatchRow(row, userId));
}

export function getMatchForUser(matchId, userId) {
  const database = getDatabase();
  const row = database
    .prepare(`
      SELECT
        matches.*,
        ua.email AS user_a_email,
        ua.display_name AS user_a_name,
        ub.email AS user_b_email,
        ub.display_name AS user_b_name
      FROM matches
      JOIN users ua ON ua.id = matches.user_a_id
      JOIN users ub ON ub.id = matches.user_b_id
      WHERE matches.id = ?
        AND (matches.user_a_id = ? OR matches.user_b_id = ?)
    `)
    .get(matchId, userId, userId);

  if (!row) {
    return null;
  }

  return toMatchRow(row, userId);
}

export function getCounterpartTwin(userId) {
  const twin = getCurrentTwin(userId);

  if (!twin) {
    return null;
  }

  const user = getUserById(userId);

  return {
    userId,
    email: user?.email || "",
    displayName: twin.displayName,
    twinVersionId: twin.twinVersionId,
    twinVersionNumber: twin.twinVersionNumber,
    twinProfile: twin.twinProfile
  };
}

export function createPrechatSession({
  matchId,
  initiatorUserId,
  counterpartyUserId,
  control = null
}) {
  const database = getDatabase();
  const existing = database
    .prepare(`
      SELECT *
      FROM prechat_sessions
      WHERE match_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `)
    .get(matchId);

  if (existing) {
    return getPrechatSessionForUser(existing.id, initiatorUserId);
  }

  const id = crypto.randomUUID();
  const timestamp = nowIso();

  const initialControl =
    control && typeof control === "object"
      ? control
      : {
          manualPause: {
            initiatorEnded: false,
            counterpartyEnded: false,
            messageCountByRole: {
              initiator: 0,
              counterparty: 0
            }
          }
        };

  database
    .prepare(`
      INSERT INTO prechat_sessions (
        id, match_id, initiator_user_id, counterparty_user_id, status, current_round, latest_stage_report_id, control_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)
    `)
    .run(
      id,
      matchId,
      initiatorUserId,
      counterpartyUserId,
      "awaiting_counterparty_acceptance",
      JSON.stringify(initialControl),
      timestamp,
      timestamp
    );

  return getPrechatSessionForUser(id, initiatorUserId);
}

export function updatePrechatSession(sessionId, patch) {
  const database = getDatabase();
  const current = database
    .prepare(`SELECT * FROM prechat_sessions WHERE id = ?`)
    .get(sessionId);

  if (!current) {
    return null;
  }

  const next = {
    status: patch.status ?? current.status,
    current_round: patch.currentRound ?? current.current_round,
    latest_stage_report_id: patch.latestStageReportId ?? current.latest_stage_report_id,
    control_json:
      patch.control != null ? JSON.stringify(patch.control) : current.control_json || JSON.stringify({}),
    updated_at: patch.updatedAt ?? nowIso()
  };

  database
    .prepare(`
      UPDATE prechat_sessions
      SET status = ?, current_round = ?, latest_stage_report_id = ?, control_json = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(next.status, next.current_round, next.latest_stage_report_id, next.control_json, next.updated_at, sessionId);

  return true;
}

export function listPrechatSessionsForUser(userId) {
  const database = getDatabase();
  const rows = dedupeRowsBy(
    database
    .prepare(`
      SELECT *
      FROM prechat_sessions
      WHERE initiator_user_id = ? OR counterparty_user_id = ?
      ORDER BY updated_at DESC
    `)
    .all(userId, userId),
    (row) => row.match_id
  );

  return rows.map((row) => ({
    id: row.id,
    matchId: row.match_id,
    initiatorUserId: row.initiator_user_id,
    counterpartyUserId: row.counterparty_user_id,
    status: row.status,
    currentRound: row.current_round,
    latestStageReportId: row.latest_stage_report_id,
    control: parseJson(row.control_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export function getPrechatSessionForUser(sessionId, userId) {
  const database = getDatabase();
  const row = database
    .prepare(`
      SELECT *
      FROM prechat_sessions
      WHERE id = ?
        AND (initiator_user_id = ? OR counterparty_user_id = ?)
    `)
    .get(sessionId, userId, userId);

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    matchId: row.match_id,
    initiatorUserId: row.initiator_user_id,
    counterpartyUserId: row.counterparty_user_id,
    status: row.status,
    currentRound: row.current_round,
    latestStageReportId: row.latest_stage_report_id,
    control: parseJson(row.control_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function getPrechatSessionById(sessionId) {
  const database = getDatabase();
  const row = database.prepare(`SELECT * FROM prechat_sessions WHERE id = ?`).get(sessionId);

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    matchId: row.match_id,
    initiatorUserId: row.initiator_user_id,
    counterpartyUserId: row.counterparty_user_id,
    status: row.status,
    currentRound: row.current_round,
    latestStageReportId: row.latest_stage_report_id,
    control: parseJson(row.control_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createPrechatRound({ sessionId, roundNumber, objective }) {
  const database = getDatabase();
  const id = crypto.randomUUID();
  const timestamp = nowIso();

  database
    .prepare(`
      INSERT INTO prechat_rounds (
        id, session_id, round_number, status, stop_reason, objective_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
    `)
    .run(id, sessionId, roundNumber, "active", JSON.stringify(objective), timestamp, timestamp);

  return {
    id,
    sessionId,
    roundNumber,
    status: "active",
    stopReason: null,
    objective,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function finishPrechatRound(roundId, { status, stopReason }) {
  const database = getDatabase();
  const timestamp = nowIso();

  database
    .prepare(`
      UPDATE prechat_rounds
      SET status = ?, stop_reason = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(status, stopReason, timestamp, roundId);
}

export function updatePrechatRoundObjective(roundId, objective) {
  const database = getDatabase();
  const timestamp = nowIso();

  database
    .prepare(`
      UPDATE prechat_rounds
      SET objective_json = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(JSON.stringify(objective ?? {}), timestamp, roundId);
}

export function getPrechatRound(roundId) {
  const database = getDatabase();
  const row = database.prepare(`SELECT * FROM prechat_rounds WHERE id = ?`).get(roundId);

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    roundNumber: row.round_number,
    status: row.status,
    stopReason: row.stop_reason,
    objective: parseJson(row.objective_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function listPrechatRounds(sessionId) {
  const database = getDatabase();
  const rows = database
    .prepare(`
      SELECT *
      FROM prechat_rounds
      WHERE session_id = ?
      ORDER BY round_number ASC
    `)
    .all(sessionId);

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    roundNumber: row.round_number,
    status: row.status,
    stopReason: row.stop_reason,
    objective: parseJson(row.objective_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export function addConversationTurn({
  sessionId,
  roundId,
  turnNumber,
  actorUserId = null,
  actorRole,
  content,
  metadata = {}
}) {
  const database = getDatabase();
  const id = crypto.randomUUID();
  const timestamp = nowIso();

  database
    .prepare(`
      INSERT INTO conversation_turns (
        id, session_id, round_id, turn_number, actor_user_id, actor_role, content, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      sessionId,
      roundId,
      turnNumber,
      actorUserId,
      actorRole,
      content,
      JSON.stringify(metadata),
      timestamp
    );

  return {
    id,
    sessionId,
    roundId,
    turnNumber,
    actorUserId,
    actorRole,
    content,
    metadata,
    createdAt: timestamp
  };
}

export function getConversationTurnById(turnId) {
  const database = getDatabase();
  const row = database.prepare(`SELECT * FROM conversation_turns WHERE id = ?`).get(turnId);

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    roundId: row.round_id,
    turnNumber: row.turn_number,
    actorUserId: row.actor_user_id,
    actorRole: row.actor_role,
    content: row.content,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at
  };
}

export function listConversationTurns(sessionId) {
  const database = getDatabase();
  const rows = database
    .prepare(`
      SELECT *
      FROM conversation_turns
      WHERE session_id = ?
      ORDER BY created_at ASC, turn_number ASC
    `)
    .all(sessionId);

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    roundId: row.round_id,
    turnNumber: row.turn_number,
    actorUserId: row.actor_user_id,
    actorRole: row.actor_role,
    content: row.content,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at
  }));
}

export function updateConversationTurn(turnId, patch = {}) {
  const database = getDatabase();
  const current = database.prepare(`SELECT * FROM conversation_turns WHERE id = ?`).get(turnId);

  if (!current) {
    return null;
  }

  const next = {
    content: patch.content ?? current.content,
    metadata_json:
      patch.metadata != null ? JSON.stringify(patch.metadata) : current.metadata_json || JSON.stringify({}),
    id: turnId
  };

  database
    .prepare(`
      UPDATE conversation_turns
      SET content = ?, metadata_json = ?
      WHERE id = ?
    `)
    .run(next.content, next.metadata_json, next.id);

  return getConversationTurnById(turnId);
}

export function saveExtractedFacts(sessionId, roundId, facts = [], sourceTurnId = null) {
  const database = getDatabase();
  const timestamp = nowIso();
  const insert = database.prepare(`
    INSERT INTO extracted_facts (
      id, session_id, round_id, subject_user_id, fact_key, fact_value, confidence, source_turn_id, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  database.exec("BEGIN");

  try {
    for (const fact of facts) {
      insert.run(
        crypto.randomUUID(),
        sessionId,
        roundId,
        fact.subjectUserId || null,
        fact.key,
        String(fact.value ?? ""),
        Number(fact.confidence ?? 0),
        sourceTurnId,
        fact.status || "confirmed",
        timestamp
      );
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function listExtractedFacts(sessionId) {
  const database = getDatabase();
  const rows = database
    .prepare(`
      SELECT *
      FROM extracted_facts
      WHERE session_id = ?
      ORDER BY created_at ASC
    `)
    .all(sessionId);

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    roundId: row.round_id,
    subjectUserId: row.subject_user_id,
    key: row.fact_key,
    value: row.fact_value,
    confidence: row.confidence,
    sourceTurnId: row.source_turn_id,
    status: row.status,
    createdAt: row.created_at
  }));
}

export function createStageReport(sessionId, roundId, payload) {
  const database = getDatabase();
  const id = crypto.randomUUID();
  const timestamp = nowIso();

  database
    .prepare(`
      INSERT INTO stage_reports (id, session_id, round_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(id, sessionId, roundId, JSON.stringify(payload), timestamp);

  updatePrechatSession(sessionId, { latestStageReportId: id });

  return {
    id,
    sessionId,
    roundId,
    payload,
    createdAt: timestamp
  };
}

export function updateStageReport(reportId, payload) {
  const database = getDatabase();
  const current = database.prepare(`SELECT * FROM stage_reports WHERE id = ?`).get(reportId);

  if (!current) {
    return null;
  }

  database
    .prepare(`
      UPDATE stage_reports
      SET payload_json = ?
      WHERE id = ?
    `)
    .run(JSON.stringify(payload ?? {}), reportId);

  return {
    id: current.id,
    sessionId: current.session_id,
    roundId: current.round_id,
    payload,
    createdAt: current.created_at
  };
}

export function listStageReports(sessionId) {
  const database = getDatabase();
  const rows = database
    .prepare(`
      SELECT *
      FROM stage_reports
      WHERE session_id = ?
      ORDER BY created_at DESC
    `)
    .all(sessionId);

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    roundId: row.round_id,
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at
  }));
}

export function createSensitiveQuestionRequest({
  sessionId,
  roundId,
  requestingUserId,
  targetUserId,
  questionText,
  topicCategory,
  metadata = {}
}) {
  const database = getDatabase();
  const id = crypto.randomUUID();
  const timestamp = nowIso();

  database
    .prepare(`
      INSERT INTO sensitive_question_requests (
        id, session_id, round_id, requesting_user_id, target_user_id, question_text, topic_category, status, created_at, resolved_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `)
    .run(
      id,
      sessionId,
      roundId,
      requestingUserId,
      targetUserId,
      questionText,
      topicCategory,
      "pending",
      timestamp,
      JSON.stringify(metadata)
    );

  return {
    id,
    sessionId,
    roundId,
    requestingUserId,
    targetUserId,
    questionText,
    topicCategory,
    status: "pending",
    createdAt: timestamp,
    resolvedAt: null,
    metadata
  };
}

export function getSensitiveQuestionRequestForUser(requestId, userId) {
  const database = getDatabase();
  const row = database
    .prepare(`
      SELECT *
      FROM sensitive_question_requests
      WHERE id = ? AND target_user_id = ?
    `)
    .get(requestId, userId);

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    roundId: row.round_id,
    requestingUserId: row.requesting_user_id,
    targetUserId: row.target_user_id,
    questionText: row.question_text,
    topicCategory: row.topic_category,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    metadata: parseJson(row.metadata_json, {})
  };
}

export function updateSensitiveQuestionRequest(requestId, patch) {
  const database = getDatabase();
  const timestamp = patch.resolvedAt ?? nowIso();

  database
    .prepare(`
      UPDATE sensitive_question_requests
      SET status = ?, resolved_at = ?, metadata_json = ?
      WHERE id = ?
    `)
    .run(
      patch.status,
      patch.status === "pending" ? null : timestamp,
      JSON.stringify(patch.metadata || {}),
      requestId
    );
}

export function listSensitiveQuestionRequests(sessionId) {
  const database = getDatabase();
  const rows = database
    .prepare(`
      SELECT *
      FROM sensitive_question_requests
      WHERE session_id = ?
      ORDER BY created_at DESC
    `)
    .all(sessionId);

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    roundId: row.round_id,
    requestingUserId: row.requesting_user_id,
    targetUserId: row.target_user_id,
    questionText: row.question_text,
    topicCategory: row.topic_category,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    metadata: parseJson(row.metadata_json, {})
  }));
}

export function createHumanInputRequest({
  sessionId,
  roundId,
  targetUserId,
  fieldKey,
  questionText,
  metadata = {}
}) {
  const database = getDatabase();
  const id = crypto.randomUUID();
  const timestamp = nowIso();

  database
    .prepare(`
      INSERT INTO human_input_requests (
        id, session_id, round_id, target_user_id, field_key, question_text, status, response_text, created_at, resolved_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)
    `)
    .run(
      id,
      sessionId,
      roundId,
      targetUserId,
      fieldKey,
      questionText,
      "pending",
      timestamp,
      JSON.stringify(metadata)
    );

  return {
    id,
    sessionId,
    roundId,
    targetUserId,
    fieldKey,
    questionText,
    status: "pending",
    responseText: null,
    createdAt: timestamp,
    resolvedAt: null,
    metadata
  };
}

export function getHumanInputRequestForUser(requestId, userId) {
  const database = getDatabase();
  const row = database
    .prepare(`
      SELECT *
      FROM human_input_requests
      WHERE id = ? AND target_user_id = ?
    `)
    .get(requestId, userId);

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    roundId: row.round_id,
    targetUserId: row.target_user_id,
    fieldKey: row.field_key,
    questionText: row.question_text,
    status: row.status,
    responseText: row.response_text,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    metadata: parseJson(row.metadata_json, {})
  };
}

export function resolveHumanInputRequest(requestId, responseText, metadata = {}) {
  const database = getDatabase();
  const timestamp = nowIso();

  database
    .prepare(`
      UPDATE human_input_requests
      SET status = ?, response_text = ?, resolved_at = ?, metadata_json = ?
      WHERE id = ?
    `)
    .run("resolved", responseText, timestamp, JSON.stringify(metadata), requestId);
}

export function listHumanInputRequests(sessionId) {
  const database = getDatabase();
  const rows = database
    .prepare(`
      SELECT *
      FROM human_input_requests
      WHERE session_id = ?
      ORDER BY created_at DESC
    `)
    .all(sessionId);

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    roundId: row.round_id,
    targetUserId: row.target_user_id,
    fieldKey: row.field_key,
    questionText: row.question_text,
    status: row.status,
    responseText: row.response_text,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    metadata: parseJson(row.metadata_json, {})
  }));
}

export function getInboxForUser(userId) {
  const database = getDatabase();
  const invitations = dedupeRowsBy(
    database
      .prepare(`
        SELECT *
        FROM prechat_sessions
        WHERE counterparty_user_id = ? AND status = 'awaiting_counterparty_acceptance'
        ORDER BY updated_at DESC, created_at DESC
      `)
      .all(userId),
    (row) => row.match_id
  )
    .map((row) => ({
      id: row.id,
      type: "invitation",
      createdAt: row.created_at,
      payload: {
        sessionId: row.id,
        matchId: row.match_id,
        initiatorUserId: row.initiator_user_id,
        counterpartyUserId: row.counterparty_user_id,
        status: row.status
      }
    }))
    .filter((item) => {
      const initiator = getUserById(item.payload.initiatorUserId);
      return initiator && !isBrokenPlaceholderText(initiator.displayName);
    });

  const sensitive = database
    .prepare(`
      SELECT *
      FROM sensitive_question_requests
      WHERE target_user_id = ? AND status = 'pending'
      ORDER BY created_at DESC
    `)
    .all(userId)
    .map((row) => ({
      id: row.id,
      type: "sensitive_request",
      createdAt: row.created_at,
      payload: {
        requestId: row.id,
        sessionId: row.session_id,
        questionText: row.question_text,
        topicCategory: row.topic_category,
        requestingUserId: row.requesting_user_id,
        approvalKind: parseJson(row.metadata_json, {})?.approvalKind || "topic",
        summaryText: parseJson(row.metadata_json, {})?.summaryText || ""
      }
    }))
    .filter((item) => {
      const requester = getUserById(item.payload.requestingUserId);
      return requester && !isBrokenPlaceholderText(requester.displayName);
    });

  const humanInput = database
    .prepare(`
      SELECT *
      FROM human_input_requests
      WHERE target_user_id = ? AND status = 'pending'
      ORDER BY created_at DESC
    `)
    .all(userId)
    .map((row) => ({
      id: row.id,
      type: "human_input_request",
      createdAt: row.created_at,
      payload: {
        requestId: row.id,
        sessionId: row.session_id,
        fieldKey: row.field_key,
        questionText: row.question_text
      }
    }));

  const pendingSessionIds = new Set([
    ...humanInput.map((item) => item.payload.sessionId),
    ...sensitive.map((item) => item.payload.sessionId)
  ]);

  const sessionReview = dedupeRowsBy(
    database
      .prepare(`
        SELECT *
        FROM prechat_sessions
        WHERE (initiator_user_id = ? OR counterparty_user_id = ?)
          AND status = 'paused_review'
        ORDER BY updated_at DESC, created_at DESC
      `)
      .all(userId, userId)
      .map((row) => ({
        id: row.id,
        matchId: row.match_id,
        initiatorUserId: row.initiator_user_id,
        counterpartyUserId: row.counterparty_user_id,
        status: row.status,
        currentRound: row.current_round,
        latestStageReportId: row.latest_stage_report_id,
        control: parseJson(row.control_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
      .map((session) => {
        const latestRound = listPrechatRounds(session.id).slice().pop();

        if (!shouldShowObjectivesCompletedReviewInbox(session, latestRound, userId)) {
          return null;
        }

        const latestReport = listStageReports(session.id)[0];
        const reviewEntry = getObjectivesCompletedReviewInboxEntry(session);

        return {
          id: `${session.id}:objectives_completed`,
          type: "session_review",
          createdAt:
            reviewEntry?.emittedAt ||
            latestRound?.updatedAt ||
            latestReport?.createdAt ||
            session.updatedAt ||
            session.createdAt,
          payload: {
            sessionId: session.id,
            reviewKind: "objectives_completed",
            stopReason: "objectives_completed",
            roundId: latestRound?.id || null,
            roundNumber: latestRound?.roundNumber || 0,
            summary: String(latestReport?.payload?.summary || "").trim()
          }
        };
      })
      .filter(Boolean),
    (item) => item.id
  );

  const sessionPause = dedupeRowsBy(
    database
      .prepare(`
        SELECT *
        FROM prechat_sessions
        WHERE (initiator_user_id = ? OR counterparty_user_id = ?)
          AND status IN ('active', 'paused_review')
        ORDER BY updated_at DESC, created_at DESC
      `)
      .all(userId, userId)
      .map((row) => ({
        id: row.id,
        matchId: row.match_id,
        initiatorUserId: row.initiator_user_id,
        counterpartyUserId: row.counterparty_user_id,
        status: row.status,
        currentRound: row.current_round,
        latestStageReportId: row.latest_stage_report_id,
        control: parseJson(row.control_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
      .map((session) => {
        const latestRound = listPrechatRounds(session.id).slice().pop();
        if (!latestRound || pendingSessionIds.has(session.id)) {
          return null;
        }

        if (latestRound.stopReason === "objectives_completed") {
          return null;
        }

        if (!shouldShowPauseNoticeReviewInbox(session, latestRound, userId)) {
          return null;
        }

        const pauseEntry = getPauseNoticeReviewInboxEntry(session);
        const pauseKind = pauseEntry?.pauseKind || getPauseKindFromSessionAndRound(session, latestRound);
        const stopReason = pauseEntry?.stopReason || latestRound.stopReason || null;

        return {
          id: `${session.id}:pause_notice`,
          type: "session_pause",
          createdAt: pauseEntry?.emittedAt || latestRound.updatedAt || session.updatedAt || session.createdAt,
          payload: {
            sessionId: session.id,
            pauseKind,
            stopReason,
            roundId: latestRound.id || null,
            roundNumber: latestRound.roundNumber || 0,
            summary: getPauseSummary(stopReason, pauseKind)
          }
        };
      })
      .filter(Boolean),
    (item) => item.id
  );

  return [...invitations, ...sensitive, ...humanInput, ...sessionReview, ...sessionPause].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt)
  );
}

export function getCandidatePool() {
  const database = getDatabase();
  const rows = database
    .prepare(`
      SELECT payload_json
      FROM candidate_profiles
      WHERE active = 1
      ORDER BY display_name ASC
    `)
    .all();

  return rows.map((row) => parseJson(row.payload_json, {}));
}

export function getCandidatePoolCount() {
  const database = getDatabase();
  const row = database
    .prepare(`SELECT COUNT(*) AS count FROM candidate_profiles WHERE active = 1`)
    .get();

  return row.count;
}

export function loadReports(userId, { schemaVersion } = {}) {
  const database = getDatabase();
  let sql = `
    SELECT id, user_id, twin_version_id, schema_version, payload_json, created_at
    FROM match_reports
    WHERE user_id = ?
  `;
  const params = [userId];

  if (typeof schemaVersion === "number") {
    sql += " AND schema_version = ?";
    params.push(schemaVersion);
  }

  sql += " ORDER BY created_at DESC";

  return database.prepare(sql).all(...params).map((row) => {
    const payload = parseJson(row.payload_json, {});
    return {
      ...payload,
      userId: row.user_id,
      twinVersionId: row.twin_version_id || payload.twinVersionId || null
    };
  });
}

export function getReport(userId, reportId, { schemaVersion } = {}) {
  const database = getDatabase();
  let sql = `
    SELECT id, user_id, twin_version_id, schema_version, payload_json, created_at
    FROM match_reports
    WHERE id = ? AND user_id = ?
  `;
  const params = [reportId, userId];

  if (typeof schemaVersion === "number") {
    sql += " AND schema_version = ?";
    params.push(schemaVersion);
  }

  const row = database.prepare(sql).get(...params);

  if (!row) {
    return null;
  }

  const payload = parseJson(row.payload_json, {});
  return {
    ...payload,
    userId: row.user_id,
    twinVersionId: row.twin_version_id || payload.twinVersionId || null
  };
}

export function saveReport(userId, report, twinVersionId = null, twinVersionNumber = null) {
  const database = getDatabase();
  const payload = {
    ...report,
    userId,
    twinVersionId,
    twinVersionNumber
  };

  database
    .prepare(`
      INSERT INTO match_reports (
        id, user_id, twin_version_id, schema_version, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      report.id,
      userId,
      twinVersionId,
      report.schemaVersion,
      JSON.stringify(payload),
      report.createdAt
    );

  return payload;
}

export function getSessionDetailForUser(sessionId, userId) {
  const session = getPrechatSessionForUser(sessionId, userId);

  if (!session) {
    return null;
  }

  return {
    session,
    rounds: listPrechatRounds(sessionId),
    turns: listConversationTurns(sessionId),
    facts: listExtractedFacts(sessionId),
    stageReports: listStageReports(sessionId),
    sensitiveRequests: listSensitiveQuestionRequests(sessionId),
    humanInputRequests: listHumanInputRequests(sessionId)
  };
}

export function getSessionParticipantProfiles(session) {
  return {
    initiator: getCounterpartTwin(session.initiatorUserId),
    counterparty: getCounterpartTwin(session.counterpartyUserId)
  };
}

export function getAllUsers() {
  const database = getDatabase();
  const rows = database
    .prepare(`SELECT id, email, display_name, created_at, updated_at FROM users ORDER BY created_at ASC`)
    .all();

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export function getLatestOpenSessionForMatch(matchId) {
  const database = getDatabase();
  const row = database
    .prepare(`
      SELECT *
      FROM prechat_sessions
      WHERE match_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `)
    .get(matchId);

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    matchId: row.match_id,
    initiatorUserId: row.initiator_user_id,
    counterpartyUserId: row.counterparty_user_id,
    status: row.status,
    currentRound: row.current_round,
    latestStageReportId: row.latest_stage_report_id,
    control: parseJson(row.control_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function rejectSiblingPendingInvitations(matchId, keepSessionId) {
  const database = getDatabase();
  const timestamp = nowIso();

  database
    .prepare(`
      UPDATE prechat_sessions
      SET status = 'rejected', updated_at = ?
      WHERE match_id = ?
        AND id <> ?
        AND status = 'awaiting_counterparty_acceptance'
    `)
    .run(timestamp, matchId, keepSessionId);
}

export function getLatestTurnNumber(roundId) {
  const database = getDatabase();
  const row = database
    .prepare(`
      SELECT COALESCE(MAX(turn_number), 0) AS max_turn
      FROM conversation_turns
      WHERE round_id = ?
    `)
    .get(roundId);

  return Number(row?.max_turn || 0);
}

export function countUsers() {
  const database = getDatabase();
  return database.prepare(`SELECT COUNT(*) AS count FROM users`).get().count;
}

export function getRawDatabaseForTests() {
  return getDatabase();
}
