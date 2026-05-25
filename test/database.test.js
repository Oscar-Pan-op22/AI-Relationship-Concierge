import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { MOCK_CANDIDATE_POOL } from "../src/lib/mockCandidatePool.js";
import {
  getCandidatePool,
  getCandidatePoolCount,
  getProfile,
  listProfiles,
  loadReports,
  resetDatabaseForTests,
  saveProfile,
  saveReport
} from "../src/lib/database.js";
import { REPORT_SCHEMA_VERSION } from "../src/lib/matchingEngine.js";

const tempDbPath = path.join(process.cwd(), "data", "test-phase1.sqlite");

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

test("可以保存并读取 Twin 档案", () => {
  const profile = saveProfile({
    twinProfile: {
      displayName: "雨涵",
      relationshipGoal: "认真长期关系",
      cities: "上海、杭州"
    }
  });

  const loaded = getProfile(profile.id);

  assert.ok(loaded);
  assert.equal(loaded.twinProfile.displayName, "雨涵");
  assert.equal(listProfiles().length, 1);
});

test("报告会和 profileId 一起持久化", () => {
  const profile = saveProfile({
    twinProfile: {
      displayName: "雨涵",
      relationshipGoal: "认真长期关系",
      cities: "上海"
    }
  });

  saveReport(
    {
      id: "report-1",
      schemaVersion: REPORT_SCHEMA_VERSION,
      createdAt: "2026-05-25T00:00:00.000Z",
      twinSummary: { displayName: "雨涵" },
      overview: { shortlistCount: 1 },
      shortlist: []
    },
    profile.id
  );

  const reports = loadReports({ schemaVersion: REPORT_SCHEMA_VERSION });

  assert.equal(reports.length, 1);
  assert.equal(reports[0].profileId, profile.id);
});
