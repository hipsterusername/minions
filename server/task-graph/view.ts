import {
  MAX_TASK_VIEW_BRIEF_ITEM_CHARS,
  MAX_TASK_VIEW_BRIEF_ITEMS,
  MAX_TASK_VIEW_CONTEXT_CHARS,
  MAX_TASK_VIEW_CONTEXT_ENTRIES,
  MAX_TASK_VIEW_OBJECTIVE_CHARS,
  MAX_TASK_VIEW_RESPONSE_CHARS,
  MAX_TASK_VIEW_SOURCE_ID_CHARS,
  taskGraphSnapshotViewSchema,
  type TaskGraphSnapshotView,
} from "../../shared/task-graph-view-contracts.ts";
import type { GraphSnapshot, TaskEdge, TaskNode } from "../../shared/task-graph-contracts.ts";
import type { NodeReadiness } from "./readiness.ts";
import {hasPassedVerificationTaskWitness} from "./verification-verdict.ts";
import {isAcceptedNodeAdjudication} from "./adjudication.ts";
import {hasRestrictedArtifactContent,projectVerificationSummary,redactTaskGraphPayload,
  redactTaskGraphText}
  from "./view-verification.ts";

type JsonRow = Record<string, unknown>;

const value = (row: JsonRow, snake: string, camel: string): unknown => row[snake] ?? row[camel];
const text = (row: JsonRow, snake: string, camel: string): string | null => {
  const candidate = value(row,snake,camel);
  return candidate == null ? null : String(candidate);
};
const number = (row: JsonRow, snake: string, camel: string): number | null => {
  const candidate = value(row,snake,camel);
  return candidate == null ? null : Number(candidate);
};
const iso = (at: number | null | undefined): string | undefined => at == null ? undefined : new Date(at).toISOString();
const bounded=(input:string,limit:number):string=>input.slice(0,limit);

export function projectTaskGraphSnapshot(
  snapshot: GraphSnapshot,
  readinessRows: readonly NodeReadiness[],
  now: number,
): TaskGraphSnapshotView {
  const attemptsByNode = new Map<string,JsonRow[]>();
  const attemptNode = new Map<string,string>();
  for (const attempt of snapshot.attempts) {
    const nodeId = text(attempt,"node_id","nodeId");
    const attemptId = text(attempt,"id","id");
    if (!nodeId || !attemptId) continue;
    attemptsByNode.set(nodeId,[...(attemptsByNode.get(nodeId) ?? []),attempt]);
    attemptNode.set(attemptId,nodeId);
  }
  for (const attempts of attemptsByNode.values()) attempts.sort((left,right) =>
    (number(left,"attempt_number","attemptNumber") ?? 0) - (number(right,"attempt_number","attemptNumber") ?? 0));
  const currentAttemptIdByNode = new Map([...attemptsByNode].map(([nodeId,attempts]) =>
    [nodeId,text(attempts.at(-1)!,"id","id")]));
  const artifactsByNode = new Map<string,JsonRow[]>();
  const artifactsByAttempt = new Map<string,JsonRow[]>();
  for (const artifact of snapshot.artifacts) {
    const nodeId = text(artifact,"node_id","nodeId");
    if (nodeId) artifactsByNode.set(nodeId,[...(artifactsByNode.get(nodeId) ?? []),artifact]);
    const attemptId=text(artifact,"producer_attempt_id","producerAttemptId");
    if (attemptId) artifactsByAttempt.set(attemptId,
      [...(artifactsByAttempt.get(attemptId)??[]),artifact]);
  }
  const invalidatedAttempts=new Set(snapshot.invalidations
    .map(row=>text(row,"invalidated_attempt_id","invalidatedAttemptId"))
    .filter((id):id is string=>id!==null));
  const usageByAttempt=new Map(snapshot.usage.map(row=>[
    text(row,"attempt_id","attemptId")??"",row,
  ]));
  const readinessByNode = new Map(readinessRows.map(row => [row.nodeId,row]));
  const contextByNode=new Map<string,GraphSnapshot["contextSources"]>();
  for (const source of snapshot.contextSources) contextByNode.set(source.nodeId,
    [...(contextByNode.get(source.nodeId)??[]),source]);
  const criticalPath = criticalPathNodeIds(snapshot.revision.nodes,snapshot.revision.edges,
    snapshot.revision.terminalNodeIds);
  const critical = new Set(criticalPath);
  const criticalEdges = new Set(criticalPath.slice(1).flatMap((target,index) =>
    snapshot.revision.edges.filter(edge => !edge.optional && edge.sourceNodeId === criticalPath[index]
      && edge.targetNodeId === target).map(edge => edge.id)));

  const nodes = snapshot.revision.nodes.map((node,index) => {
    const history = attemptsByNode.get(node.id) ?? [];
    const latest = history.at(-1) ?? null;
    const latestId = latest ? text(latest,"id","id") : null;
    const adjudicationRows=latestId?snapshot.adjudications.filter(row=>
      text(row,"node_id","nodeId")===node.id
      && text(row,"attempt_id","attemptId")===latestId):[];
    const adjudication=adjudicationRows.at(-1);
    const accepted=isAcceptedNodeAdjudication(adjudication,node,latest??undefined,
      snapshot.run.sourceSnapshotId);
    const stale=latestId?invalidatedAttempts.has(latestId):false;
    const artifacts = currentArtifacts(node.id,artifactsByNode,currentAttemptIdByNode,invalidatedAttempts);
    const verificationRows = latestId ? snapshot.verifications.filter(row =>
      text(row,"producer_attempt_id","producerAttemptId") === latestId && !stale) : [];
    const verification = verificationRows.at(-1);
    const verificationResult = verification ? text(verification,"result","result") : null;
    const verificationSummary = verification
      ? projectVerificationSummary(verification,artifacts):null;
    const verificationRequest = snapshot.verificationRequests
      .filter(row => text(row,"node_id","nodeId") === node.id).at(-1);
    const requestStatus = verificationRequest ? text(verificationRequest,"status","status") : null;
    const requiredOutputs = Object.keys(node.outputSchemas);
    const hasOutputs = requiredOutputs.every(name => artifacts.some(row => text(row,"output_name","outputName") === name));
    const verified = !node.verificationRequired || accepted
      || verificationResult === "passed" || verificationResult === "waived";
    const completionPassed=node.completionMode!=="verification" || accepted
      || Boolean(latest && hasPassedVerificationTaskWitness(latest));
    const executionPassed=accepted || text(latest??{},"outcome","outcome") === "succeeded";
    const satisfied = latest ? !stale && executionPassed
      && completionPassed && hasOutputs && verified : false;
    const latestOutcome = latest ? text(latest,"outcome","outcome") : null;
    const invalidCompletion=!accepted && latestOutcome!==null && !completionPassed;
    const unsuccessful = latestOutcome === "failed" || latestOutcome === "cancelled"
      || latestOutcome === "lost" || latestOutcome === "superseded" || invalidCompletion;
    const ready = readinessByNode.get(node.id);
    const graphCancelled = snapshot.run.status === "cancelled";
    const logicalState = satisfied ? "succeeded" as const
      : stale ? "invalidated" as const
      : graphCancelled ? "cancelled" as const
      : ready?.ready ? "pending" as const
      : unsuccessful && ready?.reason === "attempts_exhausted" ? "exhausted" as const
      : unsuccessful && ready?.reason === "outcome_not_retryable"
        ? latestOutcome === "cancelled" ? "cancelled" as const : "failed" as const
      : invalidCompletion ? "failed" as const
      : "pending" as const;
    const currentRuntime = latest ? text(latest,"runtime","runtime") : null;
    const readiness = ready?.ready ? "ready" as const
      : currentRuntime && currentRuntime !== "terminal" ? "claimed" as const
      : logicalState !== "pending" && logicalState !== "invalidated"
        ? "terminal" as const : "not_ready" as const;
    const currentAttempt = latest ? projectAttempt(latest,node.executorClass,now,
      usageByAttempt.get(latestId??""),node.completionMode==="verification",
      hasRestrictedArtifactContent(artifactsByAttempt.get(latestId??"")??[])) : null;
    const waitingForHuman = snapshot.revision.edges.some(edge => edge.targetNodeId === node.id
      && edge.kind === "human_gate" && !snapshot.edgeEvaluations.some(row =>
        text(row,"edge_id","edgeId") === edge.id && Boolean(value(row,"satisfied","satisfied"))));
    const verificationBlocker=verificationResult==="failed"
      ? {category:"policy" as const,explanation:verificationSummary
        ? `Independent verification rejected the output: ${verificationSummary}`
        : "Independent verification rejected the output"}
      : verificationResult==="inconclusive"
        ? {category:"policy" as const,explanation:"Independent verification was inconclusive"}:null;
    const completionBlocker=invalidCompletion
      ? {category:"policy" as const,explanation:"Verification needs Leader adjudication or a guided retry"}:null;
    const blocker = waitingForHuman ? { category:"input" as const,explanation:"Waiting for required human input" }
      : completionBlocker??verificationBlocker??projectBlocker(ready?.reason,currentAttempt?.state ?? null);
    const inputIds = snapshot.revision.edges.filter(edge => edge.targetNodeId === node.id)
      .flatMap(edge => currentArtifacts(edge.sourceNodeId,artifactsByNode,currentAttemptIdByNode,invalidatedAttempts)
        .filter(row => !edge.sourceOutput || text(row,"output_name","outputName") === edge.sourceOutput)
        .map(row => text(row,"id","id")).filter((id): id is string => id !== null));
    const ownership = node.ownershipRequest.map(scope => scope.normalizedValue)
      .filter(Boolean).join(", ");
    const logs = snapshot.events.filter(event => event.objectId === latestId || attemptNode.get(event.objectId) === node.id)
      .slice(-50).map(event => `${event.type}: ${summarizePayload(event.payload)}`);
    return {
      id:node.id,title:node.title,
      objective:bounded(node.objective,MAX_TASK_VIEW_OBJECTIVE_CHARS),
      constraints:node.constraints.slice(0,MAX_TASK_VIEW_BRIEF_ITEMS)
        .map(item=>bounded(item,MAX_TASK_VIEW_BRIEF_ITEM_CHARS)),
      acceptanceCriteria:node.acceptanceCriteria.slice(0,MAX_TASK_VIEW_BRIEF_ITEMS)
        .map(item=>bounded(item,MAX_TASK_VIEW_BRIEF_ITEM_CHARS)),
      context:(contextByNode.get(node.id)??[]).slice(0,MAX_TASK_VIEW_CONTEXT_ENTRIES)
        .map(projectContextSource),
      kind:node.expansionPolicy ? "map" as const
        : snapshot.revision.terminalNodeIds.includes(node.id) ? "terminal" as const : "task" as const,
      completionMode:node.completionMode??"task",
      groupId:`executor:${node.executorClass}`,logicalState,readiness,currentAttempt,
      attemptHistory:history.map(row => projectAttempt(row,node.executorClass,now,
        usageByAttempt.get(text(row,"id","id")??""),node.completionMode==="verification",
        hasRestrictedArtifactContent(artifactsByAttempt.get(text(row,"id","id")??"")??[]))),
      verification:{ state:node.verificationRequired
        ? verificationResult === "passed" ? "passed" as const
          : verificationResult === "failed" ? "failed" as const
          : verificationResult === "waived" ? "waived" as const
            : verificationResult === "inconclusive" ? "failed" as const
            : requestStatus === "failed" ? "failed" as const : "pending" as const
        : "not_required" as const,
        ...(verification ? { verifierAttemptId:text(verification,"verifier_attempt_id","verifierAttemptId") ?? undefined } : {}),
        evidenceIds:verificationRows.map(row => text(row,"id","id")).filter((id):id is string => id !== null),
        ...(verificationSummary ? {explanation:verificationSummary}
          : verificationResult === "inconclusive"
          ? { explanation:"Independent verifier could not produce a conclusive verdict" }
          : !verificationResult && requestStatus === "failed"
            ? { explanation:"Independent verifier failed to produce a valid verdict" } : {}),
      },
      adjudication:adjudication?{
        decision:text(adjudication,"decision","decision") as "accepted"|"rejected"|"retry",
        attemptId:text(adjudication,"attempt_id","attemptId")!,
        actor:bounded(text(adjudication,"actor","actor")??"unknown",256),
        reason:bounded(text(adjudication,"reason","reason")??"No reason recorded",2_000),
        ...(text(adjudication,"guidance","guidance")
          ? {guidance:bounded(text(adjudication,"guidance","guidance")!,4_000)}:{}),
        createdAt:iso(number(adjudication,"created_at","createdAt"))!,
      }:null,
      blocker,priority:snapshot.revision.nodes.length-index,
      ...(latest ? {} : { queueAgeMs:Math.max(0,snapshot.run.updatedAt-snapshot.run.createdAt) }),
      ...(latest && number(latest,"backoff_until","backoffUntil") != null
        ? { backoffUntil:iso(number(latest,"backoff_until","backoffUntil")) } : {}),
      estimatedDurationMs:node.timeoutMs,
      costUsd:snapshot.usage.filter(row=>text(row,"node_id","nodeId")===node.id)
        .reduce((sum,row)=>sum+(number(row,"cost_usd","costUsd")??0),0),
      tokens:snapshot.usage.filter(row=>text(row,"node_id","nodeId")===node.id)
        .reduce((sum,row)=>sum+(number(row,"tokens","tokens")??0),0),
      criticalPath:critical.has(node.id),stale,
      inputIds:[...new Set(inputIds)],
      outputArtifactIds:artifacts.map(row => text(row,"id","id")).filter((id):id is string => id !== null),
      ...(ownership ? { owner:ownership } : {}),budgetReservedUsd:budgetMicros(node.budgetRequest)/1_000_000,
      ...(logs.length ? { logs } : {}),
    };
  });

  const edgeEvaluation = new Map(snapshot.edgeEvaluations.map(row => [text(row,"edge_id","edgeId"),Boolean(value(row,"satisfied","satisfied"))]));
  const nodeState = new Map(nodes.map(node => [node.id,node.logicalState]));
  const terminalUnsuccessful = new Set(["failed","exhausted","cancelled"]);
  const edges = snapshot.revision.edges.map(edge => ({ id:edge.id,source:edge.sourceNodeId,target:edge.targetNodeId,
    type:edge.kind === "verified_artifact" ? "verification" as const
      : edge.kind === "artifact" ? "data" as const : "depends_on" as const,
    state:edgeEvaluation.get(edge.id) === false && terminalUnsuccessful.has(nodeState.get(edge.sourceNodeId) ?? "")
      ? "failure" as const : criticalEdges.has(edge.id) ? "critical" as const : "ordinary" as const }));
  const costByNode = new Map(nodes.map(node => [node.id,node.costUsd]));
  const groups = [...new Set(snapshot.revision.nodes.map(node => node.executorClass))].map(executorClass => ({
    id:`executor:${executorClass}`,title:executorClass,kind:"stage" as const,
    nodeIds:snapshot.revision.nodes.filter(node => node.executorClass === executorClass).map(node => node.id),
    costUsd:snapshot.revision.nodes.filter(node => node.executorClass === executorClass)
      .reduce((sum,node) => sum+(costByNode.get(node.id) ?? 0),0),
  }));
  const evidence = snapshot.artifacts.filter(row => text(row,"state","state") === "committed").map(artifact => {
    const nodeId = text(artifact,"node_id","nodeId") ?? "";
    const producerAttemptId = text(artifact,"producer_attempt_id","producerAttemptId") ?? "unknown";
    const verification = snapshot.verifications.find(row => text(row,"producer_attempt_id","producerAttemptId") === producerAttemptId);
    const result = verification ? text(verification,"result","result") : null;
    const stale=invalidatedAttempts.has(producerAttemptId)
      || currentAttemptIdByNode.get(nodeId) !== producerAttemptId;
    return { id:`lineage:${text(artifact,"id","id")}`,sourceSnapshot:text(artifact,"source_snapshot_id","sourceSnapshotId") ?? snapshot.run.sourceSnapshotId,
      producerAttemptId,artifactId:text(artifact,"id","id") ?? "unknown",
      ...(verification ? { verifierAttemptId:text(verification,"verifier_attempt_id","verifierAttemptId") ?? undefined } : {}),
      consumerNodeIds:snapshot.revision.edges.filter(edge => edge.sourceNodeId === nodeId).map(edge => edge.targetNodeId),
      status:stale ? "stale" as const : result === "passed" ? "passed" as const : result === "failed" ? "failed" as const
        : result === "waived" ? "waived" as const : "pending" as const };
  });
  const timeline = snapshot.events.map(event => ({ id:`event:${event.sequence}`,at:new Date(event.createdAt).toISOString(),
    type:eventType(event.type),summary:`${event.type.replaceAll("_"," ")} ${summarizePayload(event.payload)}`.trim(),
    ...(attemptNode.get(event.objectId) ? { nodeId:attemptNode.get(event.objectId) } :
      snapshot.revision.nodes.some(node => node.id === event.objectId) ? { nodeId:event.objectId } : {}),
    ...(attemptNode.has(event.objectId) ? { attemptId:event.objectId } : {}),
  }));
  const running = snapshot.attempts.filter(row => text(row,"runtime","runtime") !== "terminal").length;
  const actualCost=snapshot.usage.reduce((sum,row)=>sum+(number(row,"cost_usd","costUsd")??0),0);
  const actualTokens=snapshot.usage.reduce((sum,row)=>sum+(number(row,"tokens","tokens")??0),0);
  const satisfiedIds = new Set(nodes.filter(node => node.logicalState === "succeeded").map(node => node.id));
  const estimatedRemainingMs = criticalPath.filter(id => !satisfiedIds.has(id))
    .reduce((sum,id) => sum+(snapshot.revision.nodes.find(node => node.id === id)?.timeoutMs ?? 0),0);
  return taskGraphSnapshotViewSchema.parse({ graphRunId:snapshot.run.id,revision:snapshot.run.revision,
    title:snapshot.revision.objective,status:runStatus(snapshot),updatedAt:new Date(snapshot.run.updatedAt).toISOString(),
    nodes,edges,groups,evidence,timeline,capacity:{ running,limit:snapshot.run.maxActiveAttempts },
    budget:{ spentUsd:actualCost,
      limitUsd:snapshot.revision.budgetLimits?.costMicrosLimit == null
        ? null : snapshot.revision.budgetLimits.costMicrosLimit/1_000_000,tokens:actualTokens },
    criticalPath:{ nodeIds:criticalPath,observedMs:Math.max(0,snapshot.run.updatedAt-snapshot.run.createdAt),estimatedRemainingMs },
  });
}

function projectAttempt(row:JsonRow,executor:string,now:number,usage?:JsonRow,
  verdictRequired=false,withholdText=false) {
  const runtime = text(row,"runtime","runtime");
  const outcome = text(row,"outcome","outcome");
  const backoffUntil = number(row,"backoff_until","backoffUntil");
  const effectiveSuccess=outcome==="succeeded"
    && (!verdictRequired || hasPassedVerificationTaskWitness(row));
  const state = runtime === "terminal" ? effectiveSuccess ? "succeeded" as const
    : outcome === "cancelled" ? "cancelled" as const
      : outcome === "superseded" ? "superseded" as const
      : backoffUntil && backoffUntil > now ? "backoff" as const : "failed" as const
    : runtime === "running" ? "running" as const : runtime === "waiting" ? "blocked" as const : "queued" as const;
  const created = number(row,"created_at","createdAt");
  const updated = number(row,"updated_at","updatedAt");
  const rawResponse=text(row,"final_report","finalReport")?.trim();
  const response=rawResponse && !withholdText ? redactTaskGraphText(rawResponse):null;
  return { id:text(row,"id","id")!,number:number(row,"attempt_number","attemptNumber") ?? 1,state,executor,
    ...(text(row,"session_run_key","sessionRunKey") ? { sessionId:text(row,"session_run_key","sessionRunKey")! } : {}),
    ...(iso(created) ? { startedAt:iso(created)! } : {}),
    ...(runtime === "terminal" && iso(updated) ? { finishedAt:iso(updated)! } : {}),
    costUsd:number(usage??{},"cost_usd","costUsd")??0,
    tokens:number(usage??{},"tokens","tokens")??0,
    ...(!withholdText && value(row,"terminal_witness_json","terminalWitness")
      ? { summary:summarizePayload(value(row,"terminal_witness_json","terminalWitness")) } : {}),
    ...(response ? {response:bounded(response,MAX_TASK_VIEW_RESPONSE_CHARS)} : {}),
  };
}

function projectContextSource(source:GraphSnapshot["contextSources"][number]) {
  const sourceId=safeSourceId(source.sourceId,source.contentHash);
  if (source.classification==="public" || source.classification==="internal") return {
    sourceId,contentHash:source.contentHash,classification:source.classification,
    content:bounded(source.content,MAX_TASK_VIEW_CONTEXT_CHARS),
  };
  return {sourceId,contentHash:source.contentHash,
    classification:source.classification==="secret"?"secret" as const:"sensitive" as const,
    withheld:true as const};
}

function safeSourceId(sourceId:string,contentHash:string):string {
  const looksLikeStoragePath=sourceId.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(sourceId)
    || sourceId.startsWith("file://");
  return looksLikeStoragePath ? `source:${contentHash.slice("sha256:".length,"sha256:".length+12)}`
    : bounded(sourceId,MAX_TASK_VIEW_SOURCE_ID_CHARS)||"context";
}

function projectBlocker(reason: string | undefined, attemptState: string | null) {
  if (attemptState === "running" || !reason || reason === "ready" || reason === "attempt_active") return null;
  const category = reason.startsWith("join_unsatisfied") ? "dependency" as const
    : reason === "retry_backoff" ? "backoff" as const
      : reason.startsWith("budget_") ? "budget" as const
        : reason === "ownership_conflict" || reason === "attempts_exhausted" || reason === "outcome_not_retryable"
          || reason === "graph_paused"
          || reason === "termination_pending"
          ? "policy" as const : "capacity" as const;
  return { category, explanation:reason.replaceAll("_"," ") };
}

function runStatus(snapshot: GraphSnapshot) {
  if (snapshot.run.status === "completed") return "completed" as const;
  if (snapshot.run.status === "failed") return "failed" as const;
  if (snapshot.run.status === "cancelled") return "cancelled" as const;
  if (snapshot.run.status === "blocked") return "blocked" as const;
  if (snapshot.run.paused) return "paused" as const;
  return snapshot.run.status === "quiescent" ? "quiescent" as const : "running" as const;
}

function eventType(type: string) {
  if (type.includes("recover") || type.includes("lost")) return "recovery" as const;
  if (type.includes("dispatch")) return "dispatch" as const;
  if (type.includes("progress") || type.includes("terminal")) return "progress" as const;
  if (type.includes("retry")) return "retry" as const;
  if (type.includes("waiv") || type.includes("adjudicat")) return "waiver" as const;
  if (type.includes("artifact") || type.includes("verification")) return "invalidation" as const;
  if (type.includes("steer") || type.includes("pause") || type.includes("resume")
    || type.includes("cancel")) return "steering" as const;
  return "claim" as const;
}

function summarizePayload(payload: unknown): string {
  let rendered:string;
  if (payload == null) rendered="";
  else if (typeof payload === "string") rendered=redactTaskGraphText(payload);
  else {
    try { rendered=JSON.stringify(redactTaskGraphPayload(payload)); }
    catch { rendered=String(payload); }
  }
  return redactTaskGraphText(rendered.length>180?`${rendered.slice(0,177)}...`:rendered);
}

function budgetMicros(request: Record<string,unknown>): number {
  const raw = request["costMicros"] ?? request["maxCostMicros"] ?? 0;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function currentArtifacts(nodeId:string,artifactsByNode:Map<string,JsonRow[]>,
  currentAttemptIdByNode:Map<string,string|null>,invalidatedAttempts:Set<string>):JsonRow[] {
  const currentAttemptId=currentAttemptIdByNode.get(nodeId);
  if (!currentAttemptId) return [];
  return (artifactsByNode.get(nodeId) ?? []).filter(row => text(row,"state","state") === "committed"
    && text(row,"producer_attempt_id","producerAttemptId") === currentAttemptId
    && !invalidatedAttempts.has(currentAttemptId));
}

function criticalPathNodeIds(nodes: TaskNode[], edges: TaskEdge[], terminalNodeIds: string[]): string[] {
  const incoming = new Map<string,string[]>();
  const duration = new Map(nodes.map(node => [node.id,node.timeoutMs]));
  for (const node of nodes) incoming.set(node.id,[]);
  for (const edge of edges) if (!edge.optional) {
    incoming.set(edge.targetNodeId,[...(incoming.get(edge.targetNodeId) ?? []),edge.sourceNodeId]);
  }
  const memo = new Map<string,{ path:string[];duration:number }>();
  const visit = (id:string): { path:string[];duration:number } => {
    const cached = memo.get(id); if (cached) return cached;
    const parents = incoming.get(id) ?? [];
    const prefix = parents.map(visit).sort((left,right) => right.duration-left.duration)[0]
      ?? {path:[],duration:0};
    const result = {path:[...prefix.path,id],duration:prefix.duration+(duration.get(id) ?? 0)};
    memo.set(id,result); return result;
  };
  return terminalNodeIds.map(visit).sort((left,right) => right.duration-left.duration)[0]?.path ?? [];
}
