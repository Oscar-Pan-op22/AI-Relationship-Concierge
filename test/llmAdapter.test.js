import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  __testOnlyRepairJson,
  generatePrechatTurn,
  summarizeStage
} from "../src/lib/llmAdapter.js";

const originalFetch = global.fetch;
const telemetryPath = path.join(process.cwd(), "data", "test-llm-events.jsonl");

test.afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.LLM_TELEMETRY_PATH;

  if (fs.existsSync(telemetryPath)) {
    fs.unlinkSync(telemetryPath);
  }
});

test("repairJson 能从混杂文本里提取 JSON", () => {
  const repaired = __testOnlyRepairJson("说明文字```json\n{\"reply\":\"ok\"}\n```");
  assert.equal(repaired, "{\"reply\":\"ok\"}");
});

test("generatePrechatTurn 能解析带额外文本的 JSON 输出", async () => {
  process.env.LLM_TELEMETRY_PATH = telemetryPath;
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                "这里是额外说明```json\n{\"reply\":\"你好\",\"confirmed_facts\":[],\"open_questions\":[],\"risk_flags\":[],\"needs_human_input\":{\"required\":false},\"recommendation\":\"pause_review\"}\n```"
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
  assert.equal(result.recommendation, "pause_review");
  assert.equal(fs.existsSync(telemetryPath), true);
});

test("LLM 失败时会返回 fallback，而不是抛出异常", async () => {
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
