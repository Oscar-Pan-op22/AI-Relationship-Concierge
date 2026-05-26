import assert from "node:assert/strict";
import test from "node:test";
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

test("旧的最小 payload 仍然可以生成 Phase 1 报告", () => {
  const report = buildMatchReport({
    twinProfile: {
      relationshipGoal: "认真长期关系",
      cities: "上海"
    }
  });

  assert.equal(report.schemaVersion, REPORT_SCHEMA_VERSION);
  assert.equal(report.phase, "phase_1_matching_shortlist");
  assert.equal(report.shortlist.length > 0, true);
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

  assert.equal(report.shortlist.every((item) => item.matchScore <= 100), true);
});

test("Twin 画像摘要在核心字段明确时不应全部回退成未明确", () => {
  const report = buildMatchReport({
    twinProfile: buildBaseProfile()
  });

  assert.notEqual(report.twinSummary.profileLabel, "未明确");
  assert.equal(report.twinSummary.anchors.some((item) => item.includes("未明确")), false);
});
