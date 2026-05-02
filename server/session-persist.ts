/**
 * Server-side session persistence glue.
 *
 * Owns a single SQLite connection at `~/.minions/server.db` (overridable
 * via the `MINIONS_SERVER_DB` env var) and exposes small, synchronous helpers
 * that map the in-memory `Session` shape used by `server/index.ts` onto the
 * repo layer in `session-repo.ts`.
 *
 * Phase 4.4 exit criteria:
 *   - `hydrateSessionsFromDb()` populates the in-memory Map at boot so task
 *     plans, render dashboards, and basic metadata survive a server restart.
 *   - `persistSession`, `persistTaskState`, `persistRenderState`, and
 *     `removePersistedSession` are called from every mutation site, so the
 *     on-disk state tracks in-memory state continuously (write-through cache).
 *
 * Non-goals:
 *   - We deliberately do NOT persist volatile handles (`abortController`,
 *     `queryHandle`, `waitTimerId`) — those are tied to the running process.
 *   - We do NOT rehydrate live SDK `queryHandle`s. Restored sessions come back
 *     with `status = "stopped"` and no handle; the client can reopen them.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { initDb } from "./db.ts";
import * as repo from "./session-repo.ts";
import type { TaskManagerState } from "./task-tools.ts";
import type { RenderState } from "./render-tools.ts";
import {
  MAX_BUFFERED_EVENTS,
  type BufferedEvent,
} from "./session-host-config.ts";

// ── Connection management ───────────────────────────────

let dbHandle: Database.Database | null = null;
/** Set to `true` to silently no-op all writes/reads (used by tests). */
let disabled = false;

function defaultDbPath(): string {
  if (process.env["MINIONS_SERVER_DB"]) {
    return process.env["MINIONS_SERVER_DB"]!;
  }
  const dir = path.join(os.homedir(), ".minions");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "server.db");
}

/**
 * Open the persistence DB. Idempotent — repeated calls reuse the first handle.
 * Returns the handle so callers can introspect it in tests.
 */
export function openPersistDb(dbPath?: string): Database.Database {
  if (dbHandle) return dbHandle;
  dbHandle = initDb(dbPath ?? defaultDbPath());
  disabled = false;
  return dbHandle;
}

/** Close and forget the DB handle. Primarily for test isolation. */
export function closePersistDb(): void {
  if (dbHandle) {
    try {
      dbHandle.close();
    } catch {
      /* ignore */
    }
    dbHandle = null;
  }
}

/**
 * Disable persistence for this process. When disabled every helper returns
 * a safe no-op — useful in environments where an on-disk DB would be noise
 * (unit tests that don't care about persistence).
 */
export function disablePersistence(): void {
  closePersistDb();
  disabled = true;
}

function ensureDb(): Database.Database | null {
  if (disabled) return null;
  if (!dbHandle) {
    try {
      return openPersistDb();
    } catch (err) {
      console.warn("[session-persist] failed to open DB, disabling:", err);
      disabled = true;
      return null;
    }
  }
  return dbHandle;
}

// ── Shape adapters ──────────────────────────────────────

/**
 * Minimal subset of the in-memory `Session` struct we care about persisting.
 * We avoid importing the full type to keep the dependency arrow one-way
 * (index.ts → session-persist.ts, not the reverse).
 */
export interface PersistableSession {
  id: string;
  status: string;
  cwd: string;
  model: string | null;
  role: string;
  taskName: string | null;
  /**
   * SDK session id from the first `system/init` event. May be `null`
   * before the SDK has handed one out (e.g. during the brief
   * `creating → running` window). Persisting it lets `send_message`
   * pass `resume:` after a server restart.
   */
  sessionId: string | null;
  worktreeIsolation: boolean;
  totalCost: number;
  turns: number;
}

function sessionToRow(
  s: PersistableSession,
  nowIso: string,
): repo.SessionRow {
  return {
    session_key: s.id,
    project_id: null,
    node_id: null,
    status: s.status,
    cwd: s.cwd,
    model: s.model,
    role: s.role,
    task_name: s.taskName,
    session_id: s.sessionId,
    worktree_isolation: s.worktreeIsolation ? 1 : 0,
    total_cost: s.totalCost,
    turns: s.turns,
    // created_at is only used when the row is new; upsert preserves the
    // existing value on conflict so it's safe to send "now" here as a
    // placeholder — the schema default would cover new rows anyway, but
    // we set it explicitly for insert consistency.
    created_at: nowIso,
    updated_at: nowIso,
  };
}

// ── Write helpers (called from mutation sites) ──────────

export function persistSession(s: PersistableSession): void {
  const db = ensureDb();
  if (!db) return;
  try {
    const nowIso = new Date().toISOString();
    repo.upsertSession(db, sessionToRow(s, nowIso));
  } catch (err) {
    console.warn("[session-persist] upsertSession failed:", err);
  }
}

export function removePersistedSession(sessionKey: string): void {
  const db = ensureDb();
  if (!db) return;
  try {
    repo.deleteSession(db, sessionKey);
    repo.deleteRenderState(db, sessionKey);
    repo.purgeEventsForSession(db, sessionKey);
    // task records are cascaded logically (we delete rows whose leader key
    // matches) — no FK so we do it explicitly.
    db.prepare(
      "DELETE FROM task_records WHERE leader_session_key = ?",
    ).run(sessionKey);
  } catch (err) {
    console.warn("[session-persist] removePersistedSession failed:", err);
  }
}

/**
 * Append a single buffered event to the on-disk event_log so it survives
 * a restart. Called from `SessionHost.bufferEvent` as a write-through
 * cache — every event the server fans out to clients also lands on disk.
 *
 * Without this, completed/stopped sessions hydrate with an empty buffer
 * and the client has nothing to rebuild chat history from.
 */
export function persistEvent(
  sessionKey: string,
  event: BufferedEvent,
): void {
  const db = ensureDb();
  if (!db) return;
  try {
    repo.appendEvent(db, sessionKey, event.type, event);
  } catch (err) {
    console.warn("[session-persist] persistEvent failed:", err);
  }
}

/**
 * Load the tail of the event log for a session, capped to the same
 * retention window the in-memory `eventBuffer` keeps. Returned events
 * are in chronological (ASC) order so they slot directly into the
 * buffer.
 */
export function loadRecentEvents(
  sessionKey: string,
  limit: number = MAX_BUFFERED_EVENTS,
): BufferedEvent[] {
  const db = ensureDb();
  if (!db) return [];
  try {
    const rows = repo.getRecentEvents(db, sessionKey, limit);
    return rows.map((r) => JSON.parse(r.payload) as BufferedEvent);
  } catch (err) {
    console.warn("[session-persist] loadRecentEvents failed:", err);
    return [];
  }
}

/**
 * Persist the full task-manager state for a leader. This rewrites the leader's
 * task_records rows: we upsert every current task and drop any stale task_id
 * that's no longer in the in-memory map. Callers invoke this on every
 * task-plan mutation — cost is O(n) in tasks, which is small.
 */
export function persistTaskState(
  leaderSessionKey: string,
  state: TaskManagerState,
): void {
  const db = ensureDb();
  if (!db) return;
  try {
    const currentIds = new Set(state.tasks.keys());
    const existing = repo.getTaskRecordsForLeader(db, leaderSessionKey);
    for (const row of existing) {
      if (!currentIds.has(row.taskId)) {
        repo.deleteTaskRecord(db, row.taskId);
      }
    }
    for (const rec of state.tasks.values()) {
      repo.upsertTaskRecord(db, rec);
    }
  } catch (err) {
    console.warn("[session-persist] persistTaskState failed:", err);
  }
}

/**
 * Wipe every persisted event for a session without removing the session row
 * itself. Used by `clear_session` to make the event history disappear from
 * both the in-memory buffer and the on-disk log so it doesn't re-appear on
 * reconnect.
 */
export function clearSessionEvents(sessionKey: string): void {
  const db = ensureDb();
  if (!db) return;
  try {
    repo.purgeEventsForSession(db, sessionKey);
  } catch (err) {
    console.warn("[session-persist] clearSessionEvents failed:", err);
  }
}

export function persistRenderState(
  sessionKey: string,
  state: RenderState,
): void {
  const db = ensureDb();
  if (!db) return;
  try {
    repo.upsertRenderState(db, sessionKey, state);
  } catch (err) {
    console.warn("[session-persist] persistRenderState failed:", err);
  }
}

// ── Boot-time hydration ─────────────────────────────────

/**
 * Shape returned to `server/index.ts` for re-materializing in-memory state.
 * The server owns the actual `Session` struct, so we hand it the raw pieces
 * and it wires them together (volatile fields like AbortController are
 * freshly constructed by the caller).
 */
export interface HydratedSession {
  row: repo.SessionRow;
  tasks: TaskManagerState | null;
  render: RenderState | null;
  events: BufferedEvent[];
}

export function hydrateSessionsFromDb(): HydratedSession[] {
  const db = ensureDb();
  if (!db) return [];

  let rows: repo.SessionRow[];
  try {
    rows = repo.getAllSessions(db);
  } catch (err) {
    console.warn("[session-persist] getAllSessions failed:", err);
    return [];
  }

  const out: HydratedSession[] = [];
  for (const row of rows) {
    let tasks: TaskManagerState | null = null;
    if (row.role === "leader") {
      const records = repo.getTaskRecordsForLeader(db, row.session_key);
      if (records.length > 0) {
        const map = new Map(records.map((r) => [r.taskId, r]));
        tasks = { tasks: map, pendingWait: null, approval: null };
      } else {
        tasks = { tasks: new Map(), pendingWait: null, approval: null };
      }
    }
    const render = repo.getRenderState(db, row.session_key);
    const events = loadRecentEvents(row.session_key);
    out.push({ row, tasks, render, events });
  }
  return out;
}
