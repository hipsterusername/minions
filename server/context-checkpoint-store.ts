import type { ContextCheckpoint } from "./context-checkpoint.ts";
import { serverLogger } from "./logging.ts";
import { persistenceDb } from "./session-persist.ts";

const log = serverLogger.child("context-checkpoint-store");

export function persistContextCheckpoint(checkpoint: ContextCheckpoint): void {
  const db = persistenceDb();
  if (!db) return;
  try {
    db.prepare(`
      INSERT INTO context_checkpoints (
        checkpoint_id, session_key, source_session_id, target_session_id,
        trigger, status, checkpoint_json, created_at, committed_at,
        failed_at, failure_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(checkpoint_id) DO UPDATE SET
        target_session_id = excluded.target_session_id,
        status = excluded.status,
        checkpoint_json = excluded.checkpoint_json,
        committed_at = excluded.committed_at,
        failed_at = excluded.failed_at,
        failure_reason = excluded.failure_reason
    `).run(
      checkpoint.checkpointId, checkpoint.sessionKey,
      checkpoint.sourceSessionId, checkpoint.targetSessionId,
      checkpoint.trigger, checkpoint.status, JSON.stringify(checkpoint),
      checkpoint.createdAt, checkpoint.committedAt, checkpoint.failedAt,
      checkpoint.failureReason,
    );
  } catch (err) {
    log.warn("persist_failed", { error: err });
  }
}

export function loadLatestContextCheckpoint(sessionKey: string): ContextCheckpoint | null {
  const db = persistenceDb();
  if (!db) return null;
  try {
    const row = db.prepare(`SELECT checkpoint_json FROM context_checkpoints
      WHERE session_key = ? ORDER BY created_at DESC LIMIT 1`).get(sessionKey) as
      { checkpoint_json: string } | undefined;
    return row ? JSON.parse(row.checkpoint_json) as ContextCheckpoint : null;
  } catch (err) {
    log.warn("load_failed", { error: err });
    return null;
  }
}
