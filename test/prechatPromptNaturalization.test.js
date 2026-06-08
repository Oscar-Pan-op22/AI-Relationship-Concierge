import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { __testOnlyBuildTurnPrompt, TURN_PROMPT_VERSION } from "../src/lib/llmAdapter.js";
import {
  __testOnlyApplyChineseQualityGuard,
  __testOnlyBuildFactCard,
  __testOnlyBuildTopicAnswer
} from "../src/lib/prechatService.js";

const telemetryPath = path.join(process.cwd(), "data", "test-quality-events.jsonl");

function buildProfile(overrides = {}) {
  return {
    userId: overrides.userId || "user-1",
    displayName: overrides.displayName || "测试用户",
    twinProfile: {
      displayName: overrides.displayName || "测试用户",
      relationshipGoal: overrides.relationshipGoal || "",
      cities: overrides.cities || "",
      marriageTimeline: overrides.marriageTimeline || "",
      childrenPreference: overrides.childrenPreference || "",
      familyBoundary: overrides.familyBoundary || "",
      financialView: overrides.financialView || ""
    }
  };
}

test.afterEach(() => {
  delete process.env.LLM_TELEMETRY_PATH;

  if (fs.existsSync(telemetryPath)) {
    fs.unlinkSync(telemetryPath);
  }
});

test("turn prompt 保留中文优先、answer-first、prompt version 和片段拼接禁令", () => {
  const messages = __testOnlyBuildTurnPrompt({
    speaker_fact_cards: [],
    listener_fact_cards: [],
    conversation_state: {
      conversation_started: true,
      latest_turn_from_listener: true,
      latest_turn_is_question: true
    },
    recent_turns: []
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, new RegExp(TURN_PROMPT_VERSION, "u"));
  assert.match(messages[0].content, /先回答必须先回答的那一题，再最多推进一个新的追问/u);
  assert.match(messages[0].content, /禁止把字段值直接套进固定模板/u);
  assert.match(messages[0].content, /禁止输出『在X生活』这类句式/u);
  assert.match(messages[0].content, /我可以接受/u);
  assert.match(messages[0].content, /住得近/u);
  assert.match(messages[0].content, /speaker_fact_cards/u);
});

test("turn prompt 包含新的好坏例子并强调 naturalAnswerHint", () => {
  const messages = __testOnlyBuildTurnPrompt({
    speaker_fact_cards: [],
    listener_fact_cards: [],
    conversation_state: {
      conversation_started: false,
      latest_turn_from_listener: false,
      latest_turn_is_question: false
    },
    recent_turns: []
  });

  assert.match(messages[0].content, /我长期更倾向在我可以接受杭州生活/u);
  assert.match(messages[0].content, /如果关系稳定，我希望未来要孩子/u);
  assert.match(messages[0].content, /我在财务安排上更看重务实稳定，也不太接受隐性负债/u);
  assert.match(messages[0].content, /希望关系稳定后以结婚为目标/u);
  assert.match(messages[0].content, /如果 speaker_fact_cards 里有 naturalAnswerHint/u);
});

test("城市字段会自然化，避免把原始碎片直接塞进生活模板", () => {
  const singleCity = buildProfile({ cities: "上海" });
  const mixedCity = buildProfile({ cities: "上海、杭州也可以" });
  const openCity = buildProfile({ cities: "我可以接受杭州" });
  const vagueCity = buildProfile({ cities: "我可以接受" });

  assert.equal(__testOnlyBuildTopicAnswer(singleCity, "cities"), "我长期更倾向在上海生活。");
  assert.equal(__testOnlyBuildTopicAnswer(mixedCity, "cities"), "我长期更倾向在上海生活，杭州也可以接受。");
  assert.equal(__testOnlyBuildTopicAnswer(openCity, "cities"), "我对长期生活城市还算开放，杭州也可以接受。");
  assert.equal(
    __testOnlyBuildTopicAnswer(vagueCity, "cities"),
    "我对长期生活城市还算开放，但更具体的城市偏好需要再结合实际情况确认。"
  );
});

test("关系目标等 topic 会生成可直接说出口的 naturalAnswerHint", () => {
  const relationshipGoal = buildProfile({
    relationshipGoal: "认真长期关系，希望以结婚为目标"
  });
  const marriageTimeline = buildProfile({
    marriageTimeline: "如果关系稳定，我希望 1 到 2 年内推进结婚"
  });
  const familyBoundary = buildProfile({
    familyBoundary: "住得近，但边界要清楚"
  });
  const financialView = buildProfile({
    financialView: "务实稳定，不接受隐性负债"
  });

  assert.equal(
    __testOnlyBuildTopicAnswer(relationshipGoal, "relationshipGoal"),
    "我希望进入认真、长期的关系，也希望关系稳定后以结婚为目标。"
  );
  assert.equal(
    __testOnlyBuildTopicAnswer(marriageTimeline, "marriageTimeline"),
    "如果关系稳定，我希望 1 到 2 年内推进结婚。"
  );
  assert.equal(
    __testOnlyBuildTopicAnswer(familyBoundary, "familyBoundary"),
    "婚后居住安排上，我可以接受和父母住得更近，但还是希望边界清楚。"
  );
  assert.equal(
    __testOnlyBuildTopicAnswer(financialView, "financialView"),
    "在财务安排上，我更看重务实和稳定，也不接受隐性负债。"
  );
});

test("fact card 一致提供 rawValue、normalizedSummary 和 naturalAnswerHint", () => {
  const card = __testOnlyBuildFactCard(buildProfile({ cities: "上海、杭州也可以" }), "cities");

  assert.equal(card.rawValue, "上海、杭州也可以");
  assert.equal(card.normalizedSummary, "长期更倾向上海，杭州也可接受");
  assert.equal(card.naturalAnswerHint, "我长期更倾向在上海生活，杭州也可以接受。");
});

test("病句守卫会重写 malformed city shell，并记录 rewrite 元数据", () => {
  process.env.LLM_TELEMETRY_PATH = telemetryPath;
  const speaker = buildProfile({
    userId: "self",
    displayName: "雨涵",
    cities: "我可以接受杭州",
    marriageTimeline: "如果关系稳定，我希望 1 到 2 年内推进结婚"
  });
  const listener = buildProfile({
    userId: "other",
    displayName: "刘宇",
    cities: "上海"
  });

  const guarded = __testOnlyApplyChineseQualityGuard({
    result: {
      reply: "我这边长期更倾向在我可以接受生活。",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: [],
      risk_flags: [],
      needs_human_input: { required: false, field: null, question: null, target_user_for_input: null },
      recommendation: "continue"
    },
    speaker,
    listener,
    objectives: [
      { key: "cities", label: "城市与生活安排", prompt: "确认长期城市安排。" },
      { key: "marriageTimeline", label: "结婚节奏", prompt: "确认结婚节奏。" }
    ],
    turns: [
      {
        actorUserId: "other",
        content: "你未来更倾向在哪个城市生活？"
      }
    ]
  });

  assert.match(guarded.reply, /杭州也可以接受/u);
  assert.match(guarded.reply, /结婚节奏/u);
  assert.doesNotMatch(guarded.reply, /在我可以接受生活/u);
  assert.equal(guarded.reply_quality_issue, "malformed_city_shell");
  assert.equal(guarded.rewrite_applied, true);
  assert.equal(guarded.rewrite_failed, false);

  const events = fs.readFileSync(telemetryPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).reply_quality_issue, "malformed_city_shell");
  assert.equal(events.at(-1).rewrite_applied, true);
  assert.equal(events.at(-1).rewrite_failed, false);
});

test("半结构化关系目标片段会被自然改写，而不是直接镜像对方提问", () => {
  const speaker = buildProfile({
    userId: "self",
    relationshipGoal: "认真长期关系，希望以结婚为目标",
    cities: "上海"
  });
  const listener = buildProfile({ userId: "other", relationshipGoal: "认真发展" });

  const guarded = __testOnlyApplyChineseQualityGuard({
    result: {
      reply: "关系目标上，我这边是认真长期关系，希望以结婚为目标。你这边是？",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: [],
      risk_flags: [],
      needs_human_input: { required: false, field: null, question: null, target_user_for_input: null },
      recommendation: "continue"
    },
    speaker,
    listener,
    objectives: [
      { key: "relationshipGoal", label: "关系目标", prompt: "确认关系目标。" },
      { key: "cities", label: "城市与生活安排", prompt: "确认长期城市安排。" }
    ],
    turns: [
      {
        actorUserId: "other",
        content: "你的关系目标是什么？"
      }
    ]
  });

  assert.match(guarded.reply, /我希望进入认真、长期的关系/u);
  assert.doesNotMatch(guarded.reply, /我这边是认真长期关系/u);
  assert.equal(guarded.rewrite_applied, true);
});

test("如果自动改写后仍然不安全，就强制 needs_human_input", () => {
  process.env.LLM_TELEMETRY_PATH = telemetryPath;
  const speaker = buildProfile({
    userId: "self",
    cities: ""
  });
  const listener = buildProfile({
    userId: "other",
    cities: "上海"
  });

  const guarded = __testOnlyApplyChineseQualityGuard({
    result: {
      reply: "我这边长期更倾向在我可以接受生活。",
      is_sensitive_question: false,
      sensitive_topic_category: null,
      needs_sensitive_approval: false,
      target_user_for_approval: null,
      confirmed_facts: [],
      open_questions: [],
      risk_flags: [],
      needs_human_input: { required: false, field: null, question: null, target_user_for_input: null },
      recommendation: "continue"
    },
    speaker,
    listener,
    objectives: [{ key: "cities", label: "城市与生活安排", prompt: "确认长期城市安排。" }],
    turns: [
      {
        actorUserId: "other",
        content: "你未来更倾向在哪个城市生活？"
      }
    ]
  });

  assert.equal(guarded.reply, "");
  assert.equal(guarded.needs_human_input.required, true);
  assert.equal(guarded.recommendation, "pause_review");
  assert.equal(guarded.reply_quality_issue, "malformed_city_shell");
  assert.equal(guarded.rewrite_failed, true);
  assert.equal(guarded.model_output_failure?.reason, "model_output_unstable");
  assert.equal(guarded.needs_human_input.question, "模型输出不可用，需要人工确认。");

  const events = fs.readFileSync(telemetryPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).rewrite_failed, true);
});

test("合法 childrenPreference mirror question 不应被 quality guard 判成表述不自然", () => {
  const speaker = buildProfile({
    userId: "speaker",
    displayName: "刘星",
    childrenPreference: "希望未来要孩子"
  });
  const listener = buildProfile({
    userId: "listener",
    displayName: "雨涵",
    childrenPreference: "希望未来要孩子，但不想立刻推进生育"
  });

  const guarded = __testOnlyApplyChineseQualityGuard({
    session: {
      id: "session-1",
      initiatorUserId: "listener",
      counterpartyUserId: "speaker"
    },
    result: {
      reply: "关于孩子这件事，我目前倾向于未来要孩子。关于孩子这件事，你未来更倾向怎样的安排？",
      reply_topic_key: "childrenPreference",
      question_topic_key: "childrenPreference",
      canonical_reply_topic_key: "childrenPreference",
      canonical_question_topic_key: "childrenPreference",
      canonical_question_text: "关于孩子这件事，你未来更倾向怎样的安排？",
      confirmed_facts: [
        {
          subjectUserId: "speaker",
          key: "childrenPreference",
          value: "希望未来要孩子",
          confidence: 0.9,
          status: "confirmed"
        }
      ],
      open_questions: ["关于孩子这件事，你未来更倾向怎样的安排？"],
      risk_flags: [],
      needs_human_input: { required: false, field: null, question: null, target_user_for_input: null },
      recommendation: "continue",
      did_answer_required_question: true,
      mirror_question_required_for_coverage: true,
      mirror_question_allowed: true
    },
    speaker,
    listener,
    objectives: [{ key: "childrenPreference", label: "孩子与生育态度", prompt: "确认对未来孩子与生育的态度。" }],
    turns: [
      {
        actorUserId: "listener",
        actorRole: "counterparty_twin",
        content: "关于孩子这件事，你未来更倾向怎样的安排？",
        metadata: {
          canonical_question_topic_key: "childrenPreference"
        }
      }
    ]
  });

  assert.equal(guarded.needs_human_input?.required, false);
  assert.equal(guarded.reply, "关于孩子这件事，我目前倾向于未来要孩子。关于孩子这件事，你未来更倾向怎样的安排？");
});
