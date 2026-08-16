import type Database from "better-sqlite3";
import type { GraphRevisionInput, TaskNode } from "../../shared/task-graph-contracts.ts";

type Row = Record<string, unknown>;
export interface NodeReadiness { nodeId: string; ready: boolean; reason: string; }

export function readiness(db: Database.Database, runId: string, revision: GraphRevisionInput, now: number): NodeReadiness[] {
  const attempts = db.prepare("SELECT * FROM task_node_attempts WHERE run_id=? ORDER BY attempt_number DESC").all(runId) as Row[];
  const byNode = new Map<string, Row[]>();
  for (const attempt of attempts) byNode.set(String(attempt.node_id), [...(byNode.get(String(attempt.node_id)) ?? []), attempt]);
  const evaluations = new Map((db.prepare("SELECT * FROM task_edge_evaluations WHERE run_id=?").all(runId) as Row[])
    .map(row => [String(row.edge_id), Boolean(row.satisfied)]));
  const joins = new Map((db.prepare("SELECT * FROM task_frozen_joins WHERE run_id=?").all(runId) as Row[])
    .map(row => [String(row.node_id),row]));
  const retryGrants = new Map((db.prepare("SELECT node_id,remaining FROM task_manual_retry_grants WHERE run_id=?")
    .all(runId) as Row[]).map(row => [String(row.node_id),Number(row.remaining)]));
  const terminationPending=new Set((db.prepare(`SELECT DISTINCT a.node_id FROM task_scheduler_outbox o
    JOIN task_node_attempts a ON a.id=o.attempt_id
    WHERE o.run_id=? AND o.kind='cancel_child' AND o.delivered_at IS NULL`).all(runId) as Row[])
    .map(row=>String(row.node_id)));
  const invalidatedAttempts=new Set((db.prepare(`SELECT invalidated_attempt_id FROM task_node_invalidations
    WHERE run_id=? AND invalidated_attempt_id IS NOT NULL`).all(runId) as Row[])
    .map(row=>String(row.invalidated_attempt_id)));
  return revision.nodes.map(node => assess(node, revision, byNode.get(node.id) ?? [], evaluations,
    joins.get(node.id),retryGrants.get(node.id)??0,terminationPending.has(node.id),
    invalidatedAttempts,now));
}

function assess(node: TaskNode, revision: GraphRevisionInput, attempts: Row[], edges: Map<string, boolean>,
  join: Row|undefined,manualRetries:number,terminationPending:boolean,
  invalidatedAttempts:Set<string>,now:number):NodeReadiness {
  const current = attempts[0];
  if (current && current.runtime !== "terminal") return { nodeId: node.id, ready: false, reason: "attempt_active" };
  if (terminationPending) return {nodeId:node.id,ready:false,reason:"termination_pending"};
  if (current?.outcome === "succeeded" && !invalidatedAttempts.has(String(current.id))) {
    return {nodeId:node.id,ready:false,reason:"attempt_succeeded_pending_satisfaction"};
  }
  if (current && current.outcome!=="none" && current.outcome!=="succeeded"
    && current.outcome!=="superseded"
    && !node.retryPolicy.retryableOutcomes.includes(current.outcome as "failed"|"lost"|"cancelled")
    && manualRetries<1) {
    return {nodeId:node.id,ready:false,reason:"outcome_not_retryable"};
  }
  if (current && Number(current.attempt_number) >= node.retryPolicy.maxAttempts && manualRetries < 1) {
    return { nodeId: node.id, ready: false, reason: "attempts_exhausted" };
  }
  if (current?.backoff_until && Number(current.backoff_until) > now) return { nodeId: node.id, ready: false, reason: "retry_backoff" };
  const incoming = revision.edges.filter(edge => edge.targetNodeId === node.id && !edge.optional);
  const policy = String(join?.policy ?? "all_success");
  const cohort = policy === "quorum" ? frozenCohort(join) : [];
  const satisfied = policy === "quorum"
    ? cohort.filter(member => {
      const memberEdges = incoming.filter(edge => edge.sourceNodeId === member);
      return memberEdges.length > 0 && memberEdges.every(edge => edges.get(edge.id) === true);
    }).length
    : incoming.filter(edge => edges.get(edge.id) === true).length;
  const required = policy === "any_success" ? Math.min(1,incoming.length)
    : policy === "quorum" ? Number(join?.quorum ?? cohort.length) : incoming.length;
  if (satisfied < required) return { nodeId: node.id, ready: false, reason: `join_unsatisfied:${satisfied}/${required}` };
  return { nodeId: node.id, ready: true, reason: "ready" };
}

function frozenCohort(join: Row|undefined): string[] {
  const parsed = JSON.parse(String(join?.cohort_json ?? "[]")) as unknown;
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.filter((member): member is string => typeof member === "string"))];
}
