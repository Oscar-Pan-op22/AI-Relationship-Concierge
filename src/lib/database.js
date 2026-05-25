import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MOCK_CANDIDATE_POOL } from "./mockCandidatePool.js";

let activeDatabase = null;
let activeDatabasePath = "";
let overriddenDatabasePath = "";

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

function initializeSchema(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
      profile_id TEXT,
      schema_version INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_profiles_updated_at ON profiles(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reports_created_at ON match_reports(created_at DESC);
  `);
}

function seedCandidatePool(database) {
  const upsert = database.prepare(`
    INSERT INTO candidate_profiles (
      id,
      display_name,
      city,
      payload_json,
      active,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      city = excluded.city,
      payload_json = excluded.payload_json,
      active = 1,
      updated_at = excluded.updated_at
  `);
  const timestamp = new Date().toISOString();

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

  if (!activeDatabase || activeDatabasePath !== databasePath) {
    if (activeDatabase) {
      activeDatabase.close();
    }

    ensureParentDir(databasePath);
    activeDatabase = new DatabaseSync(databasePath);
    activeDatabasePath = databasePath;
    initializeSchema(activeDatabase);
    seedCandidatePool(activeDatabase);
  }

  return activeDatabase;
}

function parseJsonRow(row, key = "payload_json") {
  return JSON.parse(row[key]);
}

export function getDatabasePath() {
  return resolveDatabasePath();
}

export function resetDatabaseForTests(databasePath = "") {
  if (activeDatabase) {
    activeDatabase.close();
    activeDatabase = null;
    activeDatabasePath = "";
  }

  overriddenDatabasePath = databasePath;
}

export function getCandidatePool() {
  const database = getDatabase();
  const rows = database
    .prepare(
      `
        SELECT payload_json
        FROM candidate_profiles
        WHERE active = 1
        ORDER BY display_name ASC
      `
    )
    .all();

  return rows.map((row) => parseJsonRow(row));
}

export function getCandidatePoolCount() {
  const database = getDatabase();
  const row = database
    .prepare(`SELECT COUNT(*) AS count FROM candidate_profiles WHERE active = 1`)
    .get();

  return row.count;
}

export function listProfiles() {
  const database = getDatabase();
  const rows = database
    .prepare(
      `
        SELECT id, display_name, payload_json, created_at, updated_at
        FROM profiles
        ORDER BY updated_at DESC
      `
    )
    .all();

  return rows.map((row) => {
    const twinProfile = parseJsonRow(row);

    return {
      id: row.id,
      displayName: twinProfile.displayName || row.display_name || "未命名用户",
      relationshipGoal: twinProfile.relationshipGoal || "",
      cities: twinProfile.cities || "",
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  });
}

export function getProfile(profileId) {
  const database = getDatabase();
  const row = database
    .prepare(
      `
        SELECT id, display_name, payload_json, created_at, updated_at
        FROM profiles
        WHERE id = ?
      `
    )
    .get(profileId);

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    displayName: row.display_name,
    twinProfile: parseJsonRow(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function saveProfile({ id = "", twinProfile }) {
  const database = getDatabase();
  const now = new Date().toISOString();
  const profileId = id || crypto.randomUUID();
  const displayName = String(twinProfile?.displayName || "").trim() || "未命名用户";
  const payloadJson = JSON.stringify(twinProfile || {});
  const existing = getProfile(profileId);

  database
    .prepare(
      `
        INSERT INTO profiles (id, display_name, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `
    )
    .run(profileId, displayName, payloadJson, existing?.createdAt || now, now);

  return getProfile(profileId);
}

export function loadReports({ schemaVersion, profileId } = {}) {
  const database = getDatabase();
  let sql = `
    SELECT id, profile_id, schema_version, payload_json, created_at
    FROM match_reports
  `;
  const params = [];
  const where = [];

  if (typeof schemaVersion === "number") {
    where.push("schema_version = ?");
    params.push(schemaVersion);
  }

  if (profileId) {
    where.push("profile_id = ?");
    params.push(profileId);
  }

  if (where.length) {
    sql += ` WHERE ${where.join(" AND ")}`;
  }

  sql += " ORDER BY created_at DESC";

  const rows = database.prepare(sql).all(...params);
  return rows.map((row) => {
    const report = parseJsonRow(row);
    return {
      ...report,
      profileId: row.profile_id || report.profileId || null
    };
  });
}

export function saveReport(report, profileId = null) {
  const database = getDatabase();
  const payload = {
    ...report,
    profileId: profileId || null
  };

  database
    .prepare(
      `
        INSERT INTO match_reports (id, profile_id, schema_version, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `
    )
    .run(
      report.id,
      profileId,
      report.schemaVersion,
      JSON.stringify(payload),
      report.createdAt
    );

  return payload;
}
