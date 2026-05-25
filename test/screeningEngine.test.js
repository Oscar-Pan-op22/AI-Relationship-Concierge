import test from "node:test";
import assert from "node:assert/strict";
import { buildScreeningReport } from "../src/lib/screeningEngine.js";

test("builds a promising report when core signals align", () => {
  const report = buildScreeningReport({
    twinProfile: {
      relationshipGoal: "认真长期关系，希望以结婚为目标",
      cities: "Shanghai, Hangzhou",
      mustHaves: "直接沟通",
      communicationStyle: "直接、稳定",
      marriageTimeline: "1-2年内",
      childrenPreference: "以后想要孩子",
      familyBoundary: "独立小家庭",
      financialView: "务实稳定",
      authorizedSensitiveTopics: ["finance_and_debt", "family_boundaries", "fertility_and_children"]
    },
    candidateProfile: {
      displayName: "林予安",
      city: "Shanghai",
      occupation: "设计师",
      relationshipGoal: "想找认真关系",
      profileText:
        "希望稳定长期发展，最后走向结婚。认为两个人应该有自己的独立小家庭。",
      chatSummary:
        "回复稳定直接，以后想要孩子但不着急。消费观偏务实。"
    }
  });

  assert.equal(report.phase, "phase_1_due_diligence");
  assert.equal(report.fitBand === "Strong" || report.fitBand === "Promising", true);
  assert.equal(typeof report.fitBandLabel, "string");
  assert.equal(report.riskSignals.some((risk) => risk.severity === "high"), false);
  assert.equal(report.questionPack.length >= 0, true);
});

test("detects high-risk money solicitation signals", () => {
  const report = buildScreeningReport({
    twinProfile: {
      relationshipGoal: "认真关系",
      hardStops: "借钱, 赌博"
    },
    candidateProfile: {
      displayName: "高风险对象",
      profileText: "最近在做投资理财，稳赚，之后如果关系稳定可以一起投入。",
      chatSummary: "如果你真的相信我，先帮我垫一点也可以。"
    }
  });

  assert.equal(report.riskSignals.some((risk) => risk.code === "financial_solicitation"), true);
  assert.equal(report.fitBand, "Hold");
});

test("marks unauthorized sensitive question categories", () => {
  const report = buildScreeningReport({
    twinProfile: {
      relationshipGoal: "认真关系",
      marriageTimeline: "一年内",
      childrenPreference: "想要孩子",
      authorizedSensitiveTopics: []
    },
    candidateProfile: {
      displayName: "待确认对象",
      profileText: "认真交往，别的以后再说。"
    }
  });

  const unauthorizedSensitiveDraft = report.questionPack.find(
    (item) => item.sensitivity === "sensitive" && item.allowedByCurrentConsent === false
  );

  assert.ok(unauthorizedSensitiveDraft);
});
