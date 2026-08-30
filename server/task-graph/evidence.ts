import type Database from "better-sqlite3";
import { artifactInputSchema, attemptEventSchema, hashSchema, verificationInputSchema,
  type ArtifactInput, type AttemptEvent, type VerificationInput } from "../../shared/task-graph-contracts.ts";
import { TaskGraphConflictError, TaskGraphValidationError } from "./errors.ts";
import { contentHash } from "./hash.ts";
import { TaskGraphRepository } from "./repository.ts";
import path from "node:path";
import {z} from "zod/v4";
import {hasPassedVerificationTaskWitness} from "./verification-verdict.ts";
import {effectiveAttemptSuccessSql,isAcceptedNodeAdjudication} from "./adjudication.ts";

type Row = Record<string, unknown>;
export const MAX_VERIFICATION_SUMMARY_CHARS=1_000;
const storedVerificationInputSchema=verificationInputSchema.extend({
  summary:z.string().min(1).max(MAX_VERIFICATION_SUMMARY_CHARS).optional(),
});
export function currentProducerArtifacts(db:Database.Database,runId:string,nodeId:string,
  outputName:string|null=null):Row[] {
  return db.prepare(`SELECT artifact.* FROM task_artifacts artifact
    JOIN task_node_attempts attempt ON attempt.id=artifact.producer_attempt_id
      AND attempt.run_id=artifact.run_id AND attempt.node_id=artifact.node_id
    JOIN task_graph_runs run ON run.id=artifact.run_id
    WHERE artifact.run_id=? AND artifact.node_id=? AND artifact.state='committed'
      AND artifact.source_snapshot_id=run.source_snapshot_id
      AND attempt.source_snapshot_id=run.source_snapshot_id
      AND attempt.runtime='terminal' AND ${effectiveAttemptSuccessSql("attempt")}
      AND attempt.id=(SELECT latest.id FROM task_node_attempts latest
        WHERE latest.run_id=artifact.run_id AND latest.node_id=artifact.node_id
        ORDER BY latest.attempt_number DESC LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM task_node_invalidations invalidation
        WHERE invalidation.run_id=attempt.run_id AND invalidation.node_id=attempt.node_id
        AND invalidation.invalidated_attempt_id=attempt.id)
      AND (? IS NULL OR artifact.output_name=?) ORDER BY artifact.content_hash,artifact.id`)
    .all(runId,nodeId,outputName,outputName) as Row[];
}
export class TaskGraphEvidence {
  constructor(readonly repo: TaskGraphRepository) {}
  get db(): Database.Database { return this.repo.db; }

  stageArtifact(eventRaw: AttemptEvent, inputRaw: ArtifactInput): boolean {
    const event = attemptEventSchema.parse(eventRaw); const input = artifactInputSchema.parse(inputRaw);
    return this.db.transaction(() => {
      if (this.duplicate(event)) return false;
      const { run, attempt } = this.assertAttempt(event,["running","waiting"]);
      const node = this.repo.getRevision(String(run.revision_id)).nodes.find(item => item.id === attempt.node_id)!;
      if (!(input.outputName in node.outputSchemas)) throw new TaskGraphValidationError(
        `$.outputName: expected one of ${JSON.stringify(Object.keys(node.outputSchemas))}; received ${JSON.stringify(input.outputName)}`,
      );
      const declaration=node.outputSchemas[input.outputName];
      if (declaration && typeof declaration === "object") {
        const declared=declaration as Record<string,unknown>;
        if ((typeof declared["schemaName"] === "string" && declared["schemaName"] !== input.schemaName)
          || (typeof declared["schemaVersion"] === "string" && declared["schemaVersion"] !== input.schemaVersion)) {
          const expected={schemaName:typeof declared["schemaName"]==="string"
            ?declared["schemaName"]:"GraphOutput",schemaVersion:typeof declared["schemaVersion"]==="string"
            ?declared["schemaVersion"]:"1"};
          throw new TaskGraphValidationError(
            `artifact metadata does not match declared output: expected ${JSON.stringify(expected)}; received ${JSON.stringify({schemaName:input.schemaName,schemaVersion:input.schemaVersion})}. Repair the metadata and restage; the rejected draft did not consume the output slot.`,
          );
        }
      }
      const declaredScopes = node.ownershipRequest
        .filter(scope => scope.scope === "path" && scope.mode === "write")
        .map(scope => scope.normalizedValue);
      const observed=input.observedWriteSet.map(candidate=>canonicalRelativePath(candidate,"observed write path"));
      if (observed.length && (!declaredScopes.length || observed.some(candidate =>
        !declaredScopes.some(scope => candidate === scope || candidate.startsWith(`${scope}/`))))) {
        throw new TaskGraphValidationError("observed write set exceeds ownership request");
      }
      const existing=this.db.prepare(`SELECT id,content_hash,state FROM task_artifacts
        WHERE run_id=? AND producer_attempt_id=? AND output_name=?`)
        .get(event.runId,event.attemptId,input.outputName) as Row|undefined;
      if (existing) throw new TaskGraphConflictError("attempt output is already immutable",existing);
      this.db.prepare(`INSERT INTO task_artifacts
        (id,run_id,node_id,producer_attempt_id,source_snapshot_id,output_name,content_hash,metadata_json,state,created_at)
        VALUES(?,?,?,?,?,?,?,?,'staged',?)`)
        .run(input.id,event.runId,attempt.node_id,event.attemptId,attempt.source_snapshot_id,input.outputName,
          input.contentHash,JSON.stringify(input),event.at);
      const next = this.repo.casRun(event.runId,event.expectedRunRevision,{},event.at);
      this.repo.appendEvent(event.runId,next,"artifact_staged",input.id,event.idempotencyKey,{ contentHash:input.contentHash },event.at);
      return true;
    }).immediate();
  }

  commitArtifact(eventRaw: AttemptEvent, artifactId: string): boolean {
    const event = attemptEventSchema.parse(eventRaw);
    return this.db.transaction(() => {
      if (this.duplicate(event)) return false;
      const { attempt } = this.assertAttempt(event,["terminal"]);
      if (attempt.outcome !== "succeeded") throw new TaskGraphConflictError("only a successful current attempt may commit");
      const newer = this.db.prepare(`SELECT 1 FROM task_node_attempts WHERE run_id=? AND node_id=? AND
        (attempt_number>? OR generation>?)`).get(event.runId,attempt.node_id,attempt.attempt_number,event.generation);
      if (newer) throw new TaskGraphConflictError("attempt was superseded");
      const result = this.db.prepare(`UPDATE task_artifacts SET state='committed',committed_at=?
        WHERE id=? AND run_id=? AND producer_attempt_id=? AND source_snapshot_id=? AND state='staged'`)
        .run(event.at,artifactId,event.runId,event.attemptId,attempt.source_snapshot_id);
      if (result.changes !== 1) throw new TaskGraphConflictError("artifact is stale or immutable");
      const next = this.repo.casRun(event.runId,event.expectedRunRevision,{},event.at);
      this.evaluate(event.runId,next,event.at);
      this.repo.appendEvent(event.runId,next,"artifact_committed",artifactId,event.idempotencyKey,{},event.at);
      return true;
    }).immediate();
  }

  recordVerification(inputRaw: VerificationInput&{summary?:string}, expectedRunRevision: number, idempotencyKey: string): boolean {
    const input = storedVerificationInputSchema.parse(inputRaw);
    return this.db.transaction(() => {
      const run = this.db.prepare("SELECT * FROM task_graph_runs WHERE id=?").get(input.runId) as Row | undefined;
      if (!run || run.revision !== expectedRunRevision
        || !["active","quiescent","blocked"].includes(String(run.status))) {
        throw new TaskGraphConflictError("stale verification",run ?? null);
      }
      if (this.db.prepare("SELECT 1 FROM task_scheduler_events WHERE run_id=? AND idempotency_key=?").get(input.runId,idempotencyKey)) return false;
      if (input.producerAttemptId === input.verifierAttemptId) throw new TaskGraphValidationError("producer cannot independently verify itself");
      const producer = this.db.prepare("SELECT * FROM task_node_attempts WHERE id=? AND run_id=?").get(input.producerAttemptId,input.runId) as Row | undefined;
      const verifier = this.db.prepare("SELECT * FROM task_node_attempts WHERE id=? AND run_id=?").get(input.verifierAttemptId,input.runId) as Row | undefined;
      const verifierRequest = this.db.prepare(`SELECT * FROM task_verification_requests
        WHERE verifier_attempt_id=? AND run_id=? AND node_id=? AND producer_attempt_id=?`)
        .get(input.verifierAttemptId,input.runId,input.nodeId,input.producerAttemptId) as Row | undefined;
      const humanWaiver = input.method === "human" && input.result === "waived"
        && input.verifierAttemptId.startsWith("human:");
      const invalidated = this.db.prepare(`SELECT 1 FROM task_node_invalidations
        WHERE run_id=? AND node_id=? AND invalidated_attempt_id=? LIMIT 1`)
        .get(input.runId,input.nodeId,input.producerAttemptId);
      if (!producer || (!verifier && !verifierRequest && !humanWaiver)
        || producer.node_id !== input.nodeId || producer.source_snapshot_id !== input.sourceSnapshotId
        || invalidated) {
        throw new TaskGraphValidationError("verification attempt binding mismatch");
      }
      const actual = (this.db.prepare(`SELECT content_hash FROM task_artifacts WHERE run_id=? AND producer_attempt_id=?
        AND state='committed' ORDER BY content_hash`).all(input.runId,input.producerAttemptId) as Row[]).map(row => String(row.content_hash));
      if (JSON.stringify([...input.artifactHashes].sort()) !== JSON.stringify(actual)) throw new TaskGraphConflictError("artifact hashes changed");
      const fingerprint = contentHash({ revisionId:run.revision_id,sourceSnapshotId:input.sourceSnapshotId,
        artifactHashes:actual,criteria:input.acceptanceCriteriaVersion,method:input.method });
      this.db.prepare("INSERT INTO task_verifications VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run(input.id,input.runId,input.nodeId,input.producerAttemptId,input.verifierAttemptId,input.sourceSnapshotId,
          fingerprint,input.result,JSON.stringify(input),input.at,input.result === "pending" ? null : input.at);
      const next = this.repo.casRun(input.runId,expectedRunRevision,{},input.at);
      this.evaluate(input.runId,next,input.at);
      this.repo.appendEvent(input.runId,next,"verification_recorded",input.id,idempotencyKey,{ fingerprint,result:input.result },input.at);
      return true;
    }).immediate();
  }

  expand(runId: string, nodeId: string, expectedRevision: number, instances: Array<{id:string;payload:unknown}>, at: number): number {
    return this.db.transaction(() => {
      const run = this.db.prepare("SELECT * FROM task_graph_runs WHERE id=?").get(runId) as Row | undefined;
      if (!run || run.revision !== expectedRevision) throw new TaskGraphConflictError("stale expansion",run ?? null);
      const spec = this.repo.getRevision(String(run.revision_id)); const node = spec.nodes.find(item => item.id === nodeId);
      if (!node?.expansionPolicy) throw new TaskGraphValidationError("node does not allow expansion");
      const existing = Number((this.db.prepare("SELECT count(*) n FROM task_expansion_instances WHERE run_id=? AND expansion_node_id=?").get(runId,nodeId) as Row).n);
      const total = Number((this.db.prepare("SELECT count(*) n FROM task_expansion_instances WHERE run_id=?").get(runId) as Row).n);
      if (existing + instances.length > node.expansionPolicy.maxChildren || total + instances.length > 1_000) {
        throw new TaskGraphValidationError("expansion bound exceeded");
      }
      const insert = this.db.prepare("INSERT INTO task_expansion_instances VALUES(?,?,?,?,?,?,?)");
      instances.forEach((instance,index) => insert.run(runId,nodeId,instance.id,existing+index,contentHash(instance.payload),JSON.stringify(instance.payload),at));
      const next = this.repo.casRun(runId,expectedRevision,{},at);
      this.repo.appendEvent(runId,next,"expansion_frozen",nodeId,`expand:${nodeId}:${next}`,{ instanceIds:instances.map(i=>i.id) },at);
      return next;
    }).immediate();
  }

  reduceExpansion(input: { runId:string; expansionNodeId:string; reducerNodeId:string; reductionId:string;
    expectedRunRevision:number; outputHash:string; at:number }): string {
    return this.db.transaction(() => {
      hashSchema.parse(input.outputHash);
      const run = this.db.prepare("SELECT * FROM task_graph_runs WHERE id=?").get(input.runId) as Row | undefined;
      if (!run || run.revision !== input.expectedRunRevision) throw new TaskGraphConflictError("stale reduction",run ?? null);
      const spec = this.repo.getRevision(String(run.revision_id));
      const expansion = spec.nodes.find(node => node.id === input.expansionNodeId);
      if (!expansion?.expansionPolicy || !spec.nodes.some(node => node.id === input.reducerNodeId)) {
        throw new TaskGraphValidationError("invalid reduction binding");
      }
      const rows = this.db.prepare(`SELECT instance_id,input_hash FROM task_expansion_instances
        WHERE run_id=? AND expansion_node_id=? ORDER BY ordinal`).all(input.runId,input.expansionNodeId) as Row[];
      if (!rows.length || rows.length > expansion.expansionPolicy.maxChildren) throw new TaskGraphValidationError("reduction input bound invalid");
      const fingerprint = contentHash({ revisionId:run.revision_id,sourceSnapshotId:run.source_snapshot_id,
        instances:rows.map(row=>({ id:row.instance_id,hash:row.input_hash })) });
      this.db.prepare("INSERT INTO task_reductions VALUES(?,?,?,?,?,?,?,?)").run(input.reductionId,input.runId,
        input.reducerNodeId,input.expansionNodeId,fingerprint,input.outputHash,rows.length,input.at);
      const next = this.repo.casRun(input.runId,input.expectedRunRevision,{},input.at);
      this.repo.appendEvent(input.runId,next,"reduction_frozen",input.reductionId,`reduce:${input.reductionId}`,
        { inputFingerprint:fingerprint,outputHash:input.outputHash },input.at);
      return fingerprint;
    }).immediate();
  }

  reconcile(runId: string, expectedRevision: number, id: string, inputs: unknown, at: number): string {
    return this.db.transaction(() => {
      const run = this.db.prepare("SELECT * FROM task_graph_runs WHERE id=?").get(runId) as Row | undefined;
      if (!run || run.revision !== expectedRevision) throw new TaskGraphConflictError("stale reconciliation",run ?? null);
      const fingerprint = contentHash({ revisionId:run.revision_id,sourceSnapshotId:run.source_snapshot_id,inputs });
      this.db.prepare("INSERT INTO task_reconciliations VALUES(?,?,?,?,?)").run(id,runId,fingerprint,JSON.stringify(inputs),at);
      const next = this.repo.casRun(runId,expectedRevision,{},at);
      this.repo.appendEvent(runId,next,"reconciled",id,`reconcile:${id}`,{ fingerprint },at); return fingerprint;
    }).immediate();
  }

  evaluate(runId: string, runRevision: number, at: number): void {
    const run = this.db.prepare("SELECT * FROM task_graph_runs WHERE id=?").get(runId) as Row;
    if (["completed","failed","cancelled"].includes(String(run.status))) return;
    const spec = this.repo.getRevision(String(run.revision_id)); const satisfied = new Set<string>();
    const terminal = new Set<string>();
    for (const node of spec.nodes) {
      const attempt = this.db.prepare(`SELECT * FROM task_node_attempts WHERE run_id=? AND node_id=?
        ORDER BY attempt_number DESC LIMIT 1`).get(runId,node.id) as Row | undefined;
      const adjudication=attempt ? this.db.prepare(`SELECT * FROM task_node_adjudications
        WHERE run_id=? AND node_id=? AND attempt_id=? ORDER BY created_at DESC,id DESC LIMIT 1`)
        .get(runId,node.id,attempt.id) as Row|undefined:undefined;
      const accepted=isAcceptedNodeAdjudication(adjudication,node,attempt,
        String(run.source_snapshot_id));
      const invalidated = attempt && this.db.prepare(`SELECT 1 FROM task_node_invalidations
        WHERE run_id=? AND node_id=? AND invalidated_attempt_id=? LIMIT 1`)
        .get(runId,node.id,attempt.id);
      const manualRetries=Number((this.db.prepare(`SELECT remaining FROM task_manual_retry_grants
        WHERE run_id=? AND node_id=?`).get(runId,node.id) as Row|undefined)?.remaining??0);
      const retryable=attempt && node.retryPolicy.retryableOutcomes.includes(
        String(attempt.outcome) as "failed"|"lost"|"cancelled");
      const retryPending=!accepted && attempt?.outcome!=="succeeded" && (manualRetries>0
        || (retryable && Number(attempt.attempt_number)<node.retryPolicy.maxAttempts));
      if (attempt?.runtime === "terminal" && !invalidated && !retryPending) terminal.add(node.id);
      if (invalidated) continue;
      if (!attempt || (!accepted && attempt.outcome !== "succeeded")
        || attempt.source_snapshot_id !== run.source_snapshot_id) continue;
      if (node.completionMode==="verification" && !accepted
        && !hasPassedVerificationTaskWitness(attempt)) continue;
      const artifacts=currentProducerArtifacts(this.db,runId,node.id);
      const required = Object.keys(node.outputSchemas);
      if (required.some(name => !artifacts.some(a => a.output_name === name))) continue;
      if (node.verificationRequired && !accepted) {
        const hashes = artifacts.map(a => String(a.content_hash)).sort();
        const verification = this.db.prepare(`SELECT * FROM task_verifications WHERE run_id=? AND producer_attempt_id=?
          AND source_snapshot_id=? AND result IN ('passed','waived') ORDER BY created_at DESC LIMIT 1`)
          .get(runId,attempt.id,run.source_snapshot_id) as Row | undefined;
        if (!verification) continue;
        const record = JSON.parse(String(verification.record_json)) as {artifactHashes:string[]};
        if (JSON.stringify([...record.artifactHashes].sort()) !== JSON.stringify(hashes)) continue;
      }
      satisfied.add(node.id);
    }
    const upsert = this.db.prepare(`INSERT INTO task_edge_evaluations VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id,edge_id)
      DO UPDATE SET satisfied=excluded.satisfied,reason=excluded.reason,input_fingerprint=excluded.input_fingerprint,
      run_revision=excluded.run_revision,evaluated_at=excluded.evaluated_at`);
    for (const edge of spec.edges) {
      const humanInput = edge.kind === "human_gate" && this.db.prepare(`SELECT 1 FROM task_human_inputs
        WHERE run_id=? AND node_id=? AND edge_ids_json LIKE ? LIMIT 1`)
        .get(runId,edge.targetNodeId,`%\"${edge.id}\"%`);
      const artifacts=currentProducerArtifacts(this.db,runId,edge.sourceNodeId,edge.sourceOutput);
      const artifactReady=(edge.kind !== "artifact" && edge.kind !== "verified_artifact") || artifacts.length>0;
      const failureSkipped=edge.failurePolicy==="skip" && terminal.has(edge.sourceNodeId)
        && !satisfied.has(edge.sourceNodeId) && artifactReady;
      const ok = edge.kind === "human_gate" ? Boolean(humanInput)
        : edge.satisfactionPolicy === "all_terminal" ? terminal.has(edge.sourceNodeId) && artifactReady
          : failureSkipped || (satisfied.has(edge.sourceNodeId) && artifactReady);
      upsert.run(runId,edge.id,Number(ok),failureSkipped ? "upstream_failure_skipped"
        : ok ? "satisfied" : "upstream_not_satisfied",
        contentHash({ edgeId:edge.id,hashes:artifacts.map(a=>a.content_hash),ok }),runRevision,at);
    }
    const completed = spec.terminalNodeIds.every(id => satisfied.has(id));
    if (completed) {
      const changed=this.db.prepare(`UPDATE task_graph_runs SET status='completed',updated_at=?
        WHERE id=? AND revision=? AND status IN ('active','quiescent','blocked')`).run(at,runId,runRevision);
      if (changed.changes===1) this.drainTerminalOperations(runId,at);
    }
  }

  drainTerminalOperations(runId:string,at:number):void {
    const run=this.db.prepare("SELECT status FROM task_graph_runs WHERE id=?").get(runId) as Row|undefined;
    if (!run || !["completed","failed","cancelled"].includes(String(run.status))) return;
    this.db.prepare(`UPDATE task_verification_requests SET status='completed',result=(
        SELECT verification.result FROM task_verifications verification
        WHERE verification.run_id=task_verification_requests.run_id
        AND verification.producer_attempt_id=task_verification_requests.producer_attempt_id
        AND verification.verifier_attempt_id=task_verification_requests.verifier_attempt_id
        ORDER BY verification.created_at DESC,verification.id DESC LIMIT 1),updated_at=?
      WHERE run_id=? AND status IN ('pending','launching','running') AND EXISTS (
        SELECT 1 FROM task_verifications verification
        WHERE verification.run_id=task_verification_requests.run_id
        AND verification.producer_attempt_id=task_verification_requests.producer_attempt_id
        AND verification.verifier_attempt_id=task_verification_requests.verifier_attempt_id)`)
      .run(at,runId);
    this.db.prepare(`INSERT OR IGNORE INTO task_scheduler_outbox
      (id,run_id,attempt_id,generation,kind,payload_json,delivered_at,created_at)
      SELECT 'cancel:'||id||':'||generation,run_id,id,generation,'cancel_child',
        json_object('sessionRunKey',session_run_key),NULL,? FROM task_node_attempts
      WHERE run_id=? AND runtime<>'terminal' AND session_run_key IS NOT NULL
      UNION ALL SELECT 'cancel:'||verifier_attempt_id||':1',run_id,verifier_attempt_id,1,'cancel_child',
        json_object('sessionRunKey',verifier_run_key),NULL,? FROM task_verification_requests
      WHERE run_id=? AND status IN ('pending','launching','running') AND verifier_run_key IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM task_verifications verification
        WHERE verification.run_id=task_verification_requests.run_id
        AND verification.producer_attempt_id=task_verification_requests.producer_attempt_id
        AND verification.verifier_attempt_id=task_verification_requests.verifier_attempt_id)`)
      .run(at,runId,at,runId);
    this.db.prepare(`UPDATE task_scheduler_outbox SET delivered_at=? WHERE run_id=?
      AND delivered_at IS NULL AND kind<>'cancel_child'`).run(at,runId);
    this.db.prepare(`UPDATE task_node_attempts SET runtime='terminal',outcome='cancelled',
      terminal_witness_json=COALESCE(terminal_witness_json,?),updated_at=?
      WHERE run_id=? AND runtime<>'terminal'`)
      .run(JSON.stringify({source:"graph_terminal",status:String(run.status)}),at,runId);
    this.db.prepare(`UPDATE task_resource_reservations SET released_at=? WHERE run_id=?
      AND released_at IS NULL AND kind NOT LIKE 'budget_%' AND attempt_id IN
      (SELECT id FROM task_node_attempts WHERE run_id=? AND session_run_key IS NULL)`)
      .run(at,runId,runId);
    this.db.prepare(`UPDATE task_verification_requests SET status='failed',result='graph terminal',updated_at=?
      WHERE run_id=? AND status IN ('pending','launching','running')
      AND NOT EXISTS (SELECT 1 FROM task_verifications verification
        WHERE verification.run_id=task_verification_requests.run_id
        AND verification.producer_attempt_id=task_verification_requests.producer_attempt_id
        AND verification.verifier_attempt_id=task_verification_requests.verifier_attempt_id)`).run(at,runId);
    this.db.prepare(`UPDATE task_artifacts SET state='rejected' WHERE run_id=? AND state='staged'`).run(runId);
  }

  private duplicate(event: AttemptEvent): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM task_scheduler_events WHERE run_id=? AND idempotency_key=?").get(event.runId,event.idempotencyKey));
  }
  private assertAttempt(event: AttemptEvent, runtimes:string[]): {run:Row;attempt:Row} {
    const run = this.db.prepare("SELECT * FROM task_graph_runs WHERE id=?").get(event.runId) as Row | undefined;
    const attempt = this.db.prepare("SELECT * FROM task_node_attempts WHERE id=? AND run_id=?").get(event.attemptId,event.runId) as Row | undefined;
    if (!run || run.revision !== event.expectedRunRevision
      || !["active","quiescent","blocked"].includes(String(run.status))
      || !attempt || attempt.generation !== event.generation || !runtimes.includes(String(attempt.runtime))) {
      throw new TaskGraphConflictError("stale artifact attempt fence",run ?? null);
    }
    if (attempt.session_run_key && attempt.session_run_key !== event.actorSessionKey) {
      throw new TaskGraphConflictError("artifact actor session mismatch",run);
    }
    return { run,attempt };
  }
}

function canonicalRelativePath(candidate:string,label:string): string {
  const slashed=candidate.replaceAll("\\","/");
  const normalized=path.posix.normalize(slashed);
  if (!candidate || path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")
    || normalized !== slashed || /[*?\[\]{}]/.test(normalized)) {
    throw new TaskGraphValidationError(`${label} must be a canonical relative path`);
  }
  return normalized;
}
