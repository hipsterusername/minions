/**
 * Routine run persistence — write-through SQLite layer for RoutineRunSnapshot.
 *
 * Mirrors the pattern in `server/session-persist.ts`:
 *   - Shares the same SQLite connection managed by `openPersistDb`.
 *   - Every snapshot transition is upserted immediately (write-through cache).
 *   - `loadRecentRuns` hydrates terminal runs on registry boot so a server
 *     restart still surfaces recent run history.
 *   - Old terminal runs are pruned on each persist, bounded by a configurable
 *     time window and a per-project count ceiling.
 *
 * Non-goals (deliberate):
 *   - Live-resume of in-flight runs — that requires re-attaching leader
 *     sessions and lands in a separate PR.
 *   - Per-run event-log persistence — full transcripts live on the spawned
 *     Leader sessions, not here.
 */

import { openPersistDb } from "./session-persist.ts";
import {
  routineRunSnapshotSchema,
  type RoutineRunSnapshot,
} from "../shared/routines/types.ts";
import type Database from "better-sqlite3";

// ── Configuration ───────────────────────────────────────────────────────────

/** Maximum terminal runs retained per project path. */
export const MAX_RETAINED_RUNS = 50;

// ── Connection management ───────────────────────────────────────────────────

/**
 * When `true` every helper is a no-op. Flipped by `disableRoutinePersist()`
 * for unit tests that don't care about persistence.
 */
let disabled = false;

/** No-op all helpers for this process. */
export function disableRoutinePersist(): void {
  disabled = true;
}

/** Re-enable after `disableRoutinePersist()` — primarily for test teardown. */
export function enableRoutinePersist(): void {
  disabled = false;
}

function ensureDb(): Database.Database | null {
  if (disabled) return null;
  try {
    return openPersistDb();
  } catch (err) {
    console.warn("[routine-persist] failed to open DB, disabling:", err);
    disabled = true;
    return null;
  }
}

// ── Write ───────────────────────────────────────────────────────────────────

/**
 * Upsert a run snapshot. Call on every snapshot transition so the on-disk
 * state tracks in-memory state continuously. The `ended_at` and `state`
 * columns are denormalised for efficient pruning queries.
 */
export function persistRun(
  snapshot: RoutineRunSnapshot,
  projectPath: string,
): void {
  const db = ensureDb();
  if (!db) return;
  try {
    db.prepare(
      `INSERT INTO routine_runs
         (run_id, routine_id, project_path, snapshot_json, started_at, ended_at, state)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         snapshot_json = excluded.snapshot_json,
         ended_at      = excluded.ended_at,
         state         = excluded.state`,
    ).run(
      snapshot.runId,
      snapshot.routineId,
      projectPath,
      JSON.stringify(snapshot),
      snapshot.startedAt,
      snapshot.endedAt ?? null,
      snapshot.state,
    );
  } catch (err) {
    console.warn("[routine-persist] persistRun failed:", err);
  }
}

// ── Read ────────────────────────────────────────────────────────────────────

/**
 * Load the `limit` most recent **terminal** runs for a project path.
 *
 * Pass `null` for `projectPath` to load across all projects — used by the
 * registry constructor to hydrate on boot before any live run is started.
 *
 * Rows whose `snapshot_json` is malformed or fails schema validation are
 * silently dropped rather than crashing the caller.
 */
export function loadRecentRuns(
  projectPath: string | null,
  limit: number,
): RoutineRunSnapshot[] {
  const db = ensureDb();
  if (!db) return [];
  try {
    const TERMINAL_STATES = `state IN ('success','error','aborted')`;
    const rows = (
      projectPath === null
        ? db
            .prepare(
              `SELECT snapshot_json FROM routine_runs
               WHERE ${TERMINAL_STATES}
               ORDER BY started_at DESC LIMIT ?`,
            )
            .all(limit)
        : db
            .prepare(
              `SELECT snapshot_json FROM routine_runs
               WHERE project_path = ? AND ${TERMINAL_STATES}
               ORDER BY started_at DESC LIMIT ?`,
            )
            .all(projectPath, limit)
    ) as Array<{ snapshot_json: string }>;

    const out: RoutineRunSnapshot[] = [];
    for (const row of rows) {
      try {
        const result = routineRunSnapshotSchema.safeParse(
          JSON.parse(row.snapshot_json),
        );
        if (result.success) out.push(result.data);
      } catch {
        // malformed JSON — drop silently
      }
    }
    return out;
  } catch (err) {
    console.warn("[routine-persist] loadRecentRuns failed:", err);
    return [];
  }
}

// ── Prune ───────────────────────────────────────────────────────────────────

/**
 * Prune terminal runs for a project:
 *   1. Time-based: remove runs whose `ended_at` is older than `olderThanMs`.
 *   2. Count-based: cap to `keepLatestN` most recent terminal runs.
 *
 * Live (non-terminal) runs are never touched.
 */
export function pruneRunsOlderThan(
  projectPath: string,
  olderThanMs: number,
  keepLatestN: number = MAX_RETAINED_RUNS,
): void {
  const db = ensureDb();
  if (!db) return;
  try {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    db.prepare(
      `DELETE FROM routine_runs
       WHERE project_path = ?
         AND state IN ('success','error','aborted')
         AND ended_at IS NOT NULL
         AND ended_at < ?`,
    ).run(projectPath, cutoff);

    // Cap to keepLatestN most recent terminal runs per project.
    db.prepare(
      `DELETE FROM routine_runs
       WHERE project_path = ?
         AND state IN ('success','error','aborted')
         AND run_id NOT IN (
           SELECT run_id FROM routine_runs
           WHERE project_path = ?
             AND state IN ('success','error','aborted')
           ORDER BY started_at DESC
           LIMIT ?
         )`,
    ).run(projectPath, projectPath, keepLatestN);
  } catch (err) {
    console.warn("[routine-persist] pruneRunsOlderThan failed:", err);
  }
}
