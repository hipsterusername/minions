import type Database from "better-sqlite3";

export interface DurableWaitRecoveryRow {
  id:string;
  current_run_key:string;
  lifecycle_revision:number;
  runtime_state:string;
  wait_kind:string|null;
  review_state:string|null;
  task_state_json:string|null;
}

function durableWaitKind(row:DurableWaitRecoveryRow):"decision"|"other"|null {
  if (row.review_state==="decision_needed") return "decision";
  if (!row.task_state_json) return null;
  try {
    const state=JSON.parse(row.task_state_json) as {pendingWait?:unknown}|null;
    return state?.pendingWait?"other":null;
  } catch {
    return null;
  }
}

/** Converge clean between-turn recovery with independently persisted wait evidence. */
export function reconcileDurableWaitAtBoot(db:Database.Database,row:DurableWaitRecoveryRow,
  at:number):boolean {
  const waitKind=durableWaitKind(row);
  if (!waitKind || (row.runtime_state==="waiting"&&row.wait_kind===waitKind)) return false;
  const changed=db.prepare(`UPDATE work_items SET runtime_state='waiting',wait_kind=?,
    lifecycle_revision=lifecycle_revision+1,last_transition_at=?,updated_at=?
    WHERE id=? AND current_run_key=? AND lifecycle_revision=?
    AND runtime_state IN ('starting','working','waiting') AND outcome='none'`)
    .run(waitKind,at,at,row.id,row.current_run_key,row.lifecycle_revision);
  return changed.changes===1;
}
