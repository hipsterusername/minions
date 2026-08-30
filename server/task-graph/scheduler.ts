import type Database from "better-sqlite3";
import type { AttemptEvent } from "../../shared/task-graph-contracts.ts";
import { attemptEventSchema } from "../../shared/task-graph-contracts.ts";
import { TaskGraphConflictError, TaskGraphValidationError } from "./errors.ts";
import { readiness, type NodeReadiness } from "./readiness.ts";
import { TaskGraphRepository } from "./repository.ts";
import { contentHash } from "./hash.ts";
import { TaskGraphEvidence } from "./evidence.ts";

type Row = Record<string, unknown>;
export interface Admission { attemptId: string; nodeId: string; generation: number; outboxId: string; }

export class TaskGraphScheduler {
  constructor(readonly repo: TaskGraphRepository) {}
  get db(): Database.Database { return this.repo.db; }

  acquireLease(runId: string, ownerId: string, now: number, ttlMs: number): number {
    if (ttlMs < 1) throw new TaskGraphValidationError("lease ttl must be positive");
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM task_scheduler_leases WHERE run_id=?").get(runId) as Row | undefined;
      if (row && Number(row.expires_at) > now && row.owner_id !== ownerId) throw new TaskGraphConflictError("scheduler lease held");
      const liveRenewal = row && Number(row.expires_at) > now && row.owner_id === ownerId;
      const token = row ? Number(row.fencing_token) + (liveRenewal ? 0 : 1) : 1;
      this.db.prepare(`INSERT INTO task_scheduler_leases VALUES(?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET
        owner_id=excluded.owner_id,fencing_token=excluded.fencing_token,expires_at=excluded.expires_at,renewed_at=excluded.renewed_at`)
        .run(runId, ownerId, token, now + ttlMs, now);
      return token;
    }).immediate();
  }

  inspect(runId: string, now: number,globalCapacityAvailable=true): NodeReadiness[] {
    const snap = this.repo.snapshot(runId, 0);
    const run=this.db.prepare("SELECT * FROM task_graph_runs WHERE id=?").get(runId) as Row;
    const structural=readiness(this.db, runId, snap.revision, now);
    if (Boolean(run.paused)) return structural.map(item=>item.ready
      ? {...item,ready:false,reason:"graph_paused"} : item);
    if (!globalCapacityAvailable) return structural.map(item=>item.ready
      ? {...item,ready:false,reason:"global_capacity"} : item);
    const active=Number((this.db.prepare(`SELECT count(*) n FROM task_node_attempts
      WHERE run_id=? AND runtime<>'terminal'`).get(runId) as Row).n);
    return structural.map(item=>{
      if (!item.ready) return item;
      if (active>=Number(run.max_active_attempts)) return {...item,ready:false,reason:"graph_capacity"};
      const node=snap.revision.nodes.find(candidate=>candidate.id===item.nodeId)!;
      const blocker=this.reservationBlocker(run,snap.revision,node);
      return blocker ? {...item,ready:false,reason:blocker} : item;
    });
  }

  schedule(input: { runId: string; expectedRunRevision: number; ownerId: string; fencingToken: number;
    now: number; admissionLimit?: number }): Admission[] {
    return this.db.transaction(() => {
      const run = this.assertRunAndLease(input);
      if (Boolean(run.paused) || !["active","quiescent","blocked"].includes(String(run.status))) return [];
      const active = Number((this.db.prepare("SELECT count(*) n FROM task_node_attempts WHERE run_id=? AND runtime<>'terminal'").get(input.runId) as Row).n);
      const capacity = Math.max(0,Math.min(Number(run.max_active_attempts)-active,
        input.admissionLimit ?? Number.POSITIVE_INFINITY));
      const spec = this.repo.getRevision(String(run.revision_id));
      const readyIds = new Set(readiness(this.db, input.runId, spec, input.now).filter(item => item.ready).map(item => item.nodeId));
      const admitted: Admission[] = [];
      for (const node of spec.nodes) {
        if (admitted.length >= capacity) break;
        if (!readyIds.has(node.id) || this.reservationBlocker(run,spec,node)) continue;
        const prior = this.db.prepare(`SELECT attempt_number n,generation g,outcome FROM task_node_attempts
          WHERE run_id=? AND node_id=? ORDER BY attempt_number DESC LIMIT 1`)
          .get(input.runId,node.id) as Row|undefined;
        const attemptNumber = Number(prior?.n ?? 0) + 1; const generation = Number(prior?.g ?? 0) + 1;
        const nonRetryable=prior?.outcome && prior.outcome!=="none" && prior.outcome!=="succeeded"
          && prior.outcome!=="superseded"
          && !node.retryPolicy.retryableOutcomes.includes(prior.outcome as "failed"|"lost"|"cancelled");
        if (attemptNumber > node.retryPolicy.maxAttempts || nonRetryable) {
          const consumed = this.db.prepare(`UPDATE task_manual_retry_grants SET remaining=remaining-1
            WHERE run_id=? AND node_id=? AND remaining>0`).run(input.runId,node.id);
          if (consumed.changes !== 1) continue;
        }
        const attemptId = this.repo.newId("attempt"); const outboxId = `dispatch:${attemptId}:${generation}`;
        this.db.prepare(`INSERT INTO task_node_attempts
          (id,run_id,node_id,attempt_number,generation,source_snapshot_id,runtime,outcome,created_at,updated_at)
          VALUES(?,?,?,?,?,?,'dispatching','none',?,?)`)
          .run(attemptId,input.runId,node.id,attemptNumber,generation,run.source_snapshot_id,input.now,input.now);
        this.db.prepare("INSERT INTO task_resource_reservations VALUES(?,?,?,?,?,?,?,NULL)")
          .run(`capacity:${attemptId}`,input.runId,attemptId,"active_attempt",1,input.fencingToken,input.now + node.timeoutMs);
        for (const reservation of reservationsForNode(node)) {
          this.db.prepare("INSERT INTO task_resource_reservations VALUES(?,?,?,?,?,?,?,NULL)")
            .run(`${reservation.kind}:${attemptId}`,input.runId,attemptId,reservation.kind,
              reservation.amount,input.fencingToken,input.now+node.timeoutMs);
        }
        this.db.prepare("INSERT INTO task_scheduler_outbox VALUES(?,?,?,?,?,?,NULL,?)")
          .run(outboxId,input.runId,attemptId,generation,"dispatch",JSON.stringify({ nodeId:node.id,attemptNumber }),input.now);
        admitted.push({ attemptId,nodeId:node.id,generation,outboxId });
      }
      if (admitted.length === 0) return [];
      const next = this.repo.casRun(input.runId,input.expectedRunRevision,{status:"active"},input.now);
      admitted.forEach(item => this.repo.appendEvent(input.runId,next,"attempt_admitted",item.attemptId,
        `admit:${item.attemptId}`,item,input.now));
      return admitted;
    }).immediate();
  }

  acknowledgeDispatch(event: AttemptEvent, sessionRunKey: string): boolean {
    return this.applyEvent(event, ["dispatching"], "running", row => {
      const result = this.db.prepare(`UPDATE task_node_attempts SET runtime='running',session_run_key=?,updated_at=?
        WHERE id=? AND generation=? AND runtime='dispatching'`).run(sessionRunKey,event.at,event.attemptId,event.generation);
      return result.changes === 1;
    }, "dispatch_acknowledged", { sessionRunKey });
  }

  reportProgress(event: AttemptEvent, sequence: number): boolean {
    if (!Number.isInteger(sequence) || sequence < 1) throw new TaskGraphValidationError("invalid progress sequence");
    return this.applyEvent(event,["running","waiting"],null,row => {
      if (!this.hasLiveReservation(String(row.id),event.at)) return false;
      const result = this.db.prepare(`UPDATE task_node_attempts SET progress_seq=?,updated_at=?
        WHERE id=? AND generation=? AND progress_seq<? AND runtime IN ('running','waiting')`)
        .run(sequence,event.at,event.attemptId,event.generation,sequence);
      if (result.changes === 1) this.extendAttemptReservations(row,event.at);
      return result.changes === 1;
    },"attempt_progress",{ sequence });
  }

  /** Renew operational reservations from observed activity by the bound child. */
  renewAttemptActivity(sessionRunKey:string,at:number):boolean {
    return this.db.transaction(()=>{
      const row=this.db.prepare(`SELECT * FROM task_node_attempts
        WHERE session_run_key=? AND runtime IN ('running','waiting')`).get(sessionRunKey) as Row|undefined;
      if (!row || !this.hasLiveReservation(String(row.id),at)) return false;
      const touched=this.db.prepare(`UPDATE task_node_attempts SET updated_at=?
        WHERE id=? AND generation=? AND runtime IN ('running','waiting')`)
        .run(at,row.id,row.generation);
      if (touched.changes!==1) return false;
      this.extendAttemptReservations(row,at);
      return true;
    }).immediate();
  }

  terminal(event: AttemptEvent, outcome: "succeeded"|"failed"|"cancelled"|"lost", witness: unknown): boolean {
    return this.applyEvent(event,["claimed","dispatching","running","waiting"],"terminal",
      row => this.transitionTerminal(row,outcome,witness,event.at),"attempt_terminal",{ outcome, witness });
  }

  /** Package-internal recovery seam; caller owns the immediate transaction. */
  recoverLostAttempt(runId:string,attemptId:string,generation:number,expectedRunRevision:number,at:number):boolean {
    const row=this.db.prepare("SELECT * FROM task_node_attempts WHERE id=? AND run_id=?")
      .get(attemptId,runId) as Row|undefined;
    if (!row || Number(row.generation)!==generation || row.runtime==="terminal") return false;
    const witness={source:"recovery",reason:"reservation_expired"};
    if (!this.transitionTerminal(row,"lost",witness,at)) return false;
    this.db.prepare("UPDATE task_artifacts SET state='rejected' WHERE producer_attempt_id=? AND state='staged'")
      .run(attemptId);
    const revision=this.repo.casRun(runId,expectedRunRevision,{},at);
    this.updateFailureProjection(runId,revision,at);
    new TaskGraphEvidence(this.repo).evaluate(runId,revision,at);
    this.repo.appendEvent(runId,revision,"attempt_recovered_lost",attemptId,
      `recovery-lost:${attemptId}:${generation}`,{},at);
    return true;
  }

  pause(runId: string, expected: number, paused: boolean, at: number): number {
    this.assertRunControl(runId,expected,paused);
    const next = this.repo.casRun(runId,expected,{ paused },at);
    this.repo.appendEvent(runId,next,paused ? "run_paused" : "run_resumed",runId,`${paused ? "pause" : "resume"}:${next}`,{},at);
    return next;
  }

  cancelRun(runId: string, expected: number, at: number): number {
    return this.db.transaction(() => {
      this.assertRunControl(runId,expected);
      const active=this.db.prepare(`SELECT * FROM task_node_attempts WHERE run_id=? AND runtime<>'terminal'`)
        .all(runId) as Row[];
      const verifiers=this.db.prepare(`SELECT * FROM task_verification_requests WHERE run_id=?
        AND status IN ('pending','launching','running')`).all(runId) as Row[];
      const next = this.repo.casRun(runId,expected,{ status:"cancelled",paused:true },at);
      this.db.prepare(`UPDATE task_node_attempts SET runtime='terminal',outcome='cancelled',updated_at=?
        WHERE run_id=? AND runtime<>'terminal'`).run(at,runId);
      this.db.prepare(`UPDATE task_resource_reservations SET released_at=?
        WHERE run_id=? AND released_at IS NULL AND kind NOT LIKE 'budget_%'
          AND attempt_id IN (SELECT id FROM task_node_attempts WHERE run_id=? AND session_run_key IS NULL)`)
        .run(at,runId,runId);
      for (const attempt of active) this.enqueueChildCancellation(attempt,runId,at);
      this.db.prepare(`UPDATE task_verification_requests SET status='failed',result='graph cancelled',updated_at=?
        WHERE run_id=? AND status IN ('pending','launching','running')`).run(at,runId);
      for (const verifier of verifiers) if (verifier.verifier_run_key) {
        this.db.prepare(`INSERT OR IGNORE INTO task_scheduler_outbox
          (id,run_id,attempt_id,generation,kind,payload_json,delivered_at,created_at)
          VALUES(?,?,?,?,?,?,NULL,?)`).run(`cancel:${String(verifier.verifier_attempt_id)}:1`,runId,
            verifier.verifier_attempt_id,1,"cancel_child",
            JSON.stringify({sessionRunKey:verifier.verifier_run_key}),at);
      }
      new TaskGraphEvidence(this.repo).drainTerminalOperations(runId,at);
      this.repo.appendEvent(runId,next,"run_cancelled",runId,`cancel:${next}`,{},at); return next;
    }).immediate();
  }

  private assertRunControl(runId:string,expected:number,paused?:boolean):void {
    const run=this.db.prepare("SELECT * FROM task_graph_runs WHERE id=?").get(runId) as Row|undefined;
    if (!run || run.revision!==expected) {
      throw new TaskGraphConflictError("stale graph-run revision",run??null);
    }
    const legalStatus=["active","quiescent","blocked"].includes(String(run.status));
    const legalPause=paused===undefined || Boolean(run.paused)!==paused;
    if (!legalStatus || !legalPause) {
      throw new TaskGraphConflictError("graph-run control is not legal in current state",run);
    }
  }

  private assertRunAndLease(input: { runId:string; expectedRunRevision:number; ownerId:string; fencingToken:number; now:number }): Row {
    const run = this.db.prepare("SELECT * FROM task_graph_runs WHERE id=?").get(input.runId) as Row | undefined;
    if (!run || run.revision !== input.expectedRunRevision) throw new TaskGraphConflictError("stale graph-run revision",run ?? null);
    const lease = this.db.prepare("SELECT * FROM task_scheduler_leases WHERE run_id=?").get(input.runId) as Row | undefined;
    if (!lease || lease.owner_id !== input.ownerId || lease.fencing_token !== input.fencingToken || Number(lease.expires_at) <= input.now) {
      throw new TaskGraphConflictError("stale scheduler fence");
    }
    return run;
  }

  private reservationBlocker(run:Row,spec:ReturnType<TaskGraphRepository["getRevision"]>,
    node:ReturnType<TaskGraphRepository["getRevision"]>["nodes"][number]): string|null {
    const requested = reservationsForNode(node);
    const tokens = requested.find(item => item.kind === "budget_tokens")?.amount ?? 0;
    const cost = requested.find(item => item.kind === "budget_cost_micros")?.amount ?? 0;
    const used = (kind:string) => Number((this.db.prepare(`SELECT COALESCE(sum(amount),0) amount
      FROM task_resource_reservations WHERE run_id=? AND kind=?`).get(run.id,kind) as Row).amount);
    if (spec.budgetLimits?.tokenLimit != null && used("budget_tokens")+tokens > spec.budgetLimits.tokenLimit) return "budget_tokens";
    if (spec.budgetLimits?.costMicrosLimit != null && used("budget_cost_micros")+cost > spec.budgetLimits.costMicrosLimit) return "budget_cost";
    const requestedOwnership = requested.filter(item => item.kind.startsWith("ownership:"));
    if (!requestedOwnership.length) return null;
    const active = this.db.prepare(`SELECT r.kind FROM task_resource_reservations r
      JOIN task_graph_runs g ON g.id=r.run_id
      JOIN task_graph_revisions revision ON revision.id=g.revision_id
      JOIN task_graph_definitions definition ON definition.id=revision.definition_id
      WHERE definition.workspace_id=? AND r.released_at IS NULL AND r.kind LIKE 'ownership:%'`)
      .all(spec.workspaceId) as Row[];
    return requestedOwnership.every(candidate => active.every(existing =>
      !ownershipConflicts(candidate.kind,String(existing.kind)))) ? null : "ownership_conflict";
  }

  private hasLiveReservation(attemptId:string,at:number):boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM task_resource_reservations
      WHERE attempt_id=? AND released_at IS NULL AND expires_at>? LIMIT 1`).get(attemptId,at));
  }

  private extendAttemptReservations(row:Row,at:number):void {
    const run=this.db.prepare("SELECT revision_id FROM task_graph_runs WHERE id=?")
      .get(row.run_id) as Row;
    const node=this.repo.getRevision(String(run.revision_id)).nodes
      .find(candidate=>candidate.id===row.node_id);
    if (!node) throw new TaskGraphValidationError(`attempt node ${String(row.node_id)} disappeared`);
    const expiresAt=at+node.timeoutMs;
    this.db.prepare(`UPDATE task_resource_reservations SET expires_at=?
      WHERE attempt_id=? AND released_at IS NULL AND expires_at<?`)
      .run(expiresAt,row.id,expiresAt);
  }

  private applyEvent(eventRaw: AttemptEvent, allowed: string[], nextRuntime: string|null,
    mutate: (row:Row)=>boolean, type:string, payload:unknown): boolean {
    const event = attemptEventSchema.parse(eventRaw);
    return this.db.transaction(() => {
      const duplicate = this.db.prepare("SELECT 1 FROM task_scheduler_events WHERE run_id=? AND idempotency_key=?")
        .get(event.runId,event.idempotencyKey);
      if (duplicate) return false;
      const run = this.db.prepare("SELECT * FROM task_graph_runs WHERE id=?").get(event.runId) as Row | undefined;
      const row = this.db.prepare("SELECT * FROM task_node_attempts WHERE id=? AND run_id=?").get(event.attemptId,event.runId) as Row | undefined;
      if (!run || run.revision !== event.expectedRunRevision || !row || row.generation !== event.generation || !allowed.includes(String(row.runtime))) {
        throw new TaskGraphConflictError("stale attempt event",run ?? null);
      }
      if (row.session_run_key && row.session_run_key !== event.actorSessionKey) {
        throw new TaskGraphConflictError("attempt actor session mismatch",run);
      }
      if (!mutate(row)) return false;
      const revision = this.repo.casRun(event.runId,event.expectedRunRevision,{},event.at);
      if (type === "attempt_terminal") this.updateFailureProjection(event.runId,revision,event.at);
      this.repo.appendEvent(event.runId,revision,type,event.attemptId,event.idempotencyKey,{ ...payload as object,nextRuntime },event.at);
      return true;
    }).immediate();
  }

  private updateFailureProjection(runId:string, revision:number, at:number): void {
    const run = this.db.prepare("SELECT revision_id FROM task_graph_runs WHERE id=?").get(runId) as Row;
    const spec = this.repo.getRevision(String(run.revision_id));
    const latest = this.db.prepare(`SELECT * FROM task_node_attempts WHERE run_id=? AND node_id=?
      ORDER BY attempt_number DESC LIMIT 1`);
    let status: "failed"|"blocked"|null = null;
    for (const node of spec.nodes) {
      const attempt = latest.get(runId,node.id) as Row | undefined;
      if (!attempt || attempt.runtime!=="terminal" || attempt.outcome === "succeeded") continue;
      const grants=Number((this.db.prepare(`SELECT remaining FROM task_manual_retry_grants
        WHERE run_id=? AND node_id=?`).get(runId,node.id) as Row|undefined)?.remaining??0);
      const retryable=node.retryPolicy.retryableOutcomes.includes(
        String(attempt.outcome) as "failed"|"lost"|"cancelled");
      if (grants>0 || (retryable && Number(attempt.attempt_number)<node.retryPolicy.maxAttempts)) continue;
      if (node.failurePolicy === "fail_graph") status = "failed";
      else if (node.failurePolicy === "block_for_decision" && status !== "failed") status = "blocked";
      for (const edge of spec.edges.filter(candidate=>candidate.sourceNodeId===node.id && !candidate.optional
        && candidate.satisfactionPolicy!=="all_terminal")) {
        if (edge.failurePolicy==="fail") status="failed";
        else if (edge.failurePolicy==="block" && status!=="failed") status="blocked";
      }
    }
    if (status) {
      this.db.prepare(`UPDATE task_graph_runs SET status=?,updated_at=? WHERE id=? AND revision=?
        AND status IN ('active','quiescent','blocked')`).run(status,at,runId,revision);
      new TaskGraphEvidence(this.repo).drainTerminalOperations(runId,at);
    }
  }

  private transitionTerminal(row:Row,outcome:"succeeded"|"failed"|"cancelled"|"lost",
    witness:unknown,at:number):boolean {
    const run=this.db.prepare("SELECT revision_id FROM task_graph_runs WHERE id=?").get(row.run_id) as Row;
    const node=this.repo.getRevision(String(run.revision_id)).nodes.find(item=>item.id===row.node_id)!;
    const attemptNumber=Number(row.attempt_number);
    const retry=outcome!=="succeeded" && node.retryPolicy.retryableOutcomes.includes(outcome)
      && attemptNumber<node.retryPolicy.maxAttempts;
    const jitter=retry?deterministicJitter(String(row.run_id),String(row.node_id),attemptNumber,
      node.retryPolicy.jitterMs):0;
    const backoff=retry?at+node.retryPolicy.backoffMs+jitter:null;
    const result=this.db.prepare(`UPDATE task_node_attempts SET runtime='terminal',outcome=?,terminal_witness_json=?,
      backoff_until=?,updated_at=? WHERE id=? AND generation=? AND runtime<>'terminal'`)
      .run(outcome,JSON.stringify(witness),backoff,at,row.id,row.generation);
    const cancellationPending=result.changes && (outcome==="cancelled" || outcome==="lost")
      && Boolean(row.session_run_key);
    if (result.changes && !cancellationPending) this.db.prepare(`UPDATE task_resource_reservations SET released_at=?
      WHERE attempt_id=? AND released_at IS NULL AND kind NOT LIKE 'budget_%'`).run(at,row.id);
    if (cancellationPending) this.enqueueChildCancellation(row,String(row.run_id),at);
    return result.changes===1;
  }

  private enqueueChildCancellation(attempt:Row,runId:string,at:number): void {
    if (!attempt.session_run_key) return;
    const generation=Number(attempt.generation);
    this.db.prepare(`INSERT OR IGNORE INTO task_scheduler_outbox
      (id,run_id,attempt_id,generation,kind,payload_json,delivered_at,created_at)
      VALUES(?,?,?,?,?,?,NULL,?)`).run(`cancel:${String(attempt.id)}:${generation}`,runId,attempt.id,generation,
        "cancel_child",JSON.stringify({sessionRunKey:attempt.session_run_key}),at);
  }
}

function reservationsForNode(node:{ownershipRequest:Array<Record<string,unknown>>;budgetRequest:Record<string,unknown>}) {
  const reservations: Array<{kind:string;amount:number}> = [];
  const tokens = positiveInteger(node.budgetRequest["tokens"] ?? node.budgetRequest["maxTokens"]);
  const cost = positiveInteger(node.budgetRequest["costMicros"] ?? node.budgetRequest["maxCostMicros"]);
  if (tokens) reservations.push({kind:"budget_tokens",amount:tokens});
  if (cost) reservations.push({kind:"budget_cost_micros",amount:cost});
  for (const request of node.ownershipRequest) {
    const normalized = String(request["normalizedValue"] ?? request["value"] ?? "").trim();
    if (!normalized) continue;
    const mode = request["mode"] === "read" ? "read" : "write";
    const scope = request["scope"] === "symbol" ? "symbol" : "path";
    reservations.push({kind:`ownership:${mode}:${scope}:${encodeURIComponent(normalized)}`,amount:1});
  }
  return reservations;
}

function positiveInteger(value:unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

function ownershipConflicts(left:string,right:string): boolean {
  const parse = (kind:string) => { const [,mode,scope,...encoded] = kind.split(":");
    return {mode,scope,value:decodeURIComponent(encoded.join(":"))}; };
  const a=parse(left);const b=parse(right);
  if (a.mode === "read" && b.mode === "read") return false;
  if (a.scope !== b.scope) return false;
  if (a.scope === "symbol") return a.value === b.value;
  const normalize=(candidate:string)=>candidate.replaceAll("\\","/").replace(/\/+$/,"/");
  const av=normalize(a.value);const bv=normalize(b.value);
  return av === bv || av.startsWith(bv.endsWith("/")?bv:`${bv}/`)
    || bv.startsWith(av.endsWith("/")?av:`${av}/`);
}

function deterministicJitter(runId:string,nodeId:string,attemptNumber:number,max:number): number {
  if (max<1) return 0;
  const digest=contentHash({runId,nodeId,attemptNumber});
  return Number.parseInt(digest.slice("sha256:".length,"sha256:".length+8),16)%(max+1);
}
