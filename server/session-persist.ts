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
import type { ApprovalState, TaskManagerState } from "./task-tools.ts";
import type { RenderState } from "../shared/render-dsl.ts";
import type { WorktreeInfo } from "./worktree-types.ts";
import {
  MAX_BUFFERED_EVENTS,
  type BufferedEvent,
} from "./session-host-config.ts";
import {
  emptyUsageTotals,
  getSessionUsageTotals,
  insertSessionUsage,
  type SessionUsageRowInput,
  type SessionUsageTotals,
} from "./usage-telemetry.ts";
import { serverLogger } from "./logging.ts";
import { reviewLifecycleToColumns, type SessionReviewLifecycle } from "./session-review-lifecycle.ts";
import { ensureWorkItemSchema } from "./work-item-schema.ts";
import { removeSessionPersistence } from "./session-persist-remove.ts";

const log = serverLogger.child("session-persist");
// ── Connection management ───────────────────────────────

let dbHandle: Database.Database | null = null;
/** Set to `true` to silently no-op all writes/reads (used by tests). */
let disabled = false;

function defaultDbPath(): string {
  if (process.env["MINIONS_SERVER_DB"]) {
    return process.env["MINIONS_SERVER_DB"]!;
  }
  const dir = path.join(os.homedir(), ".minions");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Windows and restricted filesystems may not expose POSIX modes.
  }
  return path.join(dir, "server.db");
}

/**
 * Open the persistence DB. Idempotent — repeated calls reuse the first handle.
 * Returns the handle so callers can introspect it in tests.
 */
export function openPersistDb(dbPath?: string): Database.Database {
  if (dbHandle) return dbHandle;
  const resolvedPath = dbPath ?? defaultDbPath();
  dbHandle = initDb(resolvedPath);
  ensureWorkItemSchema(dbHandle);
  try {
    fs.chmodSync(resolvedPath, 0o600);
  } catch {
    // Best effort on platforms without POSIX permissions.
  }
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
      log.warn("database_open_failed", { error: err });
      disabled = true;
      return null;
    }
  }
  return dbHandle;
}

/** Shared only by narrowly scoped persistence companions. */
export function persistenceDb(): Database.Database | null { return ensureDb(); }
// ── Shape adapters ──────────────────────────────────────

/**
 * Minimal subset of the in-memory `Session` struct we care about persisting.
 * We avoid importing the full type to keep the dependency arrow one-way
 * (index.ts → session-persist.ts, not the reverse).
 */
export interface PersistableSession {
  id: string;
  projectId?: string | null;
  nodeId?: string | null;
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
  worktree: WorktreeInfo | null;
  approval: ApprovalState | null;
  totalCost: number;
  turns: number;
  /**
   * Registered AgentHarness name driving this session. Persisted so the
   * restored host resumes on the same harness it started on. Defaults
   * to "claude" when the row was written before this column existed.
   */
  harnessName: string;
  reviewLifecycle?: SessionReviewLifecycle;
}

function sessionToRow(
  s: PersistableSession,
  nowIso: string,
  existing: repo.SessionRow | null,
): repo.SessionRow {
  return {
    session_key: s.id,
    project_id: s.projectId ?? existing?.project_id ?? null,
    node_id: s.nodeId ?? existing?.node_id ?? null,
    status: s.status,
    cwd: s.cwd,
    model: s.model,
    role: s.role,
    task_name: s.taskName,
    session_id: existing?.work_item_id && existing.ended_at != null
      ? existing.session_id
      : s.sessionId,
    worktree_isolation: s.worktreeIsolation ? 1 : 0,
    worktree_path: s.worktree?.path ?? null,
    worktree_branch: s.worktree?.branch ?? null,
    worktree_project_path: s.worktree?.projectPath ?? null,
    worktree_created_at: s.worktree?.createdAt ?? null,
    worktree_lifecycle: s.worktree?.lifecycle ?? null,
    approval_json: s.approval ? JSON.stringify(s.approval) : null,
    total_cost: s.totalCost,
    turns: s.turns,
    harness_name: s.harnessName,
    ...reviewLifecycleToColumns(s.reviewLifecycle),
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
    repo.upsertSession(db, sessionToRow(s, nowIso, repo.getSession(db, s.id)));
  } catch (err) {
    log.warn("session_upsert_failed", { error: err });
  }
}

export function removePersistedSession(sessionKey: string): boolean {
  const db = ensureDb();
  if (!db) return false;
  try {
    return removeSessionPersistence(db, sessionKey);
  } catch (err) {
    log.warn("session_remove_failed", { error: err });
    return false;
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
    log.warn("event_persist_failed", { error: err });
  }
}

export function persistSessionUsage(row: SessionUsageRowInput): void {
  const db = ensureDb();
  if (!db) return;
  try {
    insertSessionUsage(db, row);
  } catch (err) {
    log.warn("usage_persist_failed", { error: err });
  }
}

export function loadSessionUsageTotals(sessionKey: string): SessionUsageTotals {
  const db = ensureDb();
  if (!db) return emptyUsageTotals();
  try {
    return getSessionUsageTotals(db, sessionKey);
  } catch (err) {
    log.warn("usage_load_failed", { error: err });
    return emptyUsageTotals();
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
    log.warn("recent_events_load_failed", { error: err });
    return [];
  }
}

/**
 * Persist the full task-manager state for a leader. This rewrites the leader's
 * task_records rows for that leader: we upsert every current task and drop any
 * stale task_id that's no longer in the in-memory map. Callers invoke this on every
 * task-plan mutation — cost is O(n) in tasks, which is small.
 */
export function persistTaskState(
  leaderSessionKey: string,
  state: TaskManagerState,
): void {
  const db = ensureDb();
  if (!db) return;
  try {
    db.transaction(() => {
      const currentIds = new Set(state.tasks.keys());
      const existing = repo.getTaskRecordsForLeader(db, leaderSessionKey);
      for (const row of existing) {
        if (!currentIds.has(row.taskId)) {
          repo.deleteTaskRecord(db, leaderSessionKey, row.taskId);
        }
      }
      for (const rec of state.tasks.values()) {
        repo.upsertTaskRecord(db, rec);
      }
      repo.updateSessionApproval(db, leaderSessionKey, state.approval);
    })();
  } catch (err) {
    log.warn("task_state_persist_failed", { error: err });
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
    log.warn("session_events_clear_failed", { error: err });
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
    log.warn("render_state_persist_failed", { error: err });
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
  usageTotals: SessionUsageTotals;
}

export function hydrateSessionsFromDb(): HydratedSession[] {
  const db = ensureDb();
  if (!db) return [];

  let rows: repo.SessionRow[];
  try {
    rows = repo.getAllSessions(db);
  } catch (err) {
    log.warn("sessions_load_failed", { error: err });
    return [];
  }

  const out: HydratedSession[] = [];
  for (const row of rows) {
    let tasks: TaskManagerState | null = null;
    if (row.role === "leader") {
      let approval: ApprovalState | null = null;
      if (row.approval_json) {
        try {
          approval = JSON.parse(row.approval_json) as ApprovalState;
        } catch {
          approval = null;
        }
      }
      const records = repo.getTaskRecordsForLeader(db, row.session_key);
      if (records.length > 0) {
        const map = new Map(records.map((r) => [r.taskId, r]));
        tasks = { tasks: map, pendingWait: null, approval };
      } else {
        tasks = { tasks: new Map(), pendingWait: null, approval };
      }
    }
    const render = repo.getRenderState(db, row.session_key);
    const events = loadRecentEvents(row.session_key);
    const usageTotals = loadSessionUsageTotals(row.session_key);
    out.push({ row, tasks, render, events, usageTotals });
  }
  return out;
}
