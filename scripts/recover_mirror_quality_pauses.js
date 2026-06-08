import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import {
  getSessionViewWithAutoRecovery
} from "../src/lib/prechatService.js";

const dbPath = process.env.TONGPIN_DB_PATH || path.join(process.cwd(), "data", "tongpin.sqlite");
const db = new DatabaseSync(dbPath, { readonly: true });

const rows = db.prepare(`
  select
    r.id as request_id,
    r.session_id,
    r.target_user_id,
    r.question_text,
    r.status,
    r.metadata_json,
    s.status as session_status
  from human_input_requests r
  join prechat_sessions s on s.id = r.session_id
  where r.status = 'pending'
    and r.question_text = '这一轮预沟通的表述不够自然，请本人确认后再继续。'
  order by r.created_at asc
`).all();

const recovered = [];
const skipped = [];

for (const row of rows) {
  try {
    const before = await getSessionViewWithAutoRecovery(row.session_id, row.target_user_id);
    const pending = (before?.humanInputRequests || []).filter((item) => item.status === "pending");
    const stillPending = pending.some((item) => item.id === row.request_id);

    if (stillPending) {
      skipped.push({
        requestId: row.request_id,
        sessionId: row.session_id,
        reason: "not_auto_recovered"
      });
      continue;
    }

    const after = await getSessionViewWithAutoRecovery(row.session_id, row.target_user_id);
    recovered.push({
      requestId: row.request_id,
      sessionId: row.session_id,
      status: after?.session?.status || null
    });
  } catch (error) {
    skipped.push({
      requestId: row.request_id,
      sessionId: row.session_id,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}

console.log(
  JSON.stringify(
    {
      scanned: rows.length,
      recovered,
      skipped
    },
    null,
    2
  )
);
