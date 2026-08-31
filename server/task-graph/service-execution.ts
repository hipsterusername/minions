import type { AttemptEvent,GraphSnapshot } from "../../shared/task-graph-contracts.ts";
import type { WorkItemRunSnapshot } from "../../shared/work-item-contracts.ts";
import type { WsEnvelope } from "../../shared/ws-envelope.ts";
import { serverLogger } from "../logging.ts";
import { getWorkItemRun } from "../work-item-repo.ts";
import { runSnapshot } from "../work-item-snapshots.ts";
import { TaskGraphConflictError,TaskGraphValidationError } from "./errors.ts";import { sandboxPolicyForTaskGraphNode } from "./execution-policy.ts";
import type { DispatchRecord } from "./recovery.ts";
import { scopedContextForNode } from "./context-sources.ts";import { affinityResumeForNode,humanGuidanceForNode } from "./dispatch-context.ts";
import { renderTaskGraphNodePrompt } from "./node-prompt.ts";
import { steeringInstructions } from "./service-controls.ts";
import {recoveryDraftForAttempt,resolvedInputArtifacts} from "./staging-recovery.ts";
import { onVerifierSealed,recoverTaskGraphVerifications } from "./service-verification.ts";import {parseVerificationTaskVerdict} from "./verification-verdict.ts";
import type { TaskGraphService } from "./service.ts";type Row=Record<string,unknown>;
const log=serverLogger.child("task-graph-execution");
export async function tickTaskGraphExclusive(service:TaskGraphService,runId:string):Promise<GraphSnapshot> {
  const primaryState=await reconcileBoundPrimary(service,runId);
  if (primaryState!=="live" || isTerminal(service,runId)) return drainTerminalTick(service,runId);
  await reconcileEndedGraphChildren(service,runId);if (isTerminal(service,runId)) return drainTerminalTick(service,runId);
  const now=service.now();const recovered=service.recovery.recover(runId,service.ownerId,now,service.leaseTtlMs);
  if (isTerminal(service,runId)) return drainTerminalTick(service,runId);
  const cancellations=recovered.pending.filter(record=>record.kind==="cancel_child");
  for (const record of cancellations) await deliverCancellation(service,record);
  const recoveredLaunches=recovered.pending.filter(record=>record.kind!=="cancel_child")
    .slice(0,availableDispatchSlots(service));
  await Promise.all(recoveredLaunches.map(record=>dispatch(service,record)));
  if (isTerminal(service,runId)) return drainTerminalTick(service,runId);
  await recoverTaskGraphVerifications(service,runId);if (isTerminal(service,runId)) return drainTerminalTick(service,runId);
  const current=service.repo.snapshot(runId,0);service.evidence.evaluate(runId,current.run.revision,service.now());
  if (isTerminal(service,runId)) return drainTerminalTick(service,runId);
  for (let pass=0;pass<4;pass+=1) {
    const snapshot=service.repo.snapshot(runId,0);if (!["active","quiescent","blocked"].includes(snapshot.run.status) || snapshot.run.paused) break;
    const admissionLimit=availableAdmissionSlots(service);if (admissionLimit<1) break;
    const scheduledAt=service.now();
    const fencingToken=service.scheduler.acquireLease(runId,service.ownerId,scheduledAt,service.leaseTtlMs);
    const admissions=service.scheduler.schedule({runId,expectedRunRevision:snapshot.run.revision,
      ownerId:service.ownerId,fencingToken,now:scheduledAt,admissionLimit});
    if (!admissions.length) break;
    const pending=service.recovery.pendingDispatches(runId);
    const records=admissions.map(admission=>pending.find(candidate=>candidate.id===admission.outboxId))
      .filter((record):record is DispatchRecord=>record!==undefined);
    await Promise.all(records.map(record=>dispatch(service,record)));
  }
  settleGraphStatus(service,runId);const snapshot=service.repo.snapshot(runId);
  service.publishChanged(snapshot,"scheduler_tick");return snapshot;
}
export function availableDispatchSlots(service:TaskGraphService):number {
  if (service.options.availableDispatchSlots) {
    const value=service.options.availableDispatchSlots();return Number.isFinite(value)?Math.max(0,Math.floor(value)):0;
  }
  return service.options.canDispatch && !service.options.canDispatch()?0:Number.MAX_SAFE_INTEGER;
}
export function availableAdmissionSlots(service:TaskGraphService):number {
  const unlaunched=Number((service.options.db.prepare(`SELECT count(*) n FROM task_node_attempts
    WHERE runtime='dispatching' AND session_run_key IS NULL`).get() as Row).n);
  const launchingVerifiers=Number((service.options.db.prepare(`SELECT count(*) n FROM task_verification_requests WHERE status='launching'`).get() as Row).n);
  return Math.max(0,availableDispatchSlots(service)-unlaunched-launchingVerifiers);
}
export async function deliverPendingCancellations(service:TaskGraphService,runId:string):Promise<void> {
  for (const record of service.recovery.pendingDispatches(runId)
    .filter(candidate=>candidate.kind==="cancel_child")) {
    await deliverCancellation(service,record);
  }
}
export async function onTaskGraphChildSealed(service:TaskGraphService,run:WorkItemRunSnapshot):Promise<void> {
  const row=service.options.db.prepare(`SELECT run_id FROM task_node_attempts
    WHERE id=? AND session_run_key=?`).get(run.attemptId,run.runKey) as Row|undefined;
  if (!row) {
    const verifier=service.options.db.prepare(`SELECT run_id FROM task_verification_requests
      WHERE verifier_attempt_id=? AND (verifier_run_key=? OR verifier_run_key IS NULL)`)
      .get(run.attemptId,run.runKey) as Row|undefined;
    if (verifier) await service.enqueue(String(verifier.run_id),()=>onVerifierSealed(service,run));
    return;
  }
  await service.enqueue(String(row.run_id),()=>onGraphChildSealed(service,run));
}
export async function onTaskGraphPrimarySealed(service:TaskGraphService,run:WorkItemRunSnapshot):Promise<void> {
  const graph=service.options.db.prepare(`SELECT id FROM task_graph_runs WHERE work_item_id=?
    AND primary_run_key=? AND status IN ('active','quiescent','blocked')`)
    .get(run.workItemId,run.runKey) as Row|undefined;
  if (!graph) return;const runId=String(graph.id);
  await service.enqueue(runId,async()=>{
    await cancelGraphForPrimarySeal(service,runId,run.endedAt??service.now());
    return service.repo.snapshot(runId);
  });
}
export async function onTaskGraphProgress(service:TaskGraphService,sessionRunKey:string,at:number):Promise<void> {
  const binding=service.options.db.prepare(`SELECT run_id FROM task_node_attempts
    WHERE session_run_key=? AND runtime IN ('running','waiting')`).get(sessionRunKey) as Row|undefined;
  if (!binding) return;
  await service.enqueue(String(binding.run_id),async()=>{
    const row=service.options.db.prepare(`SELECT a.*,g.revision revision FROM task_node_attempts a
      JOIN task_graph_runs g ON g.id=a.run_id WHERE a.session_run_key=?
      AND a.runtime IN ('running','waiting')`).get(sessionRunKey) as Row|undefined;
    if (!row) return service.repo.snapshot(String(binding.run_id));
    service.scheduler.reportProgress({runId:String(row.run_id),attemptId:String(row.id),
      generation:Number(row.generation),actorSessionKey:sessionRunKey,
      idempotencyKey:`progress:${String(row.id)}:${Number(row.progress_seq)+1}`,
      expectedRunRevision:Number(row.revision),at},Number(row.progress_seq)+1);
    const snapshot=service.repo.snapshot(String(row.run_id));
    service.publishChanged(snapshot,"attempt_progress");
    return snapshot;
  });
}
export async function onTaskGraphActivity(service:TaskGraphService,sessionRunKey:string,at:number):Promise<void> {
  const binding=service.options.db.prepare(`SELECT run_id FROM task_node_attempts
    WHERE session_run_key=? AND runtime IN ('running','waiting')`).get(sessionRunKey) as Row|undefined;
  if (!binding) return;
  await service.enqueue(String(binding.run_id),async()=>{
    service.scheduler.renewAttemptActivity(sessionRunKey,at);
    return service.repo.snapshot(String(binding.run_id));
  });
}
export function observeTaskGraphActivity(service:TaskGraphService,envelope:WsEnvelope):boolean {
  if (envelope.type!=="sdk_event" || typeof envelope["sessionKey"]!=="string") return false;
  const sessionRunKey=String(envelope["sessionKey"]);
  void onTaskGraphActivity(service,sessionRunKey,Number(envelope["timestamp"]??service.now())).catch(error=>log.warn("attempt_activity_reconciliation_failed",{sessionRunKey,error}));
  return true;
}
export function activeTaskGraphRunIds(service:TaskGraphService):string[] {
  return (service.options.db.prepare(`SELECT id FROM task_graph_runs
    WHERE status IN ('active','quiescent','blocked') OR (status IN ('completed','failed','cancelled') AND (
      EXISTS (SELECT 1 FROM task_node_attempts WHERE run_id=task_graph_runs.id AND runtime<>'terminal')
      OR EXISTS (SELECT 1 FROM task_verification_requests WHERE run_id=task_graph_runs.id AND status IN ('pending','launching','running'))
      OR EXISTS (SELECT 1 FROM task_artifacts WHERE run_id=task_graph_runs.id AND state='staged')
      OR EXISTS (SELECT 1 FROM task_scheduler_outbox WHERE run_id=task_graph_runs.id AND delivered_at IS NULL)))
    ORDER BY created_at`).all() as Row[]).map(row=>String(row.id));
}
function isTerminal(service:TaskGraphService,runId:string):boolean {
  const row=service.options.db.prepare("SELECT status FROM task_graph_runs WHERE id=?").get(runId) as Row|undefined;
  return Boolean(row && ["completed","failed","cancelled"].includes(String(row.status)));
}
async function drainTerminalTick(service:TaskGraphService,runId:string):Promise<GraphSnapshot> {
  service.evidence.drainTerminalOperations(runId,service.now());await deliverPendingCancellations(service,runId);
  const snapshot=service.repo.snapshot(runId);service.publishChanged(snapshot,"scheduler_tick");return snapshot;
}
async function reconcileBoundPrimary(service:TaskGraphService,runId:string):
Promise<"live"|"terminal"|"cancelled"> {
  const graph=service.options.db.prepare(`SELECT * FROM task_graph_runs WHERE id=?`).get(runId) as Row|undefined;
  if (!graph) throw new TaskGraphValidationError("graph run not found");
  const primary=getWorkItemRun(service.options.db,String(graph.primary_run_key));
  if (!primary || primary.session_key!==graph.primary_run_key || primary.work_item_id!==graph.work_item_id
    || primary.run_kind!=="primary" || primary.ended_at==null) return "live";
  if (!["active","quiescent","blocked"].includes(String(graph.status))) return "terminal";
  await cancelGraphForPrimarySeal(service,runId,Number(primary.ended_at));
  return "cancelled";
}
async function cancelGraphForPrimarySeal(service:TaskGraphService,runId:string,at:number):Promise<void> {
  const current=service.repo.snapshot(runId,0);
  if (!["active","quiescent","blocked"].includes(current.run.status)) return;
  const authority=service.options.db.prepare(`SELECT w.current_run_key,g.primary_run_key
    FROM task_graph_runs g JOIN work_items w ON w.id=g.work_item_id WHERE g.id=?`)
    .get(runId) as Row|undefined;
  if (authority?.current_run_key===authority?.primary_run_key)
    service.scheduler.cancelRun(runId,current.run.revision,at);
  else cancelObsoleteGraph(service,runId,current.run.revision,at);
  await deliverPendingCancellations(service,runId);
  service.publishChanged(service.repo.snapshot(runId),"primary_run_sealed");
}
function cancelObsoleteGraph(service:TaskGraphService,runId:string,expected:number,at:number):void {
  service.options.db.transaction(()=>{
    const run=service.options.db.prepare(`SELECT revision,status FROM task_graph_runs WHERE id=?`).get(runId) as Row|undefined;
    if (!run || Number(run.revision)!==expected || !["active","quiescent","blocked"].includes(String(run.status)))
      throw new TaskGraphConflictError("stale graph-run revision",run??null);
    const changed=service.options.db.prepare(`UPDATE task_graph_runs SET status='cancelled',paused=1,
      revision=revision+1,updated_at=? WHERE id=? AND revision=?
      AND status IN ('active','quiescent','blocked')`).run(at,runId,expected);
    if (changed.changes!==1) throw new TaskGraphConflictError("stale graph-run revision",run);
    service.options.db.prepare(`INSERT OR IGNORE INTO task_scheduler_outbox
      (id,run_id,attempt_id,generation,kind,payload_json,delivered_at,created_at)
      SELECT 'cancel:'||id||':'||generation,run_id,id,generation,'cancel_child',
        json_object('sessionRunKey',session_run_key),NULL,? FROM task_node_attempts
        WHERE run_id=? AND runtime<>'terminal' AND session_run_key IS NOT NULL
      UNION ALL SELECT 'cancel:'||verifier_attempt_id||':1',run_id,verifier_attempt_id,1,'cancel_child',
        json_object('sessionRunKey',verifier_run_key),NULL,? FROM task_verification_requests
        WHERE run_id=? AND status IN ('pending','launching','running') AND verifier_run_key IS NOT NULL`)
      .run(at,runId,at,runId);
    service.options.db.prepare(`UPDATE task_node_attempts SET runtime='terminal',outcome='cancelled',
      updated_at=? WHERE run_id=? AND runtime<>'terminal'`).run(at,runId);
    service.options.db.prepare(`UPDATE task_resource_reservations SET released_at=? WHERE run_id=?
      AND released_at IS NULL AND kind NOT LIKE 'budget_%' AND attempt_id IN
      (SELECT id FROM task_node_attempts WHERE run_id=? AND session_run_key IS NULL)`).run(at,runId,runId);
    service.options.db.prepare(`UPDATE task_verification_requests SET status='failed',
      result='graph cancelled',updated_at=? WHERE run_id=?
      AND status IN ('pending','launching','running')`).run(at,runId);
    service.repo.appendEvent(runId,expected+1,"run_cancelled",runId,`cancel:${expected+1}`,{},at);
  }).immediate();
}
async function dispatch(service:TaskGraphService,record:DispatchRecord):Promise<void> {
  const attempt=service.options.db.prepare("SELECT * FROM task_node_attempts WHERE id=? AND run_id=?")
    .get(record.attemptId,record.runId) as Row|undefined;
  const run=service.options.db.prepare("SELECT * FROM task_graph_runs WHERE id=?")
    .get(record.runId) as Row|undefined;
  if (!attempt || !run || attempt.generation!==record.generation || attempt.runtime!=="dispatching") {
    service.recovery.markDelivered(record.id,record.attemptId,record.generation,service.now());
    return;
  }
  if (attempt.session_run_key) {
    service.recovery.markDelivered(record.id,record.attemptId,record.generation,service.now());
    return;
  }
  const fencingToken=prepareDispatchFence(service,record);
  if (fencingToken==null) return;
  const spec=service.repo.getRevision(String(run.revision_id));
  const node=spec.nodes.find(candidate=>candidate.id===attempt.node_id);
  if (!node) throw new TaskGraphValidationError("dispatch node not found");
  const inputArtifacts=resolvedInputArtifacts(service.options.db,record.runId,spec,node.id);
  const steering=steeringInstructions(service,record.runId,node.id);
  const recoveryDraft=recoveryDraftForAttempt(service.options.db,record.runId,node.id,
    Number(attempt.attempt_number));
  const frozenSkillIds=service.repo.snapshot(record.runId,0).sourceSnapshot.compiledSkills.map(skill=>skill.skillId);
  const sandboxPolicy=(service.options.validateNodePolicy||service.options.resolveHarness)?sandboxPolicyForTaskGraphNode(node,service.options.resolveHarness):undefined;
  const affinity=affinityResumeForNode(service,record.runId,spec,node);
  try {
    const child=await service.options.children.startChildRun({
      workItemId:String(run.work_item_id),parentRunKey:String(run.primary_run_key),taskId:node.id,
      attemptId:record.attemptId,attemptNumber:Number(attempt.attempt_number),
      requestId:`task-graph:${record.attemptId}:${record.generation}`,
      harness:affinity?.harness??node.allowedHarnesses[0],...((affinity?.model??node.model)?{model:affinity?.model??node.model}:{}),
      ...(affinity?{resumeId:affinity.resumeId,invocationKind:"resume_open_run" as const}:{}),executorClass:node.executorClass,
      toolAllowlist:node.allowedTools,skillIds:frozenSkillIds,...(sandboxPolicy?{sandboxPolicy}:{}),
      prompt:renderTaskGraphNodePrompt(spec,node,record.attemptId,Number(attempt.attempt_number),
        String(run.source_snapshot_id),inputArtifacts,steering,
        scopedContextForNode(service.options.db,String(run.source_snapshot_id),node.id),recoveryDraft,humanGuidanceForNode(service,record.runId,node.id)),
    });
    if (!hasDispatchFence(service,record,fencingToken,service.now())) {
      await cancelLateChild(service,record,child.runKey);
      return;
    }
    const current=service.repo.snapshot(record.runId,0).run.revision;
    service.scheduler.acknowledgeDispatch(attemptEvent(service,record,current,child.runKey),child.runKey);
    service.recovery.markDelivered(record.id,record.attemptId,record.generation,service.now());
  } catch (error) {
    if (!hasDispatchFence(service,record,fencingToken,service.now())) return;
    const current=service.repo.snapshot(record.runId,0).run.revision;
    const allocated=service.options.db.prepare(`SELECT session_key,ended_at,run_outcome FROM sessions
      WHERE work_item_id=? AND attempt_id=? ORDER BY started_at DESC LIMIT 1`)
      .get(run.work_item_id,record.attemptId) as Row|undefined;
    if (allocated) {
      service.scheduler.acknowledgeDispatch(attemptEvent(service,record,current,
        String(allocated.session_key)),String(allocated.session_key));
      service.recovery.markDelivered(record.id,record.attemptId,record.generation,service.now());
      if (allocated.ended_at!=null) {
        const durableRun=getWorkItemRun(service.options.db,String(allocated.session_key));
        if (durableRun) await onGraphChildSealed(service,runSnapshot(durableRun),false);
      }
      return;
    }
    service.scheduler.terminal(attemptEvent(service,record,current,`dispatch:${record.attemptId}`),"failed",{
      source:"dispatch",message:error instanceof Error?error.message:"child launch failed",
    });
    service.recovery.markDelivered(record.id,record.attemptId,record.generation,service.now());
    const revised=service.repo.snapshot(record.runId,0);
    service.evidence.evaluate(record.runId,revised.run.revision,service.now());
  }
}
function prepareDispatchFence(service:TaskGraphService,record:DispatchRecord):number|null {
  try {
    const at=service.now();
    const token=service.scheduler.acquireLease(record.runId,service.ownerId,at,service.leaseTtlMs);
    const result=service.options.db.prepare(`UPDATE task_resource_reservations SET fencing_token=?
      WHERE run_id=? AND attempt_id=? AND released_at IS NULL
      AND EXISTS (SELECT 1 FROM task_node_attempts a WHERE a.id=? AND a.runtime='dispatching')`)
      .run(token,record.runId,record.attemptId,record.attemptId);
    return result.changes>0?token:null;
  } catch (error) {
    if (error instanceof TaskGraphConflictError) return null;
    throw error;
  }
}
function hasDispatchFence(service:TaskGraphService,record:DispatchRecord,token:number,at:number):boolean {
  return Boolean(service.options.db.prepare(`SELECT 1 FROM task_scheduler_leases l
    JOIN task_resource_reservations r ON r.run_id=l.run_id AND r.attempt_id=?
    WHERE l.run_id=? AND l.owner_id=? AND l.fencing_token=? AND l.expires_at>?
    AND r.fencing_token=? AND r.released_at IS NULL LIMIT 1`)
    .get(record.attemptId,record.runId,service.ownerId,token,at,token));
}
async function deliverCancellation(service:TaskGraphService,record:DispatchRecord):Promise<void> {
  const payload=record.payload as {sessionRunKey?:unknown};
  const sessionRunKey=typeof payload.sessionRunKey==="string"?payload.sessionRunKey:null;
  if (!sessionRunKey || !service.options.children.cancelChildRun) return;
  try {
    await service.options.children.cancelChildRun(sessionRunKey);
    service.recovery.markDelivered(record.id,record.attemptId,record.generation,service.now());
  } catch (error) {
    log.warn("child_cancellation_deferred",{runId:record.runId,attemptId:record.attemptId,
      sessionRunKey,error});
  }
}
async function cancelLateChild(service:TaskGraphService,record:DispatchRecord,
  sessionRunKey:string):Promise<void> {
  const at=service.now();
  service.options.db.prepare(`INSERT OR IGNORE INTO task_scheduler_outbox
    (id,run_id,attempt_id,generation,kind,payload_json,delivered_at,created_at)
    VALUES(?,?,?,?,?,?,NULL,?)`).run(`cancel:${record.attemptId}:${record.generation}`,record.runId,
      record.attemptId,record.generation,"cancel_child",JSON.stringify({sessionRunKey}),at);
  const cancellation=service.recovery.pendingDispatches(record.runId)
    .find(candidate=>candidate.id===`cancel:${record.attemptId}:${record.generation}`);
  if (cancellation) await deliverCancellation(service,cancellation);
}
async function onGraphChildSealed(service:TaskGraphService,run:WorkItemRunSnapshot,
  scheduleAfter=true):Promise<GraphSnapshot> {
  const row=service.options.db.prepare(`SELECT run_id,node_id,generation,runtime FROM task_node_attempts
    WHERE id=? AND session_run_key=?`).get(run.attemptId,run.runKey) as Row|undefined;
  if (!row) throw new TaskGraphConflictError("graph attempt binding disappeared");
  const runId=String(row.run_id);
  const snapshot=service.repo.snapshot(runId,0);if (["completed","failed","cancelled"].includes(snapshot.run.status)) {
    service.evidence.drainTerminalOperations(runId,service.now());
    return scheduleAfter?service.tickExclusive(runId):service.repo.snapshot(runId);
  }
  let outcome:"succeeded"|"failed"|"cancelled"|"lost";
  if (row.runtime==="terminal") {
    const stored=service.options.db.prepare("SELECT outcome FROM task_node_attempts WHERE id=?")
      .get(run.attemptId) as Row;
    outcome=String(stored.outcome) as typeof outcome;
  } else {
    outcome=run.outcome==="completed"?"succeeded":run.outcome==="stopped"?"cancelled"
      :run.outcome==="interrupted"?"lost":"failed";
  }
  const node=snapshot.revision.nodes.find(candidate=>candidate.id===String(row.node_id));const completionVerdict=node?.completionMode==="verification"?parseVerificationTaskVerdict(run.finalReport,run.outcome):null;if (row.runtime!=="terminal" && completionVerdict?.result!==undefined && completionVerdict.result!=="passed") outcome="failed";
  const staged=service.options.db.prepare(`SELECT * FROM task_artifacts WHERE run_id=?
    AND producer_attempt_id=? AND state='staged' ORDER BY id`).all(runId,run.attemptId) as Row[];
  let stagingFailure:{missingOutputs:string[];stagedOutputs:string[]}|null=null;
  if (row.runtime!=="terminal" && outcome==="succeeded" && node) {
    const stagedNames=new Set(staged.map(artifact=>String(artifact.output_name)));
    const missingOutputs=Object.keys(node.outputSchemas).filter(name=>!stagedNames.has(name));
    if (missingOutputs.length) {
      stagingFailure={missingOutputs,stagedOutputs:[...stagedNames].sort()};
      outcome="failed";
    }
  }
  if (row.runtime!=="terminal") {
    service.scheduler.terminal({runId,attemptId:run.attemptId!,generation:Number(row.generation),
      actorSessionKey:run.runKey,idempotencyKey:`work-item-terminal:${run.runKey}:${run.endedAt??service.now()}`,
      expectedRunRevision:snapshot.run.revision,at:run.endedAt??service.now()},outcome,{
      source:"work_item_run",runKey:run.runKey,
      ...(stagingFailure?{failureKind:"artifact_staging"}:{}),
      finalReport:run.finalReport,...(stagingFailure?{stagingFailure}:{ }),
      ...(completionVerdict?{completionVerdict}:{}),
    });
  }
  if (outcome==="succeeded") {
    for (const artifact of staged) {
      const current=service.repo.snapshot(runId,0).run.revision;
      service.evidence.commitArtifact({runId,attemptId:run.attemptId!,generation:Number(row.generation),
        actorSessionKey:run.runKey,idempotencyKey:`auto-commit:${String(artifact.id)}`,
        expectedRunRevision:current,at:run.endedAt??service.now()},String(artifact.id));
    }
  } else {
    service.options.db.prepare(`UPDATE task_artifacts SET state='rejected' WHERE run_id=?
      AND producer_attempt_id=? AND state='staged'`).run(runId,run.attemptId);
  }
  const revised=service.repo.snapshot(runId,0);service.evidence.evaluate(runId,revised.run.revision,service.now());
  return scheduleAfter?service.tickExclusive(runId):service.repo.snapshot(runId);
}
async function reconcileEndedGraphChildren(service:TaskGraphService,runId:string):Promise<void> {
  const attempts=service.options.db.prepare(`SELECT a.id,a.node_id,a.attempt_number,a.session_run_key,
      g.work_item_id,g.primary_run_key
    FROM task_node_attempts a JOIN task_graph_runs g ON g.id=a.run_id
    WHERE a.run_id=? AND a.session_run_key IS NOT NULL AND (a.runtime<>'terminal' OR EXISTS (
      SELECT 1 FROM task_artifacts artifact WHERE artifact.producer_attempt_id=a.id
      AND artifact.state='staged')) ORDER BY a.created_at,a.id`).all(runId) as Row[];
  for (const attempt of attempts) {
    const durable=getWorkItemRun(service.options.db,String(attempt.session_run_key));if (!durable || durable.ended_at==null || durable.run_kind!=="child"
      || durable.work_item_id!==attempt.work_item_id || durable.parent_run_key!==attempt.primary_run_key
      || durable.task_id!==attempt.node_id || durable.attempt_id!==attempt.id
      || durable.attempt_number!==attempt.attempt_number
      || durable.session_key!==attempt.session_run_key) continue;
    await onGraphChildSealed(service,runSnapshot(durable),false);
    if (isTerminal(service,runId)) break;
  }
}
function attemptEvent(service:TaskGraphService,record:DispatchRecord,expectedRunRevision:number,
  actorSessionKey:string):AttemptEvent {
  return {runId:record.runId,attemptId:record.attemptId,generation:record.generation,actorSessionKey,
    idempotencyKey:`dispatch-ack:${record.attemptId}:${record.generation}`,
    expectedRunRevision,at:service.now()};
}
function settleGraphStatus(service:TaskGraphService,runId:string):void {
  const snapshot=service.repo.snapshot(runId,0);
  if (!["active","quiescent"].includes(snapshot.run.status) || snapshot.run.paused) return;
  const active=service.options.db.prepare(`SELECT 1 FROM task_node_attempts WHERE run_id=? AND runtime<>'terminal' LIMIT 1`).get(runId);
  if (active) return;
  const activeVerification=service.options.db.prepare(`SELECT 1 FROM task_verification_requests WHERE run_id=?
    AND status IN ('pending','launching','running') LIMIT 1`).get(runId);
  if (activeVerification) return;
  const at=service.now();
  const states=service.scheduler.inspect(runId,at,service.availableDispatchSlots()>0);
  const humanBlocked=snapshot.revision.edges.some(edge=>edge.kind==="human_gate"
    && !snapshot.edgeEvaluations.some(row=>row["edge_id"]===edge.id && Boolean(row["satisfied"])));
  const transient=states.some(state=>state.ready || state.reason==="retry_backoff"
    || state.reason==="global_capacity" || state.reason==="graph_capacity"
    || state.reason.startsWith("budget_") || state.reason==="ownership_conflict");
  const status=humanBlocked || !transient?"blocked":"quiescent";
  if (snapshot.run.status===status) return;
  const revision=service.repo.casRun(runId,snapshot.run.revision,{status},at);
  service.repo.appendEvent(runId,revision,status==="blocked"?"run_blocked":"run_quiescent",runId,
    `idle:${status}:${revision}`,{reasons:states.map(state=>({nodeId:state.nodeId,reason:state.reason}))},at);
}
