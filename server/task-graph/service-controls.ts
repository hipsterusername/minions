import { hashSchema,type GraphSnapshot } from "../../shared/task-graph-contracts.ts";
import { taskGraphArtifactViewSchema,type TaskGraphArtifactView } from "../../shared/task-graph-view-contracts.ts";
import { TaskGraphConflictError,TaskGraphValidationError } from "./errors.ts";
import { contentHash } from "./hash.ts";
import { executeTaskGraphCommand,isTaskGraphCommandReplay } from "./service-idempotency.ts";
import type { TaskGraphService } from "./service.ts";

type Row=Record<string,unknown>;

export async function steerTaskGraph(service:TaskGraphService,input:{runId:string;
  expectedRunRevision:number;requestId:string;instructions:string;affectedNodeIds:string[]
}):Promise<GraphSnapshot> {
  const instructions=input.instructions.trim();
  if (!instructions) throw new TaskGraphValidationError("steering instructions are required");
  const requested=[...new Set(input.affectedNodeIds)];
  if (!requested.length) throw new TaskGraphValidationError("steering requires an explicit impact set");
  const at=service.now();
  const requestHash=contentHash({instructions,affectedNodeIds:[...requested].sort()});
  const commandPayload={runId:input.runId,expectedRunRevision:input.expectedRunRevision,
    instructions,affectedNodeIds:requested};
  if (isTaskGraphCommandReplay(service,{requestId:input.requestId,command:"steer_task_graph",
    payload:commandPayload})) return service.repo.snapshot(input.runId);
  const workItemId=service.repo.snapshot(input.runId,0).run.workItemId;
  let replay=false;
  const mutate=()=>service.options.db.transaction(()=>{
    const existing=service.options.db.prepare("SELECT * FROM task_graph_steering_events WHERE id=?")
      .get(input.requestId) as Row|undefined;
    if (existing) {
      if (existing.run_id!==input.runId || existing.instructions_hash!==requestHash) {
        throw new TaskGraphConflictError("steering request id was already used",existing);
      }
      replay=true;
      return;
    }
    service.repo.assertCanonicalRun(input.runId);
    const run=service.options.db.prepare("SELECT * FROM task_graph_runs WHERE id=?")
      .get(input.runId) as Row|undefined;
    if (!run || run.revision!==input.expectedRunRevision
      || !["active","blocked","quiescent"].includes(String(run.status))) {
      throw new TaskGraphConflictError("stale graph-run revision",run??null);
    }
    const spec=service.repo.getRevision(String(run.revision_id));
    const known=new Set(spec.nodes.map(node=>node.id));
    if (requested.some(nodeId=>!known.has(nodeId))) {
      throw new TaskGraphValidationError("steering impact set contains an unknown node");
    }
    const impacted=descendantClosure(requested,spec.edges);
    const record={instructions,affectedNodeIds:requested,impactedNodeIds:impacted};
    service.options.db.prepare("INSERT INTO task_graph_steering_events VALUES(?,?,?,?,?)")
      .run(input.requestId,input.runId,requestHash,JSON.stringify(record),at);
    const latest=service.options.db.prepare(`SELECT * FROM task_node_attempts WHERE run_id=? AND node_id=?
      ORDER BY attempt_number DESC LIMIT 1`);
    const invalidate=service.options.db.prepare(`INSERT INTO task_node_invalidations
      (run_id,node_id,steering_id,invalidated_attempt_id,created_at) VALUES(?,?,?,?,?)`);
    for (const nodeId of impacted) {
      const attempt=latest.get(input.runId,nodeId) as Row|undefined;
      invalidate.run(input.runId,nodeId,input.requestId,attempt?.id??null,at);
      if (!attempt) continue;
      if (attempt.runtime!=="terminal") supersedeAttempt(service,input.runId,attempt,input.requestId,at);
      service.options.db.prepare(`UPDATE task_artifacts SET state='rejected' WHERE run_id=?
        AND producer_attempt_id=? AND state='staged'`).run(input.runId,attempt.id);
      const node=spec.nodes.find(candidate=>candidate.id===nodeId)!;
      if (Number(attempt.attempt_number)>=node.retryPolicy.maxAttempts) {
        service.options.db.prepare(`INSERT INTO task_manual_retry_grants VALUES(?,?,1,?)
          ON CONFLICT(run_id,node_id) DO UPDATE SET remaining=remaining+1,granted_at=excluded.granted_at`)
          .run(input.runId,nodeId,at);
      }
    }
    const verifierRequests=service.options.db.prepare(`SELECT * FROM task_verification_requests
      WHERE run_id=? AND node_id IN (${impacted.map(()=>"?").join(",")})
      AND status IN ('pending','launching','running')`).all(input.runId,...impacted) as Row[];
    for (const verifier of verifierRequests) {
      service.options.db.prepare(`UPDATE task_verification_requests SET status='failed',result=?,updated_at=?
        WHERE id=?`).run("superseded by graph steering",at,verifier.id);
      if (verifier.verifier_run_key) enqueueCancellation(service,input.runId,
        String(verifier.verifier_attempt_id),1,String(verifier.verifier_run_key),at);
    }
    const revision=service.repo.casRun(input.runId,input.expectedRunRevision,{status:"active"},at);
    service.evidence.evaluate(input.runId,revision,at);
    service.repo.appendEvent(input.runId,revision,"graph_steered",input.requestId,
      `steer:${input.requestId}`,{instructionsHash:requestHash,affectedNodeIds:requested,
        impactedNodeIds:impacted},at);
  }).immediate();
  executeTaskGraphCommand(service,{requestId:input.requestId,workItemId,command:"steer_task_graph",
    payload:commandPayload,resultKey:input.runId},mutate);
  if (replay) return service.repo.snapshot(input.runId);
  await service.deliverPendingCancellations(input.runId);
  const snapshot=await service.tick(input.runId);
  service.publishChanged(snapshot,"graph_steered");
  return snapshot;
}

export function taskGraphArtifact(service:TaskGraphService,input:{runId:string;
  artifactId:string}):TaskGraphArtifactView {
  const row=service.options.db.prepare("SELECT * FROM task_artifacts WHERE id=? AND run_id=?")
    .get(input.artifactId,input.runId) as Row|undefined;
  if (!row) throw new TaskGraphValidationError("task artifact not found");
  const metadata=JSON.parse(String(row.metadata_json)) as Record<string,unknown>;
  return taskGraphArtifactViewSchema.parse({
    id:row.id,graphRunId:row.run_id,nodeId:row.node_id,producerAttemptId:row.producer_attempt_id,
    sourceSnapshotId:row.source_snapshot_id,outputName:row.output_name,contentHash:row.content_hash,
    schemaName:metadata["schemaName"],schemaVersion:metadata["schemaVersion"],
    byteSize:metadata["byteSize"],classification:metadata["classification"],
    retentionPolicy:metadata["retentionPolicy"],state:row.state,
    createdAt:new Date(Number(row.created_at)).toISOString(),
    committedAt:row.committed_at==null?null:new Date(Number(row.committed_at)).toISOString(),
  });
}

export async function reconcileTaskGraph(service:TaskGraphService,input:{runId:string;
  expectedRunRevision:number;requestId:string;artifactIds:string[];verificationIds:string[];
  sourceDiffHash:string}):Promise<GraphSnapshot> {
  hashSchema.parse(input.sourceDiffHash);
  const commandPayload={runId:input.runId,expectedRunRevision:input.expectedRunRevision,
    artifactIds:input.artifactIds,verificationIds:input.verificationIds,
    sourceDiffHash:input.sourceDiffHash};
  if (isTaskGraphCommandReplay(service,{requestId:input.requestId,
    command:"reconcile_task_graph_run",payload:commandPayload})) return service.repo.snapshot(input.runId);
  service.repo.assertCanonicalRun(input.runId);
  const snapshot=service.repo.snapshot(input.runId,0);
  if (snapshot.run.revision!==input.expectedRunRevision) {
    throw new TaskGraphConflictError("stale reconciliation",snapshot);
  }
  if (snapshot.sourceSnapshot.dirtyDiffDigest!==input.sourceDiffHash) {
    throw new TaskGraphConflictError("reconciliation source diff does not match the graph snapshot",snapshot);
  }
  const artifactIds=uniqueSorted(input.artifactIds,"artifact");
  const verificationIds=uniqueSorted(input.verificationIds,"verification");
  if (!artifactIds.length) throw new TaskGraphValidationError("reconciliation requires artifacts");
  const artifacts=artifactIds.map(id=>{
    const row=service.options.db.prepare(`SELECT * FROM task_artifacts WHERE id=? AND run_id=?
      AND state='committed' AND source_snapshot_id=?`).get(id,input.runId,snapshot.run.sourceSnapshotId) as Row|undefined;
    if (!row || service.options.db.prepare(`SELECT 1 FROM task_node_invalidations
      WHERE run_id=? AND node_id=? AND invalidated_attempt_id=? LIMIT 1`)
      .get(input.runId,row?.node_id,row?.producer_attempt_id)) {
      throw new TaskGraphValidationError(`reconciliation artifact is unavailable: ${id}`);
    }
    return row;
  });
  const verifications=verificationIds.map(id=>{
    const row=service.options.db.prepare(`SELECT * FROM task_verifications WHERE id=? AND run_id=?
      AND source_snapshot_id=? AND result IN ('passed','waived')`)
      .get(id,input.runId,snapshot.run.sourceSnapshotId) as Row|undefined;
    if (!row) throw new TaskGraphValidationError(`reconciliation verification is unavailable: ${id}`);
    return row;
  });
  const selectedHashes=new Set(artifacts.map(row=>String(row.content_hash)));
  for (const verification of verifications) {
    const record=JSON.parse(String(verification.record_json)) as {artifactHashes?:unknown};
    if (!Array.isArray(record.artifactHashes)
      || record.artifactHashes.some(hash=>typeof hash!=="string" || !selectedHashes.has(hash))) {
      throw new TaskGraphValidationError("reconciliation verification does not bind selected artifacts");
    }
  }
  const record={sourceDiffHash:input.sourceDiffHash,artifactIds,
    artifactHashes:artifacts.map(row=>String(row.content_hash)).sort(),verificationIds,
    verificationFingerprints:verifications.map(row=>String(row.fingerprint)).sort()};
  const reconciliationId=`reconciliation:${input.requestId}`;
  const existing=service.options.db.prepare("SELECT record_json FROM task_reconciliations WHERE id=?")
    .get(reconciliationId) as Row|undefined;
  const mutate=()=>{
    if (existing) {
      if (contentHash(JSON.parse(String(existing.record_json)))!==contentHash(record)) {
        throw new TaskGraphConflictError("reconciliation request id was already used",snapshot);
      }
      return;
    }
    service.evidence.reconcile(input.runId,input.expectedRunRevision,reconciliationId,record,service.now());
  };
  executeTaskGraphCommand(service,{requestId:input.requestId,workItemId:snapshot.run.workItemId,
    command:"reconcile_task_graph_run",payload:commandPayload,resultKey:input.runId},mutate);
  const result=service.repo.snapshot(input.runId);
  service.publishChanged(result,"graph_reconciled");
  return result;
}

export function steeringInstructions(service:TaskGraphService,runId:string,nodeId:string):string[] {
  const rows=service.options.db.prepare(`SELECT s.record_json FROM task_node_invalidations i
    JOIN task_graph_steering_events s ON s.id=i.steering_id
    WHERE i.run_id=? AND i.node_id=? ORDER BY i.created_at,s.id`).all(runId,nodeId) as Row[];
  return rows.map(row=>JSON.parse(String(row.record_json)) as {instructions?:unknown})
    .map(record=>record.instructions).filter((value):value is string=>typeof value==="string");
}

function supersedeAttempt(service:TaskGraphService,runId:string,attempt:Row,
  steeringId:string,at:number):void {
  service.options.db.prepare(`UPDATE task_node_attempts SET runtime='terminal',outcome='superseded',
    terminal_witness_json=?,backoff_until=NULL,updated_at=? WHERE id=? AND runtime<>'terminal'`)
    .run(JSON.stringify({source:"graph_steering",steeringId}),at,attempt.id);
  if (attempt.session_run_key) enqueueCancellation(service,runId,String(attempt.id),
    Number(attempt.generation),String(attempt.session_run_key),at);
  else service.options.db.prepare(`UPDATE task_resource_reservations SET released_at=? WHERE attempt_id=?
    AND released_at IS NULL AND kind NOT LIKE 'budget_%'`).run(at,attempt.id);
}

function enqueueCancellation(service:TaskGraphService,runId:string,attemptId:string,generation:number,
  sessionRunKey:string,at:number):void {
  service.options.db.prepare(`INSERT OR IGNORE INTO task_scheduler_outbox
    (id,run_id,attempt_id,generation,kind,payload_json,delivered_at,created_at)
    VALUES(?,?,?,?,?,?,NULL,?)`).run(`cancel:${attemptId}:${generation}`,runId,attemptId,generation,
      "cancel_child",JSON.stringify({sessionRunKey}),at);
}

function descendantClosure(seed:string[],edges:Array<{sourceNodeId:string;targetNodeId:string}>):string[] {
  const result=new Set(seed);const queue=[...seed];
  while (queue.length) {
    const source=queue.shift()!;
    for (const edge of edges) if (edge.sourceNodeId===source && !result.has(edge.targetNodeId)) {
      result.add(edge.targetNodeId);queue.push(edge.targetNodeId);
    }
  }
  return [...result];
}

function uniqueSorted(values:string[],label:string):string[] {
  if (new Set(values).size!==values.length) {
    throw new TaskGraphValidationError(`reconciliation contains duplicate ${label} ids`);
  }
  return [...values].sort();
}
