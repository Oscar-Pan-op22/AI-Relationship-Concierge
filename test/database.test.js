import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { hashPassword } from "../src/lib/auth.js";
import { MOCK_CANDIDATE_POOL } from "../src/lib/mockCandidatePool.js";
import {
  createUser,
  getCandidatePool,
  getCandidatePoolCount,
  getCurrentTwin,
  getReport,
  loadReports,
  resetDatabaseForTests,
  saveCurrentTwin,
  saveReport
} from "../src/lib/database.js";
import { REPORT_SCHEMA_VERSION } from "../src/lib/matchingEngine.js";

const tempDbPath = path.join(process.cwd(), "data", "test-phase2-database.sqlite");

test.beforeEach(() => {
  resetDatabaseForTests(tempDbPath);
  if (fs.existsSync(tempDbPath)) {
    fs.unlinkSync(tempDbPath);
  }
});

test.after(() => {
  resetDatabaseForTests("");
  if (fs.existsSync(tempDbPath)) {
    fs.unlinkSync(tempDbPath);
  }
});

test("候选池会自动 seed 到 SQLite", () => {
  assert.equal(getCandidatePoolCount(), MOCK_CANDIDATE_POOL.length);
  assert.equal(getCandidatePool().length, MOCK_CANDIDATE_POOL.length);
});

test("当前 Twin 按 user_id 隔离，并在同一用户下递增版本", () => {
  const userA = createUser({
    email: "a@example.com",
    displayName: "雨涵",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "b@example.com",
    displayName: "予安",
    passwordHash: hashPassword("secret123")
  });

  const firstA = saveCurrentTwin(userA.id, {
    displayName: "雨涵",
    relationshipGoal: "认真长期关系",
    cities: "上海"
  });
  const firstB = saveCurrentTwin(userB.id, {
    displayName: "予安",
    relationshipGoal: "认真长期关系",
    cities: "杭州"
  });
  const secondA = saveCurrentTwin(userA.id, {
    displayName: "雨涵",
    relationshipGoal: "认真长期关系，以结婚为目标",
    cities: "上海、杭州"
  });

  assert.equal(firstA.twinVersionNumber, 1);
  assert.equal(firstB.twinVersionNumber, 1);
  assert.equal(secondA.twinVersionNumber, 2);
  assert.equal(getCurrentTwin(userB.id).twinVersionNumber, 1);
  assert.equal(getCurrentTwin(userA.id).twinProfile.cities, "上海、杭州");
});

test("报告按 user_id 隔离保存和读取", () => {
  const userA = createUser({
    email: "a@example.com",
    displayName: "雨涵",
    passwordHash: hashPassword("secret123")
  });
  const userB = createUser({
    email: "b@example.com",
    displayName: "予安",
    passwordHash: hashPassword("secret123")
  });
  const twinA = saveCurrentTwin(userA.id, {
    displayName: "雨涵",
    relationshipGoal: "认真长期关系",
    cities: "上海"
  });
  const twinB = saveCurrentTwin(userB.id, {
    displayName: "予安",
    relationshipGoal: "认真长期关系",
    cities: "杭州"
  });

  saveReport(
    userA.id,
    {
      id: "report-a",
      schemaVersion: REPORT_SCHEMA_VERSION,
      createdAt: "2026-05-26T00:00:00.000Z",
      twinSummary: { displayName: "雨涵", profileLabel: "认真长期导向" },
      overview: { shortlistCount: 1, headline: "已生成 1 位 shortlist 候选人。" },
      shortlist: [],
      nextSteps: []
    },
    twinA.twinVersionId,
    twinA.twinVersionNumber
  );
  saveReport(
    userB.id,
    {
      id: "report-b",
      schemaVersion: REPORT_SCHEMA_VERSION,
      createdAt: "2026-05-26T00:01:00.000Z",
      twinSummary: { displayName: "予安", profileLabel: "认真长期导向" },
      overview: { shortlistCount: 1, headline: "已生成 1 位 shortlist 候选人。" },
      shortlist: [],
      nextSteps: []
    },
    twinB.twinVersionId,
    twinB.twinVersionNumber
  );

  assert.equal(loadReports(userA.id, { schemaVersion: REPORT_SCHEMA_VERSION }).length, 1);
  assert.equal(loadReports(userB.id, { schemaVersion: REPORT_SCHEMA_VERSION }).length, 1);
  assert.equal(getReport(userA.id, "report-a", { schemaVersion: REPORT_SCHEMA_VERSION }).twinVersionId, twinA.twinVersionId);
  assert.equal(getReport(userB.id, "report-b", { schemaVersion: REPORT_SCHEMA_VERSION }).twinVersionId, twinB.twinVersionId);
  assert.equal(getReport(userA.id, "report-b", { schemaVersion: REPORT_SCHEMA_VERSION }), null);
});
