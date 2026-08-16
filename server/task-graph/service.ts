import type Database from "better-sqlite3";
import type { Bus } from "../bus.ts";
import { serverLogger } from "../logging.ts";
import type { WorkItemRunSnapshot } from "../../shared/work-item-contracts.ts";
import type { ArtifactInput,GraphRevisionInput,GraphSnapshot,
  SourceSnapshot } from "../../shared/task-graph-contracts.ts";
import type { TaskGraphSnapshotView } from "../../shared/task-graph-view-contracts.ts";
import { workItemRunSealedEnvelopeSchema } from "../../shared/ws-envelope.ts";
import { storeTaskGraphArtifact } from "./artifact-store.ts";
import { TaskGraphConflictError,TaskGraphValidationError } from "./errors.ts";
import { TaskGraphEvidence } from "./evidence.ts";
import { contentHash } from "./hash.ts";
import { TaskGraphRecovery } from "./recovery.ts";
import { TaskGraphRepository } from "./repository.ts";
import { TaskGraphScheduler } from "./scheduler.ts";
import { activeTaskGraphRunIds,availableAdmissionSlots,availableDispatchSlots,
  deliverPendingCancellations,onTaskGraphChildSealed,onTaskGraphPrimarySealed,onTaskGraphProgress,
  tickTaskGraphExclusive } from "./service-execution.ts";
import { reconcileTaskGraph,steerTaskGraph,taskGraphArtifact } from "./service-controls.ts";
import { executeTaskGraphCommand } from "./service-idempotency.ts";
import { publishTaskGraphChanged,publishTaskGraphSnapshot } from "./service-projection.ts";
import { requestTaskGraphVerification,waiveTaskGraphVerification } from "./service-verification.ts";
import { validateRevision,type TaskGraphNodePolicyValidator } from "./validation.ts";
import { projectTaskGraphSnapshot } from "./view.ts";

type Row=Record<string,unknown>;
const log=serverLogger.child("task-graph-service");

export interface TaskGraphChildLauncher {
  startChildRun(input:{workItemId:string;parentRunKey:string;taskId:string;attemptId:string;
    attemptNumber:number;prompt:string;requestId:string;harness?:string;
    executorClass?:"mechanical"|"standard"|"reasoning";toolAllowlist?:string[];
    sandboxPolicy?:import("../../shared/workspace-contracts.ts").SandboxPolicy}):Promise<WorkItemRunSnapshot>;
  cancelChildRun?(runKey:string):void|Promise<void>;
}

export interface TaskGraphRuntimeOptions {
  db:Database.Database;
  bus:Bus;
  children:TaskGraphChildLauncher;
  now?:()=>number;
  ownerId?:string;
  leaseTtlMs?:number;
  pollIntervalMs?:number;
  canDispatch?:()=>boolean;
  availableDispatchSlots?:()=>number;
  validateNodePolicy?:TaskGraphNodePolicyValidator;
  resolveHarness?:(name:string)=>import("../harness/types.ts").AgentHarness;
}

/** Canonical facade translating immutable graph topology into child WorkItem runs. */
export class TaskGraphService {
  readonly repo:TaskGraphRepository;
  readonly scheduler:TaskGraphScheduler;
  readonly evidence:TaskGraphEvidence;
  readonly recovery:TaskGraphRecovery;
  readonly now:()=>number;
  readonly ownerId:string;
  readonly leaseTtlMs:number;
  private unsubscribe:(()=>void)|null=null;
  private pollTimer:ReturnType<typeof setInterval>|null=null;
  private readonly queues=new Map<string,Promise<GraphSnapshot>>();

  constructor(readonly options:TaskGraphRuntimeOptions) {
    this.repo=new TaskGraphRepository(options.db);
    this.scheduler=new TaskGraphScheduler(this.repo);
    this.evidence=new TaskGraphEvidence(this.repo);
    this.recovery=new TaskGraphRecovery(this.repo);
    this.now=options.now??Date.now;
    this.ownerId=options.ownerId??`task-graph-server:${process.pid}`;
    this.leaseTtlMs=options.leaseTtlMs??30_000;
  }

  start():void {
    if (this.unsubscribe) return;
    this.unsubscribe=this.options.bus.subscribe(envelope=>{
      const parsed=workItemRunSealedEnvelopeSchema.safeParse(envelope);
      if (parsed.success) {
        if (parsed.data.run.runKind==="primary") {
          void onTaskGraphPrimarySealed(this,parsed.data.run).catch(error=>
            log.warn("primary_seal_reconciliation_failed",{runKey:parsed.data.run.runKey,error}));
        } else if (parsed.data.run.attemptId!=null) {
          void onTaskGraphChildSealed(this,parsed.data.run).catch(error=>
            log.warn("child_seal_reconciliation_failed",{runKey:parsed.data.run.runKey,error}));
        }
        return;
      }
      if (envelope.type!=="minion_status" || typeof envelope["minionSessionKey"]!=="string") return;
      const sessionRunKey=String(envelope["minionSessionKey"]);
      if (envelope["trigger"]==="step") {
        void onTaskGraphProgress(this,sessionRunKey,Number(envelope["timestamp"]??this.now()))
          .catch(error=>log.warn("attempt_progress_reconciliation_failed",{sessionRunKey,error}));
      } else if ((envelope["trigger"]==="done" || envelope["trigger"]==="fail")
        && typeof envelope["message"]==="string") {
        this.options.db.prepare(`UPDATE task_verification_requests SET result=?,updated_at=?
          WHERE verifier_run_key=? AND status='running'`)
          .run(String(envelope["message"]),Number(envelope["timestamp"]??this.now()),sessionRunKey);
      }
    });
    for (const runId of activeTaskGraphRunIds(this)) void this.tick(runId)
      .catch(error=>log.warn("initial_recovery_failed",{runId,error}));
    const interval=this.options.pollIntervalMs??1_000;
    if (interval>0) {
      this.pollTimer=setInterval(()=>{
        for (const runId of activeTaskGraphRunIds(this)) void this.tick(runId)
          .catch(error=>log.warn("scheduler_tick_failed",{runId,error}));
      },interval);
      this.pollTimer.unref?.();
    }
  }

  dispose():void {
    this.unsubscribe?.();
    this.unsubscribe=null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer=null;
  }

  validateRevision(raw:unknown):GraphRevisionInput {
    return validateRevision(raw,this.options.validateNodePolicy);
  }

  createRevision(raw:unknown,at=this.now(),requestId?:string):GraphRevisionInput {
    const revision=this.validateRevision(raw);
    if (!requestId) return this.repo.createRevision(revision,at);
    const result=executeTaskGraphCommand(this,{requestId,workItemId:revision.workItemId,
      command:"create_task_graph_revision",payload:revision,resultKey:revision.revisionId},
    ()=>this.repo.createRevision(revision,at));
    return result.value??this.repo.getRevision(revision.revisionId);
  }

  async startRun(input:{id:string;workItemId:string;primaryRunKey:string;revisionId:string;
    sourceSnapshot:SourceSnapshot;expectedLifecycleRevision:number;requestId?:string;at?:number}):Promise<GraphSnapshot> {
    const at=input.at??this.now();
    const start=()=>this.repo.startRun({...input,at});
    const result=input.requestId?executeTaskGraphCommand(this,{requestId:input.requestId,
      workItemId:input.workItemId,command:"start_task_graph_run",payload:{...input,at:undefined},
      resultKey:input.id},start):{idempotent:false,value:start()};
    const snapshot=result.value??this.repo.snapshot(input.id);
    if (!result.idempotent) publishTaskGraphSnapshot(this,snapshot,"run_started");
    return this.tick(snapshot.run.id);
  }

  snapshot(runId:string):GraphSnapshot { return this.repo.snapshot(runId); }

  assertWorkItem(runId:string,workItemId:string):void {
    const run=this.options.db.prepare("SELECT work_item_id FROM task_graph_runs WHERE id=?")
      .get(runId) as Row|undefined;
    if (!run || run.work_item_id!==workItemId) throw new TaskGraphValidationError("graph run not found");
  }

  viewSnapshot(runId:string):TaskGraphSnapshotView {
    const snapshot=this.repo.snapshot(runId);const at=this.now();
    return projectTaskGraphSnapshot(snapshot,this.scheduler.inspect(runId,at,
      this.availableDispatchSlots()>0),at);
  }

  snapshotForWorkItem(workItemId:string,primaryRunKey?:string|null):GraphSnapshot|null {
    const row=this.options.db.prepare(`SELECT id FROM task_graph_runs WHERE work_item_id=?
      ${primaryRunKey?"AND primary_run_key=?":""} ORDER BY created_at DESC LIMIT 1`)
      .get(workItemId,...(primaryRunKey?[primaryRunKey]:[])) as Row|undefined;
    return row?this.repo.snapshot(String(row.id)):null;
  }

  viewForWorkItem(workItemId:string,primaryRunKey?:string|null):TaskGraphSnapshotView|null {
    const snapshot=this.snapshotForWorkItem(workItemId,primaryRunKey);
    if (!snapshot) return null;
    const at=this.now();
    return projectTaskGraphSnapshot(snapshot,this.scheduler.inspect(snapshot.run.id,at,
      this.availableDispatchSlots()>0),at);
  }

  async pause(runId:string,expectedRunRevision:number,paused:boolean,requestId?:string):Promise<GraphSnapshot> {
    const mutate=()=>this.scheduler.pause(runId,expectedRunRevision,paused,this.now());
    if (requestId) executeTaskGraphCommand(this,{requestId,workItemId:this.repo.snapshot(runId,0).run.workItemId,
      command:paused?"pause_task_graph_run":"resume_task_graph_run",
      payload:{runId,expectedRunRevision},resultKey:runId},mutate);
    else mutate();
    const snapshot=paused?this.repo.snapshot(runId):await this.tick(runId);
    this.publishChanged(snapshot,paused?"run_paused":"run_resumed");
    return snapshot;
  }

  async cancel(runId:string,expectedRunRevision:number,requestId?:string):Promise<GraphSnapshot> {
    const mutate=()=>this.scheduler.cancelRun(runId,expectedRunRevision,this.now());
    if (requestId) executeTaskGraphCommand(this,{requestId,workItemId:this.repo.snapshot(runId,0).run.workItemId,
      command:"cancel_task_graph_run",payload:{runId,expectedRunRevision},resultKey:runId},mutate);
    else mutate();
    await this.deliverPendingCancellations(runId);
    const snapshot=this.repo.snapshot(runId);
    this.publishChanged(snapshot,"run_cancelled");
    return snapshot;
  }

  async retryNode(input:{runId:string;nodeId:string;expectedRunRevision:number;
    currentAttemptId:string;requestId?:string}):Promise<GraphSnapshot> {
    const at=this.now();
    const mutate=()=>this.options.db.transaction(()=>{
      const run=this.options.db.prepare("SELECT * FROM task_graph_runs WHERE id=?")
        .get(input.runId) as Row|undefined;
      if (!run || run.revision!==input.expectedRunRevision
        || !["active","quiescent","blocked","failed"].includes(String(run.status))) {
        throw new TaskGraphConflictError("stale graph-run revision",run??null);
      }
      const attempt=this.options.db.prepare(`SELECT * FROM task_node_attempts WHERE run_id=? AND node_id=?
        ORDER BY attempt_number DESC LIMIT 1`).get(input.runId,input.nodeId) as Row|undefined;
      if (!attempt || attempt.runtime!=="terminal" || attempt.outcome==="succeeded") {
        throw new TaskGraphConflictError("node has no retryable terminal attempt",run);
      }
      if (attempt.id!==input.currentAttemptId) {
        throw new TaskGraphConflictError("stale node attempt",run);
      }
      const spec=this.repo.getRevision(String(run.revision_id));
      const node=spec.nodes.find(candidate=>candidate.id===input.nodeId);
      if (!node) throw new TaskGraphValidationError("graph node not found");
      const needsGrant=Number(attempt.attempt_number)>=node.retryPolicy.maxAttempts
        || !node.retryPolicy.retryableOutcomes.includes(
          String(attempt.outcome) as "failed"|"lost"|"cancelled");
      if (needsGrant) this.options.db.prepare(`INSERT INTO task_manual_retry_grants VALUES(?,?,1,?)
        ON CONFLICT(run_id,node_id) DO UPDATE SET remaining=remaining+1,granted_at=excluded.granted_at`)
        .run(input.runId,input.nodeId,at);
      this.options.db.prepare("UPDATE task_node_attempts SET backoff_until=NULL WHERE id=?").run(attempt.id);
      const revision=this.repo.casRun(input.runId,input.expectedRunRevision,{status:"active"},at);
      this.evidence.evaluate(input.runId,revision,at);
      this.repo.appendEvent(input.runId,revision,"manual_retry_granted",input.nodeId,
        `manual-retry:${input.nodeId}:${revision}`,{attemptId:attempt.id},at);
    }).immediate();
    if (input.requestId) executeTaskGraphCommand(this,{requestId:input.requestId,
      workItemId:this.repo.snapshot(input.runId,0).run.workItemId,command:"retry_task_node",
      payload:input,resultKey:input.runId},mutate);
    else mutate();
    const snapshot=await this.tick(input.runId);
    this.publishChanged(snapshot,"manual_retry_granted");
    return snapshot;
  }

  async cancelAttempt(input:{runId:string;nodeId:string;currentAttemptId:string;
    expectedRunRevision:number;requestId?:string}):Promise<GraphSnapshot> {
    const mutate=()=>{
      const row=this.options.db.prepare(`SELECT * FROM task_node_attempts WHERE id=? AND run_id=? AND node_id=?`)
        .get(input.currentAttemptId,input.runId,input.nodeId) as Row|undefined;
      if (!row || row.runtime==="terminal") {
        throw new TaskGraphConflictError("attempt is no longer active",row??null);
      }
      const actor=row.session_run_key?String(row.session_run_key):`control:${input.currentAttemptId}`;
      return this.scheduler.terminal({runId:input.runId,attemptId:input.currentAttemptId,
        generation:Number(row.generation),actorSessionKey:actor,
        idempotencyKey:`cancel-attempt:${input.currentAttemptId}:${input.expectedRunRevision}`,
        expectedRunRevision:input.expectedRunRevision,at:this.now()},"cancelled",{source:"user_control"});
    };
    if (input.requestId) executeTaskGraphCommand(this,{requestId:input.requestId,
      workItemId:this.repo.snapshot(input.runId,0).run.workItemId,command:"cancel_task_attempt",
      payload:input,resultKey:input.runId},mutate);
    else mutate();
    await this.deliverPendingCancellations(input.runId);
    const revised=this.repo.snapshot(input.runId,0);
    this.evidence.evaluate(input.runId,revised.run.revision,this.now());
    const snapshot=await this.tick(input.runId);
    this.publishChanged(snapshot,"attempt_cancelled");
    return snapshot;
  }

  requestVerification(input:{runId:string;nodeId:string;currentAttemptId:string;
    expectedRunRevision:number;requestId?:string}):Promise<GraphSnapshot> {
    return requestTaskGraphVerification(this,input);
  }

  waiveVerification(input:{runId:string;nodeId:string;currentAttemptId:string;
    expectedRunRevision:number;actor:string;reason:string;requestId?:string}):Promise<GraphSnapshot> {
    return waiveTaskGraphVerification(this,input);
  }

  steer(input:{runId:string;expectedRunRevision:number;requestId:string;instructions:string;
    affectedNodeIds:string[]}):Promise<GraphSnapshot> {
    return steerTaskGraph(this,input);
  }

  artifact(input:{runId:string;artifactId:string}) {
    return taskGraphArtifact(this,input);
  }

  reconcile(input:{runId:string;expectedRunRevision:number;requestId:string;artifactIds:string[];
    verificationIds:string[];sourceDiffHash:string}):Promise<GraphSnapshot> {
    return reconcileTaskGraph(this,input);
  }

  async provideInput(input:{runId:string;nodeId:string;expectedRunRevision:number;
    actor:string;value:string;requestId?:string}):Promise<GraphSnapshot> {
    if (!input.actor.trim() || !input.value.trim()) {
      throw new TaskGraphValidationError("input actor and value are required");
    }
    const at=this.now();
    const mutate=()=>this.options.db.transaction(()=>{
      const run=this.options.db.prepare("SELECT * FROM task_graph_runs WHERE id=?")
        .get(input.runId) as Row|undefined;
      if (!run || run.revision!==input.expectedRunRevision
        || !["active","blocked"].includes(String(run.status))) {
        throw new TaskGraphConflictError("stale graph-run revision",run??null);
      }
      const spec=this.repo.getRevision(String(run.revision_id));
      if (!spec.nodes.some(node=>node.id===input.nodeId)) {
        throw new TaskGraphValidationError("graph node not found");
      }
      const edges=spec.edges.filter(edge=>edge.targetNodeId===input.nodeId && edge.kind==="human_gate");
      if (!edges.length) throw new TaskGraphValidationError("node is not waiting on a human gate");
      const id=this.repo.newId("human_input");
      const revision=this.repo.casRun(input.runId,input.expectedRunRevision,{status:"active"},at);
      this.options.db.prepare("INSERT INTO task_human_inputs VALUES(?,?,?,?,?,?,?,?)")
        .run(id,input.runId,input.nodeId,JSON.stringify(edges.map(edge=>edge.id)),input.actor.trim(),
          contentHash(input.value.trim()),JSON.stringify({value:input.value.trim()}),at);
      const upsert=this.options.db.prepare(`INSERT INTO task_edge_evaluations VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(run_id,edge_id) DO UPDATE SET satisfied=excluded.satisfied,reason=excluded.reason,
        input_fingerprint=excluded.input_fingerprint,run_revision=excluded.run_revision,
        evaluated_at=excluded.evaluated_at`);
      for (const edge of edges) upsert.run(input.runId,edge.id,1,"human_input_provided",
        contentHash({edgeId:edge.id,inputId:id}),revision,at);
      this.repo.appendEvent(input.runId,revision,"human_input_provided",input.nodeId,
        `human-input:${id}`,{inputId:id,edgeIds:edges.map(edge=>edge.id),actor:input.actor.trim()},at);
    }).immediate();
    if (input.requestId) executeTaskGraphCommand(this,{requestId:input.requestId,
      workItemId:this.repo.snapshot(input.runId,0).run.workItemId,command:"provide_task_input",
      payload:input,resultKey:input.runId},mutate);
    else mutate();
    const snapshot=await this.tick(input.runId);
    this.publishChanged(snapshot,"human_input_provided");
    return snapshot;
  }

  attempts(runId:string,nodeId?:string):GraphSnapshot["attempts"] {
    const snapshot=this.repo.snapshot(runId,0);
    return nodeId?snapshot.attempts.filter(row=>row["node_id"]===nodeId):snapshot.attempts;
  }

  agentBinding(sessionRunKey:string):{runId:string;nodeId:string;attemptId:string;
    outputSchemas:Record<string,unknown>;allowedTools:string[];ownershipRequest:GraphRevisionInput["nodes"][number]["ownershipRequest"]}|null {
    const row=this.attemptForSession(sessionRunKey,["dispatching","running","waiting"]);
    if (!row) return null;
    const node=this.repo.getRevision(String(row.revision_id)).nodes
      .find(candidate=>candidate.id===row.node_id);
    return node?{runId:String(row.run_id),nodeId:node.id,attemptId:String(row.id),
      outputSchemas:node.outputSchemas,allowedTools:node.allowedTools,ownershipRequest:node.ownershipRequest}:null;
  }

  stageArtifactForSession(sessionRunKey:string,input:Omit<ArtifactInput,"id">):{
    artifactId:string;staged:boolean
  } {
    const attempt=this.attemptForSession(sessionRunKey,["running","waiting"]);
    if (!attempt) throw new TaskGraphValidationError("session is not a current graph attempt");
    const workItem=this.options.db.prepare(`SELECT w.project_path FROM task_graph_runs g
      JOIN work_items w ON w.id=g.work_item_id WHERE g.id=?`).get(attempt.run_id) as Row|undefined;
    if (!workItem) throw new TaskGraphValidationError("graph workspace authority is unavailable");
    const stored=storeTaskGraphArtifact(String(workItem.project_path),input);
    const artifactId=`artifact_${contentHash({attemptId:attempt.id,outputName:stored.outputName,
      contentHash:stored.contentHash}).slice("sha256:".length)}`;
    const staged=this.evidence.stageArtifact({runId:String(attempt.run_id),attemptId:String(attempt.id),
      generation:Number(attempt.generation),actorSessionKey:sessionRunKey,idempotencyKey:`stage:${artifactId}`,
      expectedRunRevision:Number(attempt.revision),at:this.now()},{id:artifactId,...stored});
    const snapshot=this.repo.snapshot(String(attempt.run_id));
    this.publishChanged(snapshot,"artifact_staged");
    return {artifactId,staged};
  }

  async tick(runId:string):Promise<GraphSnapshot> {
    return this.enqueue(runId,()=>this.tickExclusive(runId));
  }

  /** Package-internal serialized execution seam used by recovery helpers. */
  async enqueue(runId:string,operation:()=>Promise<GraphSnapshot>):Promise<GraphSnapshot> {
    const prior=this.queues.get(runId)??Promise.resolve(this.repo.snapshot(runId));
    const next=prior.catch(()=>this.repo.snapshot(runId)).then(operation);
    this.queues.set(runId,next);
    try { return await next; }
    finally { if (this.queues.get(runId)===next) this.queues.delete(runId); }
  }

  tickExclusive(runId:string):Promise<GraphSnapshot> { return tickTaskGraphExclusive(this,runId); }
  availableDispatchSlots():number { return availableDispatchSlots(this); }
  availableAdmissionSlots():number { return availableAdmissionSlots(this); }
  deliverPendingCancellations(runId:string):Promise<void> {
    return deliverPendingCancellations(this,runId);
  }
  publishChanged(snapshot:GraphSnapshot,cause:string):void {
    publishTaskGraphChanged(this,snapshot,cause);
  }

  private attemptForSession(sessionRunKey:string,runtimes:string[]):Row|undefined {
    const placeholders=runtimes.map(()=>"?").join(",");
    const acknowledged=this.options.db.prepare(`SELECT a.*,g.revision_id,g.revision
      FROM task_node_attempts a JOIN task_graph_runs g ON g.id=a.run_id
      WHERE a.session_run_key=? AND a.runtime IN (${placeholders})`)
      .get(sessionRunKey,...runtimes) as Row|undefined;
    if (acknowledged) return acknowledged;
    return this.options.db.prepare(`SELECT a.*,g.revision_id,g.revision
      FROM sessions s JOIN task_node_attempts a ON a.id=s.attempt_id
      JOIN task_graph_runs g ON g.id=a.run_id WHERE s.session_key=?
      AND s.work_item_id=g.work_item_id AND s.parent_run_key=g.primary_run_key
      AND (a.session_run_key IS NULL OR a.session_run_key=s.session_key)
      AND a.runtime IN (${placeholders})`).get(sessionRunKey,...runtimes) as Row|undefined;
  }
}
