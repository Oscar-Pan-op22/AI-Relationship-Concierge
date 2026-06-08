import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  __testOnlyBuildTurnPrompt,
  __testOnlyBuildManualQuestionPrompt,
  __testOnlyRepairJson,
  classifyManualQuestion,
  generatePrechatTurn,
  summarizeStage,
  MANUAL_QUESTION_PROMPT_VERSION,
  STAGE_PROMPT_VERSION,
  TURN_PROMPT_VERSION
} from "../src/lib/llmAdapter.js";

const originalFetch = global.fetch;
const telemetryPath = path.join(process.cwd(), "data", "test-llm-events.jsonl");

function readTelemetry() {
  return fs
    .readFileSync(telemetryPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test.afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.LLM_TELEMETRY_PATH;

  if (fs.existsSync(telemetryPath)) {
    fs.unlinkSync(telemetryPath);
  }
});

test("repairJson 可以从混杂文本里提取 JSON", () => {
  const repaired = __testOnlyRepairJson("说明文字```json\n{\"reply\":\"ok\"}\n```");
  assert.equal(repaired, "{\"reply\":\"ok\"}");
});

test("buildTurnPrompt 会暴露 turn prompt version", () => {
  const messages = __testOnlyBuildTurnPrompt({
    turn_frame: {
      reply_obligation: "listener_question",
      reply_target: {
        text: "你未来更倾向长期在哪个城市生活？",
        topicKey: "cities"
      },
      topic_plan: {
        activeTopicKey: "cities",
        canSwitchOnlyAfterClose: true,
        nextCandidateTopicKey: "familyBoundary"
      }
    },
    active_topic: "cities",
    active_topic_state: { state: "waiting_counterparty" },
    closed_topic_keys: ["relationshipGoal"],
    forbidden_topic_keys: ["relationshipGoal"],
    next_candidate_topic_key: "familyBoundary",
    speaker_fact_cards: [],
    listener_fact_cards: [],
    conversation_state: {
      conversation_started: true,
      is_first_twin_message: true,
      latest_turn_from_listener: true,
      latest_turn_is_question: true
    },
    recent_turns: []
  });

  assert.match(messages[0].content, new RegExp(TURN_PROMPT_VERSION, "u"));
  assert.match(messages[0].content, /question_topic_key/u);
  assert.match(messages[0].content, /closed_topic_keys/u);
  assert.match(messages[0].content, /只有整段会话里的第一条 Twin 消息允许带一次极短身份说明/u);
  assert.match(messages[0].content, /第一完整句必须先正面回答那个问题/u);
  assert.match(messages[0].content, /conversation_state\.is_first_twin_message=true/u);
  assert.match(messages[0].content, /不能直接进入你自己的新问题/u);
  assert.match(messages[0].content, /不允许只做身份说明就直接发起自己的问题/u);
  assert.match(messages[0].content, /turn_frame/u);
  assert.match(messages[0].content, /reply_obligation/u);
  assert.match(messages[0].content, /当 turn_frame 与其他平铺字段看起来有冲突时，以 turn_frame 为准/u);
});

test("buildTurnPrompt 会把首条 Twin 的短介绍 + 先回答 + 再追问规则写清楚", () => {
  const messages = __testOnlyBuildTurnPrompt({
    turn_frame: {
      reply_obligation: "listener_question",
      reply_target: {
        text: "你未来更倾向长期在上海还是杭州生活？",
        topicKey: "cities"
      },
      topic_plan: {
        activeTopicKey: "cities",
        canSwitchOnlyAfterClose: true,
        nextCandidateTopicKey: "marriageTimeline"
      }
    },
    active_topic: "cities",
    active_topic_state: { state: "waiting_counterparty" },
    closed_topic_keys: [],
    forbidden_topic_keys: [],
    next_candidate_topic_key: "marriageTimeline",
    speaker_fact_cards: [
      {
        topicKey: "cities",
        naturalAnswerHint: "我这边长期更倾向上海，杭州也可以接受。",
        normalizedSummary: "长期更倾向上海，杭州也可以接受"
      }
    ],
    listener_fact_cards: [],
    suggested_answer_material: {
      topicKey: "cities",
      naturalAnswerHint: "我这边长期更倾向上海，杭州也可以接受。"
    },
    conversation_state: {
      conversation_started: true,
      is_first_twin_message: true,
      latest_turn_from_listener: true,
      latest_turn_is_question: true,
      latest_turn_content: "你未来更倾向长期在上海还是杭州生活？"
    },
    recent_turns: []
  });

  assert.match(messages[0].content, /短的身份说明开头/u);
  assert.match(messages[0].content, /然后立刻进入内容/u);
  assert.match(messages[0].content, /必须先回答，再最多追问一个新的问题/u);
  assert.match(messages[0].content, /不允许把对方的问题改写后问回去/u);
  assert.match(messages[0].content, /你好，我是雨涵的 Twin/u);
  assert.match(messages[0].content, /在财务安排上，我更看重务实稳定，也会留意负债风险。婚后和父母的相处边界上，你更偏向怎样的安排/u);
  assert.match(messages[0].content, /suggested_answer_material/u);
  assert.match(messages[0].content, /如果当前 active_topic 在这条回复后已经足够关闭，禁止继续追问同一个 active_topic/u);
  assert.match(messages[0].content, /规则优先级固定为：1\. 先满足 turn_frame\.reply_obligation/u);
  assert.match(messages[0].content, /active_topic=relationshipGoal，但 reply_obligation=cities 时，必须先答 cities/u);
});

test("buildTurnPrompt 会明确禁止非首条 Twin 消息重复自我介绍", () => {
  const messages = __testOnlyBuildTurnPrompt({
    turn_frame: {
      reply_obligation: "listener_question",
      reply_target: {
        text: "你未来更倾向长期在上海还是杭州生活？",
        topicKey: "cities"
      },
      topic_plan: {
        activeTopicKey: "cities",
        canSwitchOnlyAfterClose: true,
        nextCandidateTopicKey: "marriageTimeline"
      }
    },
    active_topic: "cities",
    active_topic_state: { state: "waiting_counterparty" },
    closed_topic_keys: [],
    forbidden_topic_keys: [],
    next_candidate_topic_key: "marriageTimeline",
    speaker_fact_cards: [],
    listener_fact_cards: [],
    conversation_state: {
      conversation_started: true,
      is_first_twin_message: false,
      latest_turn_from_listener: true,
      latest_turn_is_question: true,
      latest_turn_content: "你未来更倾向长期在上海还是杭州生活？"
    },
    recent_turns: []
  });

  assert.match(messages[0].content, /如果 conversation_state\.is_first_twin_message=false，禁止再次出现/u);
  assert.match(messages[0].content, /只有在 conversation_state\.is_first_twin_message=true 时/u);
  assert.match(messages[0].content, /整段会话已经出现过 Twin 消息后，又重复说/u);
  assert.match(messages[0].content, /双方都已经表达过同一个 topic 的核心答案后，又把同一题换句话再问一次/u);
  assert.doesNotMatch(
    messages[0].content,
    /你好，我是刘宇的 Twin。我对长期生活城市还算开放，杭州也可以接受。你这边会更想留在上海/u
  );
  assert.match(messages[0].content, /reply_topic_key 只描述回答段真正回答的是哪个 topic/u);
  assert.match(messages[0].content, /question_topic_key 只描述最后那个追问对应的 topic/u);
  assert.match(messages[0].content, /却把 question_topic_key 写成 cities/u);
  assert.match(messages[0].content, /如果最终 reply 被重写成只有一个问题、没有回答段，那么 reply_topic_key 必须写 null/u);
  assert.match(messages[0].content, /身份说明不算回答段/u);
  assert.match(messages[0].content, /closed_topic_keys 或 forbidden_topic_keys 里，绝对不能再问/u);
  assert.match(messages[0].content, /如果最终 reply 的问题文本被改写了，question_topic_key 和 open_questions 必须同时改成与最终问题完全一致的内容/u);
  assert.match(messages[0].content, /confirmed_facts 里只允许保留 topic=A 的事实/u);
  assert.match(messages[0].content, /reply_topic_key 却还是 marriageTimeline，confirmed_facts 也还是 financialView/u);
  assert.match(messages[0].content, /cities 已经 closed，却又重新问/u);
  assert.match(messages[0].content, /frame-first 正例：上一条问 marriageTimeline/u);
  assert.match(messages[0].content, /frame-first 反例：上一条问 marriageTimeline，却回答 financialView/u);
});

test("buildManualQuestionPrompt 会暴露 manual question prompt version", () => {
  const messages = __testOnlyBuildManualQuestionPrompt({
    manual_message: { content: "你未来更想在哪个城市生活？" },
    recent_turns: [],
    receiver_fact_cards: []
  });

  assert.match(messages[0].content, new RegExp(MANUAL_QUESTION_PROMPT_VERSION, "u"));
});

test("generatePrechatTurn 可以解析夹带额外文本的 JSON 输出，并记录 prompt_version", async () => {
  process.env.LLM_TELEMETRY_PATH = telemetryPath;
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                "这里是额外说明```json\n{\"reply\":\"你好\",\"reply_topic_key\":\"unknown\",\"question_topic_key\":null,\"confirmed_facts\":[],\"open_questions\":[],\"risk_flags\":[],\"needs_human_input\":{\"required\":false},\"recommendation\":\"pause_review\"}\n```"
            }
          }
        ]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );

  const result = await generatePrechatTurn({ hello: "world" });

  assert.equal(result.reply, "你好");
  assert.equal(result.reply_topic_key, "unknown");
  assert.equal(result.recommendation, "pause_review");
  assert.equal(fs.existsSync(telemetryPath), true);

  const events = readTelemetry();
  assert.equal(events.length, 1);
  assert.equal(events.at(-1).prompt_version, TURN_PROMPT_VERSION);
  assert.equal(events.at(-1).request_type, "turn");
  assert.equal(events.at(-1).rewrite_applied, false);
});

test("LLM 失败时返回 fallback，并记录 fallback telemetry", async () => {
  process.env.LLM_TELEMETRY_PATH = telemetryPath;
  global.fetch = async () =>
    new Response(JSON.stringify({ error: "bad gateway" }), {
      status: 502,
      headers: { "Content-Type": "application/json" }
    });

  const turn = await generatePrechatTurn({ hello: "world" });
  const stage = await summarizeStage({ hello: "world" });

  assert.equal(turn.needs_human_input.required, true);
  assert.equal(turn.recommendation, "pause_review");
  assert.equal(stage.next_action, "pause_review");
  assert.equal(fs.existsSync(telemetryPath), true);

  const events = readTelemetry();
  assert.equal(events.length, 2);
  assert.equal(events[0].prompt_version, TURN_PROMPT_VERSION);
  assert.equal(events[0].used_fallback, true);
  assert.equal(events[1].prompt_version, STAGE_PROMPT_VERSION);
  assert.equal(events[1].used_fallback, true);
});

test("classifyManualQuestion 可以解析真人问题分类输出", async () => {
  process.env.LLM_TELEMETRY_PATH = telemetryPath;
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                is_question: true,
                question_text: "你希望多久内考虑结婚？",
                question_topic: "marriageTimeline",
                can_answer_from_context: false,
                needs_sensitive_approval: false,
                sensitive_topic_category: null,
                needs_human_input: true,
                human_input_question: "请直接说明你希望多久内考虑结婚。"
              })
            }
          }
        ]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );

  const result = await classifyManualQuestion({ manual_message: { content: "你希望多久内考虑结婚？" } });
  assert.equal(result.is_question, true);
  assert.equal(result.question_topic, "marriageTimeline");
  assert.equal(result.needs_human_input, true);

  const events = readTelemetry();
  assert.equal(events.at(-1).prompt_version, MANUAL_QUESTION_PROMPT_VERSION);
  assert.equal(events.at(-1).request_type, "manual_question_classification");
});

test("非法 recommendation 会触发 fallback", async () => {
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                reply: "你好",
                confirmed_facts: [],
                open_questions: [],
                risk_flags: [],
                needs_human_input: { required: false },
                recommendation: "keep_going"
              })
            }
          }
        ]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );

  const result = await generatePrechatTurn({ hello: "world" });
  assert.equal(result.needs_human_input.required, true);
  assert.equal(result.recommendation, "pause_review");
});

test("非法敏感类别会触发 fallback", async () => {
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                reply: "你收入多少？",
                is_sensitive_question: true,
                sensitive_topic_category: "salary_only",
                needs_sensitive_approval: true,
                target_user_for_approval: "listener",
                confirmed_facts: [],
                open_questions: ["收入情况"],
                risk_flags: [],
                needs_human_input: { required: false },
                recommendation: "continue"
              })
            }
          }
        ]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );

  const result = await generatePrechatTurn({ hello: "world" });
  assert.equal(result.needs_human_input.required, true);
  assert.equal(result.recommendation, "pause_review");
});
