import type Database from "better-sqlite3";
import type { GraphSnapshot,TaskNode,TaskNodeAdjudication } from "../../shared/task-graph-contracts.ts";
import { taskNodeAdjudicationSchema } from "../../shared/task-graph-contracts.ts";
import { TaskGraphConflictError,TaskGraphValidationError } from "./errors.ts";
import { contentHash } from "./hash.ts";
import { executeTaskGraphCommand } from "./service-idempotency.ts";
import type { TaskGraphService } from "./service.ts";
import { hasPassedVerificationTaskWitness } from "./verification-verdict.ts";

type Row=Record<string,unknown>;

export interface TaskNodeAdjudicationInput {
  runId:string;
  nodeId:string;
  currentAttemptId:string;
  expectedRunRevision:number;
  requestId:string;
  decision:"accepted"|"rejected"|"retry";
  actor:string;
  reason:string;
  guidance?:string;
}

export async function adjudicateTaskGraphNode(
  service:TaskGraphService,
  raw:TaskNodeAdjudicationInput,
):Promise<GraphSnapshot> {
  const input=normalizeInput(raw);
  const initial=service.repo.snapshot(input.runId,0);
  const payload={...input,guidance:input.guidance??null};
  const mutate=()=>{
    service.repo.assertCanonicalRun(input.runId);
    const run=service.options.db.prepare("SELECT * FROM task_graph_runs WHERE id=?")
      .get(input.runId) as Row|undefined;
    if (!run || run.revision!==input.expectedRunRevision
      || !["active","quiescent","blocked","failed"].includes(String(run.status))) {
      throw new TaskGraphConflictError("graph node is not awaiting adjudication",run??null);
    }
    const node=service.repo.getRevision(String(run.revision_id)).nodes
      .find(candidate=>candidate.id===input.nodeId);
    if (!node) throw new TaskGraphValidationError("graph node not found");
    const attempt=service.options.db.prepare(`SELECT * FROM task_node_attempts
      WHERE run_id=? AND node_id=? ORDER BY attempt_number DESC LIMIT 1`)
      .get(input.runId,input.nodeId) as Row|undefined;
    if (!attempt || attempt.id!==input.currentAttemptId || attempt.runtime!=="terminal"
      || attempt.source_snapshot_id!==run.source_snapshot_id) {
      throw new TaskGraphConflictError("stale verification attempt",run);
    }
    if (service.options.db.prepare(`SELECT 1 FROM task_node_invalidations WHERE run_id=?
      AND node_id=? AND invalidated_attempt_id=? LIMIT 1`)
      .get(input.runId,input.nodeId,input.currentAttemptId)) {
      throw new TaskGraphConflictError("verification attempt was superseded",run);
    }
    const independentResult=service.options.db.prepare(`SELECT result FROM task_verifications
      WHERE run_id=? AND node_id=? AND producer_attempt_id=? AND source_snapshot_id=?
      ORDER BY created_at DESC,id DESC LIMIT 1`)
      .get(input.runId,input.nodeId,input.currentAttemptId,run.source_snapshot_id) as Row|undefined;
    const independentlyRejected=node.verificationRequired
      && ["failed","inconclusive"].includes(String(independentResult?.result));
    if (node.completionMode!=="verification" && !independentlyRejected) {
      throw new TaskGraphValidationError(
        "only unsuccessful verification work can be adjudicated",
      );
    }
    if (input.decision==="accepted" && hasPassedVerificationTaskWitness(attempt)) {
      const outputs=service.options.db.prepare(`SELECT output_name FROM task_artifacts
        WHERE run_id=? AND node_id=? AND producer_attempt_id=? AND source_snapshot_id=?
        AND state IN ('staged','committed','rejected')`)
        .all(input.runId,input.nodeId,input.currentAttemptId,run.source_snapshot_id) as Row[];
      const outputNames=new Set(outputs.map(row=>String(row.output_name)));
      if (Object.keys(node.outputSchemas).some(name=>!outputNames.has(name))) {
        throw new TaskGraphValidationError(
          "a passed verification report with missing declared outputs can only be retried or rejected",
        );
      }
    }
    const existing=service.options.db.prepare(`SELECT * FROM task_node_adjudications
      WHERE run_id=? AND node_id=? AND attempt_id=?`)
      .get(input.runId,input.nodeId,input.currentAttemptId) as Row|undefined;
    if (existing) throw new TaskGraphConflictError("verification attempt was already adjudicated",existing);

    const at=service.now();
    const id=`adjudication:${input.requestId}`;
    const adjudication=taskNodeAdjudicationSchema.parse({id,runId:input.runId,nodeId:input.nodeId,
      attemptId:input.currentAttemptId,sourceSnapshotId:String(run.source_snapshot_id),
      acceptanceCriteriaVersion:contentHash(node.acceptanceCriteria),decision:input.decision,
      actor:input.actor,reason:input.reason,guidance:input.guidance??null,createdAt:at});
    insertAdjudication(service.options.db,adjudication);
    const promotedArtifactIds=input.decision==="accepted"
      ? promoteAcceptedArtifacts(service.options.db,input,attempt,at):[];
    if (input.decision==="retry") prepareRetry(service,input,attempt,at);
    const nextStatus=input.decision==="rejected"?"failed":"active";
    const revision=service.repo.casRun(input.runId,input.expectedRunRevision,{status:nextStatus},at);
    service.repo.appendEvent(input.runId,revision,"node_adjudicated",input.nodeId,
      `node-adjudicated:${input.requestId}`,{attemptId:input.currentAttemptId,
        decision:input.decision,actor:input.actor,reason:input.reason,promotedArtifactIds},at);
    if (input.decision==="rejected") service.evidence.drainTerminalOperations(input.runId,at);
    else service.evidence.evaluate(input.runId,revision,at);
  };
  executeTaskGraphCommand(service,{requestId:input.requestId,workItemId:initial.run.workItemId,
    command:"adjudicate_task_node",payload,resultKey:input.runId},mutate);
  const snapshot=input.decision==="rejected"
    ? service.repo.snapshot(input.runId)
    : await service.tick(input.runId);
  service.publishChanged(snapshot,"node_adjudicated");
  return snapshot;
}

export function isAcceptedNodeAdjudication(
  adjudication:Row|undefined,
  node:TaskNode,
  attempt:Row|undefined,
  sourceSnapshotId:string,
):boolean {
  if (!adjudication || !attempt) return false;
  return String(adjudication.decision)==="accepted"
    && String(adjudication.node_id??adjudication.nodeId)===node.id
    && String(adjudication.attempt_id??adjudication.attemptId)===String(attempt.id)
    && String(adjudication.source_snapshot_id??adjudication.sourceSnapshotId)===sourceSnapshotId
    && String(adjudication.acceptance_criteria_version??adjudication.acceptanceCriteriaVersion)
      ===contentHash(node.acceptanceCriteria);
}

export function isEffectiveAttemptSuccess(db:Database.Database,attempt:Row):boolean {
  if (attempt.outcome==="succeeded") return true;
  return Boolean(db.prepare(`SELECT 1 FROM task_node_adjudications adjudication
    WHERE adjudication.run_id=? AND adjudication.node_id=? AND adjudication.attempt_id=?
    AND adjudication.source_snapshot_id=? AND adjudication.decision='accepted' LIMIT 1`)
    .get(attempt.run_id,attempt.node_id,attempt.id,attempt.source_snapshot_id));
}

export function effectiveAttemptSuccessSql(attemptAlias:string):string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(attemptAlias)) {
    throw new TaskGraphValidationError("invalid attempt SQL alias");
  }
  return `(${attemptAlias}.outcome='succeeded' OR EXISTS (
    SELECT 1 FROM task_node_adjudications accepted_attempt
    WHERE accepted_attempt.run_id=${attemptAlias}.run_id
      AND accepted_attempt.node_id=${attemptAlias}.node_id
      AND accepted_attempt.attempt_id=${attemptAlias}.id
      AND accepted_attempt.source_snapshot_id=${attemptAlias}.source_snapshot_id
      AND accepted_attempt.decision='accepted'))`;
}

function normalizeInput(input:TaskNodeAdjudicationInput):TaskNodeAdjudicationInput {
  const actor=input.actor.trim();const reason=input.reason.trim();
  const guidance=input.guidance?.trim()||undefined;
  if (!actor || actor.length>256 || !reason || reason.length>2_000) {
    throw new TaskGraphValidationError("adjudication actor and bounded reason are required");
  }
  if (guidance && guidance.length>4_000) {
    throw new TaskGraphValidationError("adjudication guidance is too long");
  }
  if (input.decision!=="retry" && guidance) {
    throw new TaskGraphValidationError("guidance is only valid for retry adjudication");
  }
  return {...input,actor,reason,...(guidance?{guidance}:{})};
}

function insertAdjudication(db:Database.Database,input:TaskNodeAdjudication):void {
  db.prepare(`INSERT INTO task_node_adjudications
    (id,run_id,node_id,attempt_id,source_snapshot_id,acceptance_criteria_version,
      decision,actor,reason,guidance,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(input.id,input.runId,input.nodeId,input.attemptId,input.sourceSnapshotId,
      input.acceptanceCriteriaVersion,input.decision,input.actor,input.reason,input.guidance,input.createdAt);
}

function promoteAcceptedArtifacts(db:Database.Database,input:TaskNodeAdjudicationInput,
  attempt:Row,at:number):string[] {
  const artifacts=db.prepare(`SELECT id FROM task_artifacts WHERE run_id=? AND node_id=?
    AND producer_attempt_id=? AND source_snapshot_id=? AND state IN ('staged','rejected') ORDER BY id`)
    .all(input.runId,input.nodeId,input.currentAttemptId,attempt.source_snapshot_id) as Row[];
  if (artifacts.length) db.prepare(`UPDATE task_artifacts SET state='committed',committed_at=?
    WHERE run_id=? AND node_id=? AND producer_attempt_id=? AND source_snapshot_id=?
    AND state IN ('staged','rejected')`).run(at,input.runId,input.nodeId,input.currentAttemptId,
      attempt.source_snapshot_id);
  return artifacts.map(artifact=>String(artifact.id));
}

function prepareRetry(service:TaskGraphService,input:TaskNodeAdjudicationInput,
  attempt:Row,at:number):void {
  const steeringId=`adjudication-steering:${input.requestId}`;
  const instructions=input.guidance??input.reason;
  const record={instructions,affectedNodeIds:[input.nodeId],impactedNodeIds:[input.nodeId],
    source:"leader_adjudication"};
  service.options.db.prepare("INSERT INTO task_graph_steering_events VALUES(?,?,?,?,?)")
    .run(steeringId,input.runId,contentHash(record),JSON.stringify(record),at);
  service.options.db.prepare(`INSERT INTO task_node_invalidations
    (run_id,node_id,steering_id,invalidated_attempt_id,created_at) VALUES(?,?,?,?,?)`)
    .run(input.runId,input.nodeId,steeringId,input.currentAttemptId,at);
  service.options.db.prepare(`UPDATE task_artifacts SET state='rejected' WHERE run_id=?
    AND producer_attempt_id=? AND state='staged'`).run(input.runId,input.currentAttemptId);
  service.options.db.prepare(`INSERT INTO task_manual_retry_grants VALUES(?,?,1,?)
    ON CONFLICT(run_id,node_id) DO UPDATE SET remaining=remaining+1,granted_at=excluded.granted_at`)
    .run(input.runId,input.nodeId,at);
  service.options.db.prepare("UPDATE task_node_attempts SET backoff_until=NULL WHERE id=?")
    .run(attempt.id);
}
