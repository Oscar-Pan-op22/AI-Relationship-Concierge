import fs from "node:fs";
import path from "node:path";

function resolveTelemetryPath() {
  return (
    process.env.LLM_TELEMETRY_PATH ||
    path.join(process.cwd(), "data", "llm-events.jsonl")
  );
}

export function writeLlmTelemetry(event) {
  try {
    const targetPath = resolveTelemetryPath();
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.appendFileSync(targetPath, `${JSON.stringify(event)}\n`, "utf8");
  } catch (error) {
    console.warn("[llm-telemetry] write_failed", error instanceof Error ? error.message : String(error));
  }
}
