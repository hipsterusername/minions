import type Database from "better-sqlite3";
import { WorkItemConflictError } from "./work-item-repo.ts";

export type WakeEligibility = "eligible" | "obsolete";
export interface WakeCheckpoint {
  attempts: number;
  nextAt: number;
  state: "pending" | "delivered" | "obsolete" | "failed";
  reason?: string;
}
export interface WakeDeliveryStore {
  eligibility(workItemId: string, runKey: string): WakeEligibility;
  get(runKey: string, key: string): WakeCheckpoint | undefined;
  put(runKey: string, key: string, checkpoint: WakeCheckpoint): void;
}
export class WakeDeliveryError extends Error {
  constructor(readonly disposition: "obsolete" | "transient" | "unknown", message: string) {
    super(message);
  }
}
export function wakeFailureDisposition(error: unknown): "obsolete" | "transient" | "unknown" {
  if (error instanceof WakeDeliveryError) return error.disposition;
  if (error instanceof WorkItemConflictError) return error.latest ? "transient" : "obsolete";
  const code = (error as { code?: string } | null)?.code;
  if (code === "SESSION_CAPACITY_REACHED" || code === "conflict" || code === "SQLITE_BUSY" || code === "SQLITE_LOCKED"
    || code === "ETIMEDOUT" || code === "ECONNRESET") return "transient";
  if (code === "not_found" || code === "invalid_transition" || code === "idempotency_mismatch") return "obsolete";
  return "unknown";
}
export function primaryWakeEligibility(db: Database.Database, workItemId: string, runKey: string): WakeEligibility {
  // Eligibility never loads reports, run configuration or transcript bodies.
  const eligible = db.prepare(`SELECT 1 FROM sessions AS run JOIN work_items AS item
    ON item.id=run.work_item_id WHERE item.id=? AND run.session_key=?
    AND run.run_kind='primary' AND item.current_run_key=run.session_key
    AND run.ended_at IS NULL AND item.resolution='open'
    AND item.runtime_state IN ('working','waiting','starting')`).get(workItemId, runKey);
  if (!eligible) return "obsolete";
  const intent = db.prepare(`SELECT termination_intent FROM run_invocations
    WHERE run_key = ? ORDER BY provider_generation DESC LIMIT 1`).get(runKey) as
    { termination_intent: string | null } | undefined;
  return intent?.termination_intent && ["stop", "close", "remove", "abort"].includes(intent.termination_intent)
    ? "obsolete" : "eligible";
}
export function createWakeDeliveryStore(db: Database.Database): WakeDeliveryStore {
  db.exec(`CREATE TABLE IF NOT EXISTS wake_delivery (
    run_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
    wake_key TEXT NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL,
    state TEXT NOT NULL, reason TEXT, PRIMARY KEY(run_key, wake_key))`);
  return {
    eligibility: (item, run) => primaryWakeEligibility(db, item, run),
    get(run, key) {
      return db.prepare(`SELECT attempts, next_at AS nextAt, state, reason FROM wake_delivery
        WHERE run_key = ? AND wake_key = ?`).get(run, key) as WakeCheckpoint | undefined;
    },
    put(run, key, value) {
      // Removed hosts cannot recreate durable state via a late callback.
      db.prepare(`INSERT INTO wake_delivery(run_key,wake_key,attempts,next_at,state,reason)
        SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM sessions WHERE session_key=?)
        ON CONFLICT(run_key,wake_key) DO UPDATE SET attempts=excluded.attempts,
        next_at=excluded.next_at,state=excluded.state,reason=excluded.reason`)
        .run(run, key, value.attempts, value.nextAt, value.state, value.reason ?? null, run);
    },
  };
}
