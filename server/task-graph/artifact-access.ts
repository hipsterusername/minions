import type { TaskGraphService } from "./service.ts";
import { TaskGraphConflictError,TaskGraphValidationError } from "./errors.ts";
import { readStoredTaskGraphArtifact } from "./artifact-store.ts";
import {effectiveAttemptSuccessSql} from "./adjudication.ts";

type Row=Record<string,unknown>;

export interface TaskGraphArtifactReference {
  artifactId:string;
  inputName:string|null;
  outputName:string;
  contentHash:string;
  schemaName:string;
  schemaVersion:string;
  classification:"public"|"internal"|"sensitive"|"secret";
  byteSize:number;
  producerAttemptId:string;
  sourceSnapshotId:string;
}

interface AuthorizedArtifact { row:Row;reference:TaskGraphArtifactReference;contracts?:unknown[] }

/** Return prompt-safe metadata for only the immutable inputs authorized to this session. */
export function taskGraphArtifactsForSession(
  service:TaskGraphService,
  sessionRunKey:string,
):TaskGraphArtifactReference[] {
  return authorizedArtifacts(service,sessionRunKey).map(item=>item.reference);
}

/** Re-authorize on every read so cancellation or steering immediately fences stale sessions. */
export function readTaskGraphArtifactForSession(service:TaskGraphService,sessionRunKey:string,input:{
  artifactId:string;offset:number;maxBytes:number;
}) {
  const authorized=authorizedArtifacts(service,sessionRunKey)
    .find(item=>item.reference.artifactId===input.artifactId);
  if (!authorized) throw new TaskGraphConflictError("artifact is not an active input for this session");
  if (authorized.reference.classification==="secret") {
    throw new TaskGraphValidationError("secret artifacts cannot be copied into agent context");
  }
  const metadata=metadataOf(authorized.row);
  const storageRef=metadata["storageRef"];
  if (typeof storageRef!=="string") throw new TaskGraphValidationError("artifact storage is unavailable");
  for (const contract of authorized.contracts ?? []) readStoredTaskGraphArtifact({storageRef,
    contentHash:authorized.reference.contentHash,byteSize:authorized.reference.byteSize,
    offset:0,maxBytes:1,contract});
  return {...authorized.reference,...readStoredTaskGraphArtifact({storageRef,
    contentHash:authorized.reference.contentHash,byteSize:authorized.reference.byteSize,
    offset:input.offset,maxBytes:input.maxBytes})};
}

export function safeArtifactReference(row:Row,inputName:string|null=null):TaskGraphArtifactReference {
  const metadata=metadataOf(row);
  const classification=metadata["classification"];
  if (classification!=="public" && classification!=="internal"
    && classification!=="sensitive" && classification!=="secret") {
    throw new TaskGraphValidationError("artifact classification is invalid");
  }
  return {artifactId:String(row["id"]),inputName,outputName:String(row["output_name"]),
    contentHash:String(row["content_hash"]),schemaName:String(metadata["schemaName"]),
    schemaVersion:String(metadata["schemaVersion"]),classification,
    byteSize:Number(metadata["byteSize"]),producerAttemptId:String(row["producer_attempt_id"]),
    sourceSnapshotId:String(row["source_snapshot_id"])};
}

function authorizedArtifacts(service:TaskGraphService,sessionRunKey:string):AuthorizedArtifact[] {
  const attempt=service.options.db.prepare(`SELECT a.*,g.revision_id,g.source_snapshot_id run_source_snapshot_id
    FROM task_node_attempts a JOIN task_graph_runs g ON g.id=a.run_id
    LEFT JOIN sessions s ON s.attempt_id=a.id AND s.work_item_id=g.work_item_id
    WHERE (a.session_run_key=? OR s.session_key=?) AND a.runtime IN ('dispatching','running','waiting')
    AND g.status IN ('active','quiescent','blocked') LIMIT 1`).get(sessionRunKey,sessionRunKey) as Row|undefined;
  if (attempt) return attemptInputs(service,attempt);
  const verifier=service.options.db.prepare(`SELECT r.*,g.source_snapshot_id run_source_snapshot_id
    FROM task_verification_requests r JOIN task_graph_runs g ON g.id=r.run_id
    LEFT JOIN sessions s ON s.attempt_id=r.verifier_attempt_id AND s.work_item_id=g.work_item_id
    WHERE (r.verifier_run_key=? OR s.session_key=?) AND r.status IN ('launching','running')
    AND g.status IN ('active','quiescent','blocked') LIMIT 1`).get(sessionRunKey,sessionRunKey) as Row|undefined;
  return verifier?verifierInputs(service,verifier):[];
}

function attemptInputs(service:TaskGraphService,attempt:Row):AuthorizedArtifact[] {
  const spec=service.repo.getRevision(String(attempt["revision_id"]));
  const edges=spec.edges.filter(edge=>edge.targetNodeId===attempt["node_id"]
    && (edge.kind==="artifact" || edge.kind==="verified_artifact"));
  const results:AuthorizedArtifact[]=[];
  for (const edge of edges) {
    const evaluation=service.options.db.prepare(`SELECT satisfied FROM task_edge_evaluations
      WHERE run_id=? AND edge_id=?`).get(attempt["run_id"],edge.id) as Row|undefined;
    if (!evaluation || !Boolean(evaluation["satisfied"])) continue;
    const row=service.options.db.prepare(`SELECT ar.* FROM task_artifacts ar
      JOIN task_node_attempts producer ON producer.id=ar.producer_attempt_id
      WHERE ar.run_id=? AND ar.node_id=? AND ar.output_name=? AND ar.state='committed'
      AND ar.source_snapshot_id=? AND producer.runtime='terminal'
      AND ${effectiveAttemptSuccessSql("producer")}
      AND NOT EXISTS (SELECT 1 FROM task_node_invalidations i WHERE i.run_id=ar.run_id
        AND i.invalidated_attempt_id=ar.producer_attempt_id)
      AND NOT EXISTS (SELECT 1 FROM task_node_attempts newer WHERE newer.run_id=producer.run_id
        AND newer.node_id=producer.node_id AND newer.attempt_number>producer.attempt_number)
      ORDER BY ar.committed_at DESC,ar.id DESC LIMIT 1`).get(attempt["run_id"],edge.sourceNodeId,
      edge.sourceOutput,attempt["run_source_snapshot_id"]) as Row|undefined;
    const consumer = spec.nodes.find(node => node.id === edge.targetNodeId);
    if (row) results.push({row,reference:safeArtifactReference(row,edge.targetInput),
      contracts: [consumer?.inputBindings[edge.targetInput!]]});
  }
  return uniqueArtifacts(results);
}

function verifierInputs(service:TaskGraphService,request:Row):AuthorizedArtifact[] {
  const invalidated=service.options.db.prepare(`SELECT 1 FROM task_node_invalidations
    WHERE run_id=? AND invalidated_attempt_id=? LIMIT 1`)
    .get(request["run_id"],request["producer_attempt_id"]);
  if (invalidated) return [];
  const rows=service.options.db.prepare(`SELECT * FROM task_artifacts WHERE run_id=?
    AND producer_attempt_id=? AND source_snapshot_id=? AND state='committed'
    ORDER BY output_name,id`).all(request["run_id"],request["producer_attempt_id"],
    request["run_source_snapshot_id"]) as Row[];
  return rows.map(row=>({row,reference:safeArtifactReference(row)}));
}

function uniqueArtifacts(items:AuthorizedArtifact[]):AuthorizedArtifact[] {
  const seen=new Map<string,AuthorizedArtifact>();
  for (const item of items) {
    const prior=seen.get(item.reference.artifactId);
    if (prior) prior.contracts=[...(prior.contracts??[]),...(item.contracts??[])];
    else seen.set(item.reference.artifactId,item);
  }
  return [...seen.values()];
}

function metadataOf(row:Row):Row {
  const raw=row["metadata_json"];
  if (raw && typeof raw==="object") return raw as Row;
  try { return JSON.parse(String(raw)) as Row; }
  catch { throw new TaskGraphValidationError("artifact metadata is invalid"); }
}
