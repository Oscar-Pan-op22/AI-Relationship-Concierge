import assert from "node:assert/strict";
import test from "node:test";
import { REALITY_FIELD_DEFS } from "../src/lib/constants.js";
import { buildMatchReport, REPORT_SCHEMA_VERSION } from "../src/lib/matchingEngine.js";

function buildBaseProfile(overrides = {}) {
  return {
    displayName: "雨涵",
    relationshipGoal: "认真长期关系，希望以结婚为目标",
    cities: "上海、杭州",
    mustHaves: "情绪稳定、愿意认真经营关系、能直接沟通",
    hardStops: "早期借钱、赌博",
    communicationStyle: "直接、稳定回复",
    marriageTimeline: "如果匹配，希望 1 到 2 年内推进",
    childrenPreference: "希望未来要孩子",
    familyBoundary: "尊重父母，但婚后更偏独立小家庭",
    financialView: "务实稳定，不接受隐性负债",
    selfSummary: "我更看重长期稳定和现实可推进性。",
    ...overrides
  };
}

test("旧的最小 payload 仍然可以生成报告", () => {
  const report = buildMatchReport({
    twinProfile: {
      relationshipGoal: "认真长期关系",
      cities: "上海"
    }
  });

  assert.equal(report.phase, "phase_1_matching_shortlist");
  assert.equal(report.phaseLabel, "用户单侧建档与数据库初筛");
  assert.equal(report.schemaVersion, REPORT_SCHEMA_VERSION);
  assert.equal(report.shortlist.length > 0, true);
});

test("现实条件全部留空时不会进入 profileGaps，但会进入 suggestedCompletions", () => {
  const report = buildMatchReport({
    twinProfile: buildBaseProfile()
  });

  assert.equal(
    report.profileGaps.some((gap) => gap.dimension.includes("收入") || gap.dimension.includes("住房")),
    false
  );
  assert.equal(report.suggestedCompletions.length, REALITY_FIELD_DEFS.length);
  assert.equal(report.realitySummary.selfReality.length, 0);
});

test("prefer 命中时会提高候选人的匹配分", () => {
  const baseReport = buildMatchReport({
    twinProfile: buildBaseProfile()
  });
  const preferReport = buildMatchReport({
    twinProfile: buildBaseProfile({
      partnerRealityPreferences: {
        housingStatus: {
          mode: "prefer",
          values: ["own_with_loan", "own_without_loan"]
        }
      }
    })
  });

  const baseCandidate = baseReport.shortlist.find((candidate) => candidate.displayName === "林予安");
  const preferCandidate = preferReport.shortlist.find(
    (candidate) => candidate.displayName === "林予安"
  );

  assert.ok(baseCandidate);
  assert.ok(preferCandidate);
  assert.equal(preferCandidate.matchScore > baseCandidate.matchScore, true);
});

test("require 未命中时不会高于 needs-clarification", () => {
  const report = buildMatchReport({
    twinProfile: buildBaseProfile({
      partnerRealityPreferences: {
        incomeBand: {
          mode: "require",
          values: ["50k_plus"]
        }
      }
    })
  });

  const candidate = report.shortlist.find((item) => item.displayName === "林予安");

  assert.ok(candidate);
  assert.equal(["strong", "promising"].includes(candidate.matchBandKey), false);
});

test("reject 命中时不会出现在 shortlist", () => {
  const baseReport = buildMatchReport({
    twinProfile: buildBaseProfile()
  });
  const rejectReport = buildMatchReport({
    twinProfile: buildBaseProfile({
      partnerRealityPreferences: {
        housingStatus: {
          mode: "reject",
          values: ["living_with_parents"]
        }
      }
    })
  });

  assert.equal(
    baseReport.shortlist.some((candidate) => candidate.displayName === "彭皓然"),
    true
  );
  assert.equal(
    rejectReport.shortlist.some((candidate) => candidate.displayName === "彭皓然"),
    false
  );
});

test("报告会输出现实条件摘要和结构化偏好发现", () => {
  const report = buildMatchReport({
    twinProfile: buildBaseProfile({
      selfReality: {
        incomeBand: "30k_to_50k",
        housingStatus: "renting_independently"
      },
      partnerRealityPreferences: {
        postMaritalLivingPreference: {
          mode: "require",
          values: ["independent_home", "near_parents"]
        }
      }
    })
  });

  assert.equal(report.realitySummary.selfReality.length >= 2, true);
  assert.equal(report.realitySummary.partnerPreferences.length, 1);
  assert.equal(Array.isArray(report.realityPreferenceFindings), true);
  assert.equal(JSON.stringify(report).includes("?{"), false);
});

test("结构化现实条件加分后匹配分不会超过 100", () => {
  const report = buildMatchReport({
    twinProfile: buildBaseProfile({
      partnerRealityPreferences: {
        incomeBand: { mode: "prefer", values: ["30k_to_50k", "50k_plus"] },
        incomeStability: { mode: "prefer", values: ["stable"] },
        debtLevel: { mode: "prefer", values: ["mortgage_or_car_loan_only", "none_or_low"] },
        housingStatus: { mode: "prefer", values: ["own_with_loan", "own_without_loan"] },
        vehicleStatus: { mode: "prefer", values: ["own"] },
        siblingStructure: { mode: "prefer", values: ["only_child"] },
        parentCareBurden: { mode: "require", values: ["medium"] },
        postMaritalLivingPreference: {
          mode: "require",
          values: ["independent_home"]
        }
      }
    })
  });

  const candidate = report.shortlist.find((item) => item.displayName === "林予安");

  assert.ok(candidate);
  assert.equal(candidate.matchScore <= 100, true);
});
