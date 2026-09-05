import { scopedContextForNode } from "./context-sources.ts";
import { renderScopedContext, verificationCompletionGuidance, type ScopedContext } from "./node-prompt.ts";
import type { WorkItemRunSnapshot } from "../../shared/work-item-contracts.ts";
import type { GraphRevisionInput,GraphSnapshot } from "../../shared/task-graph-contracts.ts";
import { serverLogger } from "../logging.ts";
import { getWorkItemRun } from "../work-item-repo.ts";
import { runSnapshot } from "../work-item-snapshots.ts";
import { TaskGraphConflictError,TaskGraphValidationError } from "./errors.ts";
import { safeArtifactReference } from "./artifact-access.ts";
import { contentHash } from "./hash.ts";
import { executeTaskGraphCommand } from "./service-idempotency.ts";
import type { TaskGraphService } from "./service.ts";
import {applyVerificationDisposition,MAX_AUTOMATIC_INCONCLUSIVE_VERIFICATIONS} from "./verification-disposition.ts";
import {parseVerificationTaskVerdict} from "./verification-verdict.ts";
import {effectiveAttemptSuccessSql,isEffectiveAttemptSuccess} from "./adjudication.ts";

type Row=Record<string,unknown>;
type VerificationSubjectInput={runId:string;nodeId:string;currentAttemptId:string;
  expectedRunRevision:number;requestId?:string};
type VerificationTransition={requestId:string;at:number;type:string;
  update:(request:Row)=>{changes:number}};
const log=serverLogger.child("task-graph-verification");
const STALE_VERIFIER_LAUNCH_MS=60_000;

export async function requestTaskGraphVerification(
  service:TaskGraphService,
  input:VerificationSubjectInput,
):Promise<GraphSnapshot> {
  const at=service.now();
  const allocate=()=>service.options.db.transaction(()=>{
    const {run,node,attempt,artifacts}=verificationSubject(service,input);
    const active=service.options.db.prepare(`SELECT 1 FROM task_verification_requests
      WHERE run_id=? AND node_id=? AND status IN ('pending','launching','running')`)
      .get(input.runId,input.nodeId);
    if (active) throw new TaskGraphConflictError("verification is already active",run);
    if (!node.verificationRequired) throw new TaskGraphValidationError("node does not require verification");
    if (!artifacts.length) throw new TaskGraphValidationError("verification requires committed artifacts");
    const requestId=service.repo.newId("verification_request");
    const verifierAttemptId=service.repo.newId("verifier");
    service.options.db.prepare(`INSERT INTO task_verification_requests
      (id,run_id,node_id,producer_attempt_id,verifier_attempt_id,status,created_at,updated_at)
      VALUES(?,?,?,?,?,'pending',?,?)`)
      .run(requestId,input.runId,input.nodeId,attempt.id,verifierAttemptId,at,at);
    const revision=service.repo.casRun(input.runId,input.expectedRunRevision,{status:"active"},at);
    service.repo.appendEvent(input.runId,revision,"verification_requested",requestId,
      `verification-request:${requestId}`,{nodeId:input.nodeId,producerAttemptId:attempt.id},at);
    return requestId;
  }).immediate();
  const command=input.requestId?executeTaskGraphCommand(service,{requestId:input.requestId,
    workItemId:service.repo.snapshot(input.runId,0).run.workItemId,command:"request_task_verification",
    payload:input,resultKey:input.runId},allocate):{idempotent:false,value:allocate()};
  if (command.value) service.publishChanged(service.repo.snapshot(input.runId),"verification_requested");
  if (command.value) await launchVerificationRequest(service,command.value);
  const snapshot=service.repo.snapshot(input.runId);
  return snapshot;
}

export async function waiveTaskGraphVerification(
  service:TaskGraphService,
  input:VerificationSubjectInput&{actor:string;reason:string},
):Promise<GraphSnapshot> {
  if (!input.actor.trim() || !input.reason.trim()) {
    throw new TaskGraphValidationError("waiver actor and reason are required");
  }
  const at=service.now();
  const mutate=()=>{
    const {node,attempt,artifacts}=verificationSubject(service,input);
    if (!node.verificationRequired) throw new TaskGraphValidationError("node does not require verification");
    if (!artifacts.length) throw new TaskGraphValidationError("waiver requires committed artifacts");
    return service.evidence.recordVerification({id:service.repo.newId("verification"),runId:input.runId,
      nodeId:input.nodeId,producerAttemptId:String(attempt.id),
      verifierAttemptId:`human:${input.actor.trim()}`,sourceSnapshotId:String(attempt.source_snapshot_id),
      artifactHashes:artifacts.map(row=>String(row.content_hash)),
      acceptanceCriteriaVersion:contentHash(node.acceptanceCriteria),method:"human",
      evidenceRefs:[`waiver:${input.reason.trim()}`],result:"waived",confidence:null,at},
    input.expectedRunRevision,`verification-waiver:${input.nodeId}:${input.expectedRunRevision}`);
  };
  if (input.requestId) executeTaskGraphCommand(service,{requestId:input.requestId,
    workItemId:service.repo.snapshot(input.runId,0).run.workItemId,command:"waive_task_verification",
    payload:input,resultKey:input.runId},mutate);
  else mutate();
  const snapshot=service.repo.snapshot(input.runId);
  service.publishChanged(snapshot,"verification_waived");
  return snapshot;
}

export async function onVerifierSealed(
  service:TaskGraphService,
  run:WorkItemRunSnapshot,
):Promise<GraphSnapshot> {
  return service.tickExclusive(completeVerifier(service,run));
}

export async function recoverTaskGraphVerifications(
  service:TaskGraphService,
  runId:string,
):Promise<void> {
  recoverLaunchingVerificationRequests(service,runId);
  const now=service.now();
  const pending=service.options.db.prepare(`SELECT id FROM task_verification_requests
    WHERE run_id=? AND status='pending' AND (next_retry_at IS NULL OR next_retry_at<=?)
    ORDER BY created_at,id`).all(runId,now) as Row[];
  for (const request of pending) await launchVerificationRequest(service,String(request.id));

  const terminal=service.options.db.prepare(`SELECT r.verifier_run_key FROM task_verification_requests r
    JOIN sessions s ON s.session_key=r.verifier_run_key
    WHERE r.run_id=? AND r.status='running' AND s.ended_at IS NOT NULL
    ORDER BY r.created_at,r.id`).all(runId) as Row[];
  for (const row of terminal) {
    const workItemRun=getWorkItemRun(service.options.db,String(row.verifier_run_key));
    if (workItemRun) completeVerifier(service,runSnapshot(workItemRun));
  }
  await recoverMissingVerificationRequests(service,runId);
}

function recoverLaunchingVerificationRequests(service:TaskGraphService,runId:string):void {
  const now=service.now();
  const requests=service.options.db.prepare(`SELECT * FROM task_verification_requests
    WHERE run_id=? AND status='launching' ORDER BY created_at,id`).all(runId) as Row[];
  for (const request of requests) {
    const allocated=service.options.db.prepare(`SELECT s.session_key,s.ended_at FROM sessions s
      JOIN task_graph_runs g ON g.id=?
      JOIN task_node_attempts p ON p.id=? AND p.run_id=g.id AND p.node_id=?
      WHERE s.work_item_id=g.work_item_id AND s.run_kind='child'
      AND s.parent_run_key=g.primary_run_key AND s.task_id=? || ':verification'
      AND s.attempt_id=? AND s.start_idempotency_key=?
      AND p.runtime='terminal' AND ${effectiveAttemptSuccessSql("p")}
      AND p.source_snapshot_id=g.source_snapshot_id
      AND NOT EXISTS (SELECT 1 FROM task_node_invalidations i WHERE i.run_id=p.run_id
        AND i.node_id=p.node_id AND i.invalidated_attempt_id=p.id)
      AND NOT EXISTS (SELECT 1 FROM task_node_attempts newer WHERE newer.run_id=p.run_id
        AND newer.node_id=p.node_id AND newer.attempt_number>p.attempt_number)
      AND EXISTS (SELECT 1 FROM task_artifacts a WHERE a.run_id=p.run_id
        AND a.producer_attempt_id=p.id AND a.source_snapshot_id=g.source_snapshot_id
        AND a.state='committed')
      ORDER BY s.started_at DESC LIMIT 1`).get(request.run_id,request.producer_attempt_id,
        request.node_id,request.node_id,request.verifier_attempt_id,
        `task-graph-verifier:${String(request.verifier_attempt_id)}`) as Row|undefined;
    if (allocated) {
      transitionVerificationRequest(service,{requestId:String(request.id),at:now,
        type:"verification_launch_rebound",update:()=>service.options.db.prepare(`UPDATE task_verification_requests
          SET verifier_run_key=?,status='running',launch_attempts=launch_attempts+1,
          next_retry_at=NULL,result=NULL,updated_at=?
          WHERE id=? AND status='launching' AND verifier_run_key IS NULL`)
          .run(allocated.session_key,now,request.id)});
      continue;
    }
    const attempts=Number(request.launch_attempts??0)+1;
    const retryAt=now+verificationLaunchBackoff(attempts);
    transitionVerificationRequest(service,{requestId:String(request.id),at:now,
      type:"verification_launch_reclaimed",update:()=>service.options.db.prepare(`UPDATE task_verification_requests
        SET status='pending',launch_attempts=?,next_retry_at=?,result=?,updated_at=?
        WHERE id=? AND status='launching' AND updated_at<=?
        AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.attempt_id=task_verification_requests.verifier_attempt_id)
        AND EXISTS (SELECT 1 FROM task_graph_runs g JOIN task_node_attempts p
          ON p.id=task_verification_requests.producer_attempt_id AND p.run_id=g.id
          AND p.node_id=task_verification_requests.node_id
          WHERE g.id=task_verification_requests.run_id AND p.runtime='terminal'
          AND ${effectiveAttemptSuccessSql("p")}
          AND p.source_snapshot_id=g.source_snapshot_id
          AND NOT EXISTS (SELECT 1 FROM task_node_invalidations i WHERE i.run_id=p.run_id
            AND i.node_id=p.node_id AND i.invalidated_attempt_id=p.id)
          AND NOT EXISTS (SELECT 1 FROM task_node_attempts newer WHERE newer.run_id=p.run_id
            AND newer.node_id=p.node_id AND newer.attempt_number>p.attempt_number)
          AND EXISTS (SELECT 1 FROM task_artifacts a WHERE a.run_id=p.run_id
            AND a.producer_attempt_id=p.id AND a.source_snapshot_id=g.source_snapshot_id
            AND a.state='committed'))`)
        .run(attempts,retryAt,"stale verifier launch claim recovered",now,request.id,
          now-STALE_VERIFIER_LAUNCH_MS)});
  }
}
async function recoverMissingVerificationRequests(service:TaskGraphService,runId:string):Promise<void> {
  const snapshot=service.repo.snapshot(runId,0);
  if (!["active","quiescent","blocked"].includes(snapshot.run.status)) return;
  for (const node of snapshot.revision.nodes.filter(candidate=>candidate.verificationRequired)) {
    const attempt=service.options.db.prepare(`SELECT * FROM task_node_attempts WHERE run_id=? AND node_id=?
      ORDER BY attempt_number DESC LIMIT 1`).get(runId,node.id) as Row|undefined;
    if (!attempt || attempt.runtime!=="terminal"
      || !isEffectiveAttemptSuccess(service.options.db,attempt)) continue;
    const invalidated=service.options.db.prepare(`SELECT 1 FROM task_node_invalidations
      WHERE run_id=? AND node_id=? AND invalidated_attempt_id=? LIMIT 1`)
      .get(runId,node.id,attempt.id);
    const artifacts=Number((service.options.db.prepare(`SELECT count(*) n FROM task_artifacts
      WHERE run_id=? AND producer_attempt_id=? AND state='committed'`)
      .get(runId,attempt.id) as Row).n);
    const decisive=service.options.db.prepare(`SELECT result FROM task_verifications WHERE run_id=? AND
      producer_attempt_id=? AND result IN ('passed','failed','waived') ORDER BY created_at DESC,id DESC LIMIT 1`)
      .get(runId,attempt.id) as Row|undefined;
    const latestRequest=service.options.db.prepare(`SELECT * FROM task_verification_requests WHERE run_id=? AND
      producer_attempt_id=? ORDER BY created_at DESC,id DESC LIMIT 1`).get(runId,attempt.id) as Row|undefined;
    const activeOrFailed=service.options.db.prepare(`SELECT 1 FROM task_verification_requests WHERE run_id=? AND
      producer_attempt_id=? AND status IN ('pending','launching','running','failed') LIMIT 1`).get(runId,attempt.id);
    const inconclusive=Number((service.options.db.prepare(`SELECT count(*) n FROM task_verifications WHERE run_id=?
      AND producer_attempt_id=? AND result='inconclusive'`).get(runId,attempt.id) as Row).n);
    if (invalidated || artifacts<1) continue;
    const strandedResult=decisive?.result==="failed"?"failed"
      : inconclusive>=MAX_AUTOMATIC_INCONCLUSIVE_VERIFICATIONS?"inconclusive":null;
    if (strandedResult && latestRequest) {applyVerificationDisposition(service,latestRequest,node,
      strandedResult,service.now());return;}
    if (decisive || activeOrFailed) continue;
    const revision=service.repo.snapshot(runId,0).run.revision;
    await requestTaskGraphVerification(service,{runId,nodeId:node.id,
      currentAttemptId:String(attempt.id),expectedRunRevision:revision});
  }
}
function completeVerifier(service:TaskGraphService,run:WorkItemRunSnapshot):string {
  if (!run.attemptId) throw new TaskGraphValidationError("verifier attempt identity missing");
  const request=service.options.db.prepare(`SELECT * FROM task_verification_requests
    WHERE verifier_attempt_id=? AND (verifier_run_key=? OR verifier_run_key IS NULL)`)
    .get(run.attemptId,run.runKey) as Row|undefined;
  if (!request || !["launching","running"].includes(String(request.status))) {
    if (!request) throw new TaskGraphConflictError("verification request binding disappeared");
    return String(request.run_id);
  }
  const graph=service.repo.snapshot(String(request.run_id),0);
  const artifacts=service.options.db.prepare(`SELECT content_hash FROM task_artifacts
    WHERE run_id=? AND producer_attempt_id=? AND state='committed' ORDER BY content_hash`)
    .all(request.run_id,request.producer_attempt_id) as Row[];
  const node=graph.revision.nodes.find(candidate=>candidate.id===request.node_id);
  if (!node || !artifacts.length) {
    const at=service.now();
    transitionVerificationRequest(service,{requestId:String(request.id),at,
      type:"verification_subject_unavailable",update:()=>service.options.db.prepare(`UPDATE task_verification_requests
        SET status='failed',result=?,updated_at=? WHERE id=? AND status IN ('launching','running')`)
        .run("verification subject became unavailable",at,request.id)});
    return String(request.run_id);
  }
  const verdict=parseVerificationTaskVerdict(
    run.finalReport??(request.result?String(request.result):null),run.outcome,
  );
  service.evidence.recordVerification({id:service.repo.newId("verification"),runId:String(request.run_id),
    nodeId:String(request.node_id),producerAttemptId:String(request.producer_attempt_id),
    verifierAttemptId:String(request.verifier_attempt_id),sourceSnapshotId:graph.run.sourceSnapshotId,
    artifactHashes:artifacts.map(row=>String(row.content_hash)),
    acceptanceCriteriaVersion:contentHash(node.acceptanceCriteria),method:"independent_agent",
    evidenceRefs:[`work-item-run:${run.runKey}`],result:verdict.result,confidence:verdict.confidence,
    ...(verdict.summary ? {summary:verdict.summary} : {}),
    at:run.endedAt??service.now()},graph.run.revision,
  `verification-result:${String(request.id)}:${run.runKey}`);
  service.options.db.prepare(`UPDATE task_verification_requests SET verifier_run_key=?,status='completed',
    result=?,updated_at=? WHERE id=?`).run(run.runKey,verdict.result,service.now(),request.id);
  const revised=service.repo.snapshot(String(request.run_id),0);
  service.evidence.evaluate(String(request.run_id),revised.run.revision,service.now());
  const inconclusive=verdict.result==="inconclusive" ? Number((service.options.db.prepare(`SELECT count(*) n
    FROM task_verifications WHERE run_id=? AND producer_attempt_id=? AND result='inconclusive'`)
    .get(request.run_id,request.producer_attempt_id) as Row).n) : 0;
  const disposition=verdict.result==="failed"?"failed"
    : inconclusive>=MAX_AUTOMATIC_INCONCLUSIVE_VERIFICATIONS?"inconclusive":null;
  if (disposition) applyVerificationDisposition(service,request,node,disposition,
    run.endedAt??service.now());
  return String(request.run_id);
}

async function launchVerificationRequest(service:TaskGraphService,requestId:string):Promise<void> {
  const candidate=service.options.db.prepare(`SELECT * FROM task_verification_requests
    WHERE id=? AND status='pending'`).get(requestId) as Row|undefined;
  if (!candidate || service.availableAdmissionSlots()<1) return;
  const claimedAt=service.now();
  const claimed=transitionVerificationRequest(service,{requestId,at:claimedAt,
    type:"verification_launch_claimed",update:()=>service.options.db.prepare(`UPDATE task_verification_requests
      SET status='launching',updated_at=? WHERE id=? AND status='pending'`).run(claimedAt,requestId)});
  const request=claimed?candidate:undefined;
  if (!request) return;
  const graph=service.repo.snapshot(String(request.run_id),0);
  const node=graph.revision.nodes.find(candidate=>candidate.id===request.node_id);
  const producer=service.options.db.prepare("SELECT * FROM task_node_attempts WHERE id=? AND run_id=?")
    .get(request.producer_attempt_id,request.run_id) as Row|undefined;
  const artifacts=service.options.db.prepare(`SELECT * FROM task_artifacts WHERE run_id=?
    AND producer_attempt_id=? AND state='committed' ORDER BY content_hash`)
    .all(request.run_id,request.producer_attempt_id) as Row[];
  if (!node || !producer || !artifacts.length) {
    const at=service.now();
    transitionVerificationRequest(service,{requestId,at,type:"verification_subject_unavailable",
      update:()=>service.options.db.prepare(`UPDATE task_verification_requests SET status='failed',result=?,updated_at=?
        WHERE id=? AND status='launching'`).run("verification subject became unavailable",at,requestId)});
    return;
  }
  const ordinal=Number((service.options.db.prepare(`SELECT count(*) n FROM task_verification_requests
    WHERE run_id=? AND node_id=? AND created_at<=?`)
    .get(request.run_id,request.node_id,request.created_at) as Row).n);
  try {
    const child=await service.options.children.startChildRun({
      workItemId:graph.run.workItemId,parentRunKey:graph.run.primaryRunKey,
      taskId:`${String(request.node_id)}:verification`,attemptId:String(request.verifier_attempt_id),
      attemptNumber:Math.max(1,ordinal),requestId:`task-graph-verifier:${String(request.verifier_attempt_id)}`,
      harness:node.allowedHarnesses[0],executorClass:"reasoning",
      toolAllowlist:[],
      prompt:renderVerificationPrompt(node,producer,artifacts,graph.run.sourceSnapshotId,graph.revision,
        scopedContextForNode(service.options.db,graph.run.sourceSnapshotId,node.id)),
    });
    const at=service.now();
    const acknowledged=transitionVerificationRequest(service,{requestId,at,
      type:"verification_launch_acknowledged",update:()=>service.options.db.prepare(`UPDATE task_verification_requests
        SET verifier_run_key=?,status='running',launch_attempts=launch_attempts+1,
        next_retry_at=NULL,result=NULL,updated_at=? WHERE id=? AND status='launching'`)
        .run(child.runKey,at,requestId)});
    if (!acknowledged) await cancelVerificationChild(service,request,child.runKey);
  } catch (error) {
    const allocated=service.options.db.prepare(`SELECT session_key,ended_at FROM sessions
      WHERE work_item_id=? AND attempt_id=? ORDER BY started_at DESC LIMIT 1`)
      .get(graph.run.workItemId,request.verifier_attempt_id) as Row|undefined;
    if (allocated) {
      const at=service.now();
      const acknowledged=transitionVerificationRequest(service,{requestId,at,
        type:"verification_launch_rebound",update:()=>service.options.db.prepare(`UPDATE task_verification_requests
          SET verifier_run_key=?,status='running',launch_attempts=launch_attempts+1,
          next_retry_at=NULL,result=?,updated_at=? WHERE id=? AND status='launching'`)
          .run(String(allocated.session_key),error instanceof Error?error.message:
            "verifier launch acknowledgement failed",at,requestId)});
      if (!acknowledged) {
        await cancelVerificationChild(service,request,String(allocated.session_key));
      }
      return;
    }
    const attempts=Number(request.launch_attempts??0)+1;
    const at=service.now();const retryAt=at+verificationLaunchBackoff(attempts);
    transitionVerificationRequest(service,{requestId,at,type:"verification_launch_deferred",
      update:()=>service.options.db.prepare(`UPDATE task_verification_requests SET status='pending',launch_attempts=?,
        next_retry_at=?,result=?,updated_at=? WHERE id=? AND status='launching'`).run(attempts,retryAt,
      error instanceof Error?error.message:"verifier launch failed",at,requestId)});
    log.warn("verification_launch_deferred",{requestId,attempts,retryAt,error});
  }
}
function transitionVerificationRequest(service:TaskGraphService,input:VerificationTransition):boolean {
  const changed=service.options.db.transaction(()=>{
    const request=service.options.db.prepare(`SELECT run_id,node_id FROM task_verification_requests WHERE id=?`)
      .get(input.requestId) as Row|undefined;
    if (!request || input.update(request).changes!==1) return false;
    const run=service.options.db.prepare(`SELECT revision FROM task_graph_runs WHERE id=?`)
      .get(request.run_id) as Row|undefined;
    if (!run) throw new TaskGraphValidationError("verification graph run disappeared");
    const revision=service.repo.casRun(String(request.run_id),Number(run.revision),{},input.at);
    service.repo.appendEvent(String(request.run_id),revision,input.type,input.requestId,
      `verification-transition:${input.requestId}:${revision}`,{nodeId:request.node_id},input.at);
    return true;
  }).immediate();
  if (changed) {
    const request=service.options.db.prepare(`SELECT run_id FROM task_verification_requests WHERE id=?`)
      .get(input.requestId) as Row;
    service.publishChanged(service.repo.snapshot(String(request.run_id)),input.type);
  }
  return changed;
}

function verificationLaunchBackoff(attempts:number):number {
  return Math.min(60_000,1_000*(2**Math.min(attempts-1,6)));
}

async function cancelVerificationChild(service:TaskGraphService,request:Row,
  sessionRunKey:string):Promise<void> {
  const at=service.now();
  service.options.db.prepare(`INSERT OR IGNORE INTO task_scheduler_outbox
    (id,run_id,attempt_id,generation,kind,payload_json,delivered_at,created_at)
    VALUES(?,?,?,?,?,?,NULL,?)`).run(`cancel:${String(request.verifier_attempt_id)}:1`,request.run_id,
      request.verifier_attempt_id,1,"cancel_child",JSON.stringify({sessionRunKey}),at);
  await service.deliverPendingCancellations(String(request.run_id));
}

function verificationSubject(service:TaskGraphService,input:VerificationSubjectInput):{
  run:Row;node:GraphRevisionInput["nodes"][number];attempt:Row;artifacts:Row[]
} {
  const run=service.options.db.prepare("SELECT * FROM task_graph_runs WHERE id=?").get(input.runId) as Row|undefined;
  if (!run || run.revision!==input.expectedRunRevision
    || !["active","quiescent","blocked"].includes(String(run.status))) {
    throw new TaskGraphConflictError("stale graph-run revision",run??null);
  }
  const node=service.repo.getRevision(String(run.revision_id)).nodes
    .find(candidate=>candidate.id===input.nodeId);
  const attempt=service.options.db.prepare(`SELECT * FROM task_node_attempts WHERE run_id=? AND node_id=?
    ORDER BY attempt_number DESC LIMIT 1`).get(input.runId,input.nodeId) as Row|undefined;
  if (!node || !attempt || attempt.runtime!=="terminal"
    || !isEffectiveAttemptSuccess(service.options.db,attempt)) {
    throw new TaskGraphConflictError("node has no successful producer attempt",run);
  }
  if (attempt.id!==input.currentAttemptId) {
    throw new TaskGraphConflictError("stale node attempt",run);
  }
  const artifacts=service.options.db.prepare(`SELECT * FROM task_artifacts WHERE run_id=?
    AND producer_attempt_id=? AND state='committed' ORDER BY content_hash`)
    .all(input.runId,attempt.id) as Row[];
  return {run,node,attempt,artifacts};
}

function renderVerificationPrompt(node:GraphRevisionInput["nodes"][number],producer:Row,
  artifacts:Row[],sourceSnapshotId:string,revision:GraphRevisionInput,context:ScopedContext[]):string {
  return [
    "Independently verify an immutable task-graph output. Do not trust or reproduce the producer's reasoning.",
    `Node: ${node.title} (${node.id})`,`Producer attempt: ${String(producer.id)}`,
    `Source snapshot: ${sourceSnapshotId}`,
    `Mission: ${revision.objective}\nObjective: ${node.objective}`,
    `Relevant constraints: ${JSON.stringify([...revision.constraints,...node.constraints])}\nNon-goals: ${JSON.stringify(revision.nonGoals)}`,
    "Verification is read-only. Producer write ownership does not authorize verifier writes.",
    renderScopedContext(context.filter(source=>!source.sourceId.startsWith("skill:"))),
    `Acceptance criteria:\n${node.acceptanceCriteria.map(value=>`- ${value}`).join("\n")||"- No additional criteria"}`,
    `Artifacts:\n${artifacts.map(row=>`- ${JSON.stringify(safeArtifactReference(row))}`).join("\n")}`,
    "Read artifact content only through mcp__task-graph__read_input_artifact using the listed artifactId.",
    verificationCompletionGuidance(),
  ].join("\n\n");
}
