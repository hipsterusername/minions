/**
 * Session persistence repository layer.
 *
 * Typed CRUD operations over the `sessions`, `task_records`, `render_state`,
 * and `event_log` SQLite tables. All functions take an explicit `db` handle
 * so callers control the connection lifecycle.
 */

import type Database from "better-sqlite3";
import type { TaskRecord } from "./task-tools.ts";
import type { RenderState } from "./render-tools.ts";

// ── Row types ────────────────────────────────────────────

export interface SessionRow {
  session_key: string;
  project_id: string | null;
  node_id: string | null;
  status: string;
  cwd: string | null;
  model: string | null;
  role: string;
  task_name: string | null;
  /**
   * SDK session id captured from the first `system/init` event. Persisted
   * so `send_message` can pass it as `resume:` after a server restart —
   * without it, the SDK starts a fresh conversation with no transcript.
   */
  session_id: string | null;
  worktree_isolation: number;
  total_cost: number;
  turns: number;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  id: number;
  event_type: string;
  payload: string;
  created_at: string;
}

// ── Sessions ─────────────────────────────────────────────

export function upsertSession(db: Database.Database, row: SessionRow): void {
  const stmt = db.prepare(`
    INSERT INTO sessions (
      session_key, project_id, node_id, status, cwd, model, role,
      task_name, session_id, worktree_isolation, total_cost, turns,
      created_at, updated_at
    ) VALUES (
      @session_key, @project_id, @node_id, @status, @cwd, @model, @role,
      @task_name, @session_id, @worktree_isolation, @total_cost, @turns,
      @created_at, @updated_at
    )
    ON CONFLICT(session_key) DO UPDATE SET
      project_id = excluded.project_id,
      node_id = excluded.node_id,
      status = excluded.status,
      cwd = excluded.cwd,
      model = excluded.model,
      role = excluded.role,
      task_name = excluded.task_name,
      session_id = excluded.session_id,
      worktree_isolation = excluded.worktree_isolation,
      total_cost = excluded.total_cost,
      turns = excluded.turns,
      updated_at = excluded.updated_at
  `);
  stmt.run(row);
}

export function getSession(
  db: Database.Database,
  sessionKey: string,
): SessionRow | null {
  const stmt = db.prepare("SELECT * FROM sessions WHERE session_key = ?");
  return (stmt.get(sessionKey) as SessionRow | undefined) ?? null;
}

export function getAllSessions(db: Database.Database): SessionRow[] {
  const stmt = db.prepare("SELECT * FROM sessions ORDER BY created_at");
  return stmt.all() as SessionRow[];
}

export function deleteSession(
  db: Database.Database,
  sessionKey: string,
): void {
  db.prepare("DELETE FROM sessions WHERE session_key = ?").run(sessionKey);
}

// ── Task records ─────────────────────────────────────────

export function upsertTaskRecord(
  db: Database.Database,
  record: TaskRecord,
): void {
  const stmt = db.prepare(`
    INSERT INTO task_records (
      task_id, leader_session_key, title, description, priority,
      executor, minion_session_key, status, result, created_at, completed_at
    ) VALUES (
      @taskId, @leaderSessionKey, @title, @description, @priority,
      @executor, @minionSessionKey, @status, @result, @createdAt, @completedAt
    )
    ON CONFLICT(task_id) DO UPDATE SET
      leader_session_key = excluded.leader_session_key,
      title = excluded.title,
      description = excluded.description,
      priority = excluded.priority,
      executor = excluded.executor,
      minion_session_key = excluded.minion_session_key,
      status = excluded.status,
      result = excluded.result,
      completed_at = excluded.completed_at
  `);
  stmt.run(record);
}

export function getTaskRecordsForLeader(
  db: Database.Database,
  leaderSessionKey: string,
): TaskRecord[] {
  const stmt = db.prepare(
    "SELECT * FROM task_records WHERE leader_session_key = ? ORDER BY created_at",
  );
  const rows = stmt.all(leaderSessionKey) as Array<{
    task_id: string;
    leader_session_key: string;
    title: string;
    description: string;
    priority: string;
    executor: string;
    minion_session_key: string | null;
    status: string;
    result: string | null;
    created_at: number;
    completed_at: number | null;
  }>;
  return rows.map((r) => ({
    taskId: r.task_id,
    leaderSessionKey: r.leader_session_key,
    title: r.title,
    description: r.description,
    priority: r.priority as TaskRecord["priority"],
    executor: r.executor as TaskRecord["executor"],
    minionSessionKey: r.minion_session_key,
    status: r.status as TaskRecord["status"],
    result: r.result,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  }));
}

export function deleteTaskRecord(
  db: Database.Database,
  taskId: string,
): void {
  db.prepare("DELETE FROM task_records WHERE task_id = ?").run(taskId);
}

// ── Render state ─────────────────────────────────────────

export function upsertRenderState(
  db: Database.Database,
  sessionKey: string,
  state: RenderState,
): void {
  const stmt = db.prepare(`
    INSERT INTO render_state (session_key, title, columns, gap, components)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_key) DO UPDATE SET
      title = excluded.title,
      columns = excluded.columns,
      gap = excluded.gap,
      components = excluded.components
  `);
  stmt.run(
    sessionKey,
    state.title,
    state.columns,
    state.gap,
    JSON.stringify(state.components),
  );
}

export function getRenderState(
  db: Database.Database,
  sessionKey: string,
): RenderState | null {
  const stmt = db.prepare(
    "SELECT * FROM render_state WHERE session_key = ?",
  );
  const row = stmt.get(sessionKey) as
    | {
        session_key: string;
        title: string;
        columns: number;
        gap: number;
        components: string;
      }
    | undefined;
  if (!row) return null;
  return {
    title: row.title,
    columns: row.columns,
    gap: row.gap,
    components: JSON.parse(row.components),
  };
}

export function deleteRenderState(
  db: Database.Database,
  sessionKey: string,
): void {
  db.prepare("DELETE FROM render_state WHERE session_key = ?").run(sessionKey);
}

// ── Event log ────────────────────────────────────────────

export function appendEvent(
  db: Database.Database,
  sessionKey: string,
  eventType: string,
  payload: unknown,
): void {
  const stmt = db.prepare(
    "INSERT INTO event_log (session_key, event_type, payload) VALUES (?, ?, ?)",
  );
  stmt.run(sessionKey, eventType, JSON.stringify(payload));
}

export function getEvents(
  db: Database.Database,
  sessionKey: string,
  limit?: number,
): EventRow[] {
  if (limit != null) {
    const stmt = db.prepare(
      "SELECT id, event_type, payload, created_at FROM event_log WHERE session_key = ? ORDER BY id LIMIT ?",
    );
    return stmt.all(sessionKey, limit) as EventRow[];
  }
  const stmt = db.prepare(
    "SELECT id, event_type, payload, created_at FROM event_log WHERE session_key = ? ORDER BY id",
  );
  return stmt.all(sessionKey) as EventRow[];
}

/**
 * Return the most recent `limit` events for a session in chronological
 * (ASC) order. Used by hydration to restore the in-memory `eventBuffer`
 * with only the tail an active session would have kept anyway.
 */
export function getRecentEvents(
  db: Database.Database,
  sessionKey: string,
  limit: number,
): EventRow[] {
  const stmt = db.prepare(
    "SELECT id, event_type, payload, created_at FROM event_log WHERE session_key = ? ORDER BY id DESC LIMIT ?",
  );
  const rows = stmt.all(sessionKey, limit) as EventRow[];
  return rows.reverse();
}

/**
 * Bulk-delete every event row for a session. Called on session removal so
 * disposed sessions don't leave orphan event_log entries behind. Distinct
 * from per-event deletion (which the repo deliberately does not expose)
 * because session lifecycle cleanup is a separate concern from event
 * mutation.
 */
export function purgeEventsForSession(
  db: Database.Database,
  sessionKey: string,
): void {
  db.prepare("DELETE FROM event_log WHERE session_key = ?").run(sessionKey);
}
