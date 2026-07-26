/** Server-side write-through persistence and boot hydration glue. */

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
const armedSystemPrompts = new Map<string, string>();
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

/** Open the persistence DB, reusing the current handle. */
export function openPersistDb(dbPath?: string): Database.Database {
  if (dbHandle) return dbHandle;
  const resolvedPath = dbPath ?? defaultDbPath();
  dbHandle = initDb(resolvedPath);
  ensureWorkItemSchema(dbHandle);
  dbHandle.exec(`
    CREATE TABLE IF NOT EXISTS session_armed_prompts (
      session_key TEXT PRIMARY KEY,
      system_prompt TEXT NOT NULL
    )
  `);
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
  armedSystemPrompts.clear();
}

/** Disable persistence and retain only process-local armed prompts. */
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

/** Freeze the fully compiled prompt on first spawn and return its durable value. */
export function persistArmedSystemPrompt(
  sessionKey: string,
  systemPrompt: string,
): string {
  const cached = armedSystemPrompts.get(sessionKey);
  if (cached !== undefined) return cached;
  const db = ensureDb();
  if (!db) {
    armedSystemPrompts.set(sessionKey, systemPrompt);
    return systemPrompt;
  }
  try {
    db.prepare(`
      INSERT OR IGNORE INTO session_armed_prompts (session_key, system_prompt)
      VALUES (?, ?)
    `).run(sessionKey, systemPrompt);
    const row = db.prepare(
      "SELECT system_prompt FROM session_armed_prompts WHERE session_key = ?",
    ).get(sessionKey) as { system_prompt: string };
    armedSystemPrompts.set(sessionKey, row.system_prompt);
    return row.system_prompt;
  } catch (err) {
    log.warn("armed_system_prompt_persist_failed", { error: err });
    armedSystemPrompts.set(sessionKey, systemPrompt);
    return systemPrompt;
  }
}

export function loadArmedSystemPrompt(sessionKey: string): string | null {
  const cached = armedSystemPrompts.get(sessionKey);
  if (cached !== undefined) return cached;
  const db = ensureDb();
  if (!db) return null;
  try {
    const row = db.prepare(
      "SELECT system_prompt FROM session_armed_prompts WHERE session_key = ?",
    ).get(sessionKey) as { system_prompt: string } | undefined;
    if (row) armedSystemPrompts.set(sessionKey, row.system_prompt);
    return row?.system_prompt ?? null;
  } catch (err) {
    log.warn("armed_system_prompt_load_failed", { error: err });
    return null;
  }
}
// ── Shape adapters ──────────────────────────────────────

/** Durable subset of SessionHost without importing it back into this layer. */
export interface PersistableSession {
  id: string;
  projectId?: string | null;
  nodeId?: string | null;
  status: string;
  cwd: string;
  model: string | null;
  role: string;
  taskName: string | null;
  /** SDK session id used to resume after a restart. */
  sessionId: string | null;
  worktreeIsolation: boolean;
  worktree: WorktreeInfo | null;
  approval: ApprovalState | null;
  totalCost: number;
  turns: number;
  /** Registered harness; legacy rows default to "claude". */
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
    // Upsert preserves the original created_at.
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
    const removed = removeSessionPersistence(db, sessionKey);
    if (removed) {
      db.prepare("DELETE FROM session_armed_prompts WHERE session_key = ?")
        .run(sessionKey);
      armedSystemPrompts.delete(sessionKey);
    }
    return removed;
  } catch (err) {
    log.warn("session_remove_failed", { error: err });
    return false;
  }
}

/** Append an event so hydrated sessions can rebuild their transcript. */
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

/** Load the bounded event tail in chronological order. */
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

/** Rewrite a leader's small task set, dropping stale records. */
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

/** Wipe session events while retaining the session row. */
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

/** Durable pieces used to rematerialize a host with fresh volatile handles. */
export interface HydratedSession {
  row: repo.SessionRow;
  armedSystemPrompt: string | null;
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
    out.push({
      row,
      armedSystemPrompt: loadArmedSystemPrompt(row.session_key),
      tasks,
      render,
      events,
      usageTotals,
    });
  }
  return out;
}
