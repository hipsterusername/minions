import type Database from "better-sqlite3";
import type {
  WorkItemBindingRow,
  WorkItemRow,
  WorkItemRunRow,
} from "./work-item-repo.ts";

function decode(cursor: string | undefined, scope: string): [number, string] | null {
  if (!cursor) return null;
  const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { scope?: unknown; tuple?: unknown };
  if (value.scope !== scope || !Array.isArray(value.tuple) || typeof value.tuple[0] !== "number" || typeof value.tuple[1] !== "string") throw new Error("invalid cursor");
  return [value.tuple[0], value.tuple[1]];
}
function encode(scope: string, value: [number, string]): string {
  return Buffer.from(JSON.stringify({ scope, tuple: value })).toString("base64url");
}

export function listWorkItemsPage(db: Database.Database, input: {
  projectId: string; includeArchived?: boolean; cursor?: string; limit: number;
}): { rows: WorkItemRow[]; nextCursor: string | null } {
  const scope = `items:${input.projectId}:${input.includeArchived === true}`;
  const cursor = decode(input.cursor, scope);
  const rows = db.prepare(`
    SELECT * FROM work_items
    WHERE project_id = ? ${input.includeArchived ? "" : "AND resolution <> 'archived'"}
      ${cursor ? "AND (updated_at < ? OR (updated_at = ? AND id < ?))" : ""}
    ORDER BY updated_at DESC, id DESC LIMIT ?
  `).all(input.projectId, ...(cursor ? [cursor[0], cursor[0], cursor[1]] : []), input.limit + 1) as WorkItemRow[];
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit); const last = page.at(-1);
  return { rows: page, nextCursor: hasMore && last ? encode(scope, [last.updated_at, last.id]) : null };
}

export function listWorkItemRunsPage(db: Database.Database, input: {
  workItemId: string; cursor?: string; limit: number;
}): { rows: WorkItemRunRow[]; nextCursor: string | null } {
  const scope = `runs:${input.workItemId}`; const cursor = decode(input.cursor, scope);
  const rows = db.prepare(`
    SELECT session_key, work_item_id, run_number, run_kind, previous_run_key,
           parent_run_key, task_id, started_at, ended_at, run_outcome,
           final_report_event_id, start_idempotency_key, session_id, final_report, provider_generation, run_config_json, harness_name, model
    FROM sessions WHERE work_item_id = ?
      ${cursor ? "AND (started_at < ? OR (started_at = ? AND session_key < ?))" : ""}
    ORDER BY started_at DESC, session_key DESC LIMIT ?
  `).all(input.workItemId, ...(cursor ? [cursor[0], cursor[0], cursor[1]] : []), input.limit + 1) as WorkItemRunRow[];
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit); const last = page.at(-1);
  return { rows: page, nextCursor: hasMore && last ? encode(scope, [last.started_at, last.session_key]) : null };
}

export function listWorkItemBindings(db: Database.Database, workItemId: string): WorkItemBindingRow[] {
  return db.prepare(`
    SELECT * FROM work_item_bindings
    WHERE work_item_id = ? AND surface = 'canvas'
    ORDER BY binding_id
  `).all(workItemId) as WorkItemBindingRow[];
}

export function getRunByStartRequest(
  db: Database.Database, workItemId: string, requestId: string,
): WorkItemRunRow | null {
  const row = db.prepare(`SELECT session_key FROM sessions
    WHERE work_item_id = ? AND start_idempotency_key = ?`).get(workItemId, requestId) as
    { session_key: string } | undefined;
  if (!row) return null;
  return db.prepare(`SELECT session_key, work_item_id, run_number, run_kind,
    previous_run_key, parent_run_key, task_id, started_at, ended_at, run_outcome,
    final_report_event_id, start_idempotency_key, session_id, final_report, provider_generation, run_config_json, harness_name, model
    FROM sessions WHERE session_key = ?`).get(row.session_key) as WorkItemRunRow;
}
