import type Database from "better-sqlite3";
import { TaskGraphRepository } from "./repository.ts";
import { TaskGraphScheduler } from "./scheduler.ts";

type Row = Record<string, unknown>;
export interface DispatchRecord { id:string;runId:string;attemptId:string;generation:number;kind:string;payload:unknown; }

export class TaskGraphRecovery {
  readonly scheduler: TaskGraphScheduler;
  constructor(readonly repo: TaskGraphRepository) { this.scheduler = new TaskGraphScheduler(repo); }
  get db(): Database.Database { return this.repo.db; }

  recover(runId: string, ownerId: string, now: number, leaseTtlMs: number): { fencingToken:number; pending:DispatchRecord[] } {
    return this.db.transaction(() => {
      const fencingToken = this.scheduler.acquireLease(runId,ownerId,now,leaseTtlMs);
      const expired = this.db.prepare(`SELECT a.* FROM task_node_attempts a JOIN task_resource_reservations r
        ON r.attempt_id=a.id WHERE a.run_id=? AND a.runtime<>'terminal' AND r.released_at IS NULL AND r.expires_at<=?`)
        .all(runId,now) as Row[];
      for (const attempt of expired) {
        const run = this.db.prepare("SELECT revision FROM task_graph_runs WHERE id=?").get(runId) as Row;
        this.scheduler.recoverLostAttempt(runId,String(attempt.id),Number(attempt.generation),
          Number(run.revision),now);
      }
      return { fencingToken,pending:this.pendingDispatches(runId) };
    }).immediate();
  }

  pendingDispatches(runId: string, limit = 100): DispatchRecord[] {
    const rows = this.db.prepare(`SELECT * FROM task_scheduler_outbox WHERE run_id=? AND delivered_at IS NULL
      ORDER BY CASE WHEN kind='cancel_child' THEN 0 ELSE 1 END,created_at,id LIMIT ?`).all(runId,limit) as Row[];
    return rows.map(row => ({ id:String(row.id),runId:String(row.run_id),attemptId:String(row.attempt_id),
      generation:Number(row.generation),kind:String(row.kind),payload:JSON.parse(String(row.payload_json)) }));
  }

  markDelivered(id: string, attemptId: string, generation: number, at: number): boolean {
    return this.db.transaction(()=>{
      const row=this.db.prepare(`SELECT kind FROM task_scheduler_outbox WHERE id=? AND attempt_id=?
        AND generation=? AND delivered_at IS NULL`).get(id,attemptId,generation) as Row|undefined;
      if (!row) return false;
      const result = this.db.prepare(`UPDATE task_scheduler_outbox SET delivered_at=? WHERE id=? AND attempt_id=?
        AND generation=? AND delivered_at IS NULL`).run(at,id,attemptId,generation);
      if (result.changes===1 && row.kind === "cancel_child") this.db.prepare(`UPDATE task_resource_reservations
        SET released_at=? WHERE attempt_id=? AND released_at IS NULL AND kind NOT LIKE 'budget_%'`)
        .run(at,attemptId);
      return result.changes === 1;
    }).immediate();
  }
}
