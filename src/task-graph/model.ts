import type {
  GraphFilter,
  GraphPlanItem,
  TaskGraphEdgeView,
  TaskGraphNodeView,
  TaskGraphSnapshotView,
} from "./types.ts";

export const MAX_TOPOLOGY_NODES = 72;
export const MAX_TOPOLOGY_EDGES = 96;
export const WORK_QUEUE_ROW_HEIGHT = 58;
export const WORK_QUEUE_OVERSCAN = 4;

export function matchesGraphFilter(node: TaskGraphNodeView, filter: GraphFilter): boolean {
  switch (filter) {
    case "all": return true;
    case "active": return node.currentAttempt?.state === "running" || node.readiness === "ready" || node.criticalPath;
    case "attention": return node.logicalState === "failed" || node.logicalState === "exhausted"
      || node.logicalState === "not_run"
      || node.currentAttempt?.state === "failed"
      || (!!node.blocker && node.blocker.category !== "none")
      || ["pending", "failed", "stale"].includes(node.verification.state);
    case "ready": return node.readiness === "ready";
    case "blocked": return !!node.blocker && node.blocker.category !== "none";
    case "failed": return node.logicalState === "failed" || node.logicalState === "exhausted"
      || node.logicalState === "not_run" || node.currentAttempt?.state === "failed";
    case "unverified": return node.verification.state === "pending" || node.verification.state === "failed" || node.verification.state === "stale";
    case "expensive": return node.costUsd > 0;
    case "stale": return node.stale;
    case "critical": return node.criticalPath;
  }
}

export function filterNodes(nodes: TaskGraphNodeView[], filter: GraphFilter): TaskGraphNodeView[] {
  const filtered = nodes.filter((node) => matchesGraphFilter(node, filter));
  return filter === "expensive" ? filtered.toSorted((a, b) => b.costUsd - a.costUsd) : filtered;
}

export function whyNotRunning(node: TaskGraphNodeView): string {
  if (node.currentAttempt?.state === "running") return "Running now";
  if (node.logicalState !== "pending") return `Logical task is ${node.logicalState}`;
  if (node.blocker?.explanation) return node.blocker.explanation;
  if (node.blocker && node.blocker.category !== "none") return `Blocked by ${node.blocker.category}`;
  if (node.readiness === "ready") return "Ready; waiting for executor capacity";
  if (node.readiness === "claimed") return "Claimed; dispatch pending";
  return "Waiting for dependencies to become eligible";
}

export interface TopologyProjection {
  nodes: TaskGraphNodeView[];
  edges: TaskGraphEdgeView[];
  hiddenNodeCount: number;
  hiddenEdgeCount: number;
}

export function projectTopology(snapshot: TaskGraphSnapshotView, filter: GraphFilter, selectedNodeId: string | null): TopologyProjection {
  const candidates = filterNodes(snapshot.nodes, filter);
  const ranked = candidates.toSorted((a, b) => Number(b.criticalPath) - Number(a.criticalPath) || b.priority - a.priority || a.id.localeCompare(b.id));
  const nodes = ranked.slice(0, MAX_TOPOLOGY_NODES);
  const visible = new Set(nodes.map((node) => node.id));
  const showOrdinaryEdges = nodes.length <= 36;
  const semanticEdges = snapshot.edges.filter((edge) =>
    visible.has(edge.source) && visible.has(edge.target) &&
    (showOrdinaryEdges || edge.state !== "ordinary" || edge.source === selectedNodeId || edge.target === selectedNodeId),
  );
  const edges = semanticEdges.slice(0, MAX_TOPOLOGY_EDGES);
  return {
    nodes,
    edges,
    hiddenNodeCount: Math.max(0, candidates.length - nodes.length),
    hiddenEdgeCount: Math.max(0, semanticEdges.length - edges.length),
  };
}

export function nodesForPlanItem(
  nodes: readonly TaskGraphNodeView[],
  planItem: GraphPlanItem,
): TaskGraphNodeView[] {
  return nodes.filter((node) =>
    node.id === planItem.taskId
    || (!!planItem.minionSessionKey && node.currentAttempt?.sessionId === planItem.minionSessionKey),
  );
}

export function nodeIdsForPlanItem(
  nodes: readonly TaskGraphNodeView[],
  planItem: GraphPlanItem | null | undefined,
): Set<string> {
  return new Set(planItem ? nodesForPlanItem(nodes, planItem).map((node) => node.id) : []);
}

export function evidenceForNodes(snapshot: TaskGraphSnapshotView, nodes: readonly TaskGraphNodeView[]) {
  const attemptIds = new Set(nodes.flatMap((node) => node.attemptHistory.map((attempt) => attempt.id)));
  return snapshot.evidence.filter((item) => attemptIds.has(item.producerAttemptId));
}

export function runtimeRole(node: TaskGraphNodeView, plan: readonly GraphPlanItem[] = []) {
  const planItem = plan.find((item) =>
    item.taskId === node.id
    || (!!item.minionSessionKey && item.minionSessionKey === node.currentAttempt?.sessionId),
  );
  if (planItem?.executor === "leader" || node.kind === "map" || node.kind === "stage") return "leader" as const;
  if (node.kind === "reducer") return "checkpoint" as const;
  if (node.kind === "terminal") return "outcome" as const;
  if (planItem?.executor === "minion" || node.currentAttempt?.sessionId) return "minion" as const;
  return "task" as const;
}

export function getVirtualRange(count: number, scrollTop: number, viewportHeight: number) {
  const start = Math.max(0, Math.floor(scrollTop / WORK_QUEUE_ROW_HEIGHT) - WORK_QUEUE_OVERSCAN);
  const end = Math.min(count, Math.ceil((scrollTop + viewportHeight) / WORK_QUEUE_ROW_HEIGHT) + WORK_QUEUE_OVERSCAN);
  return { start, end, offset: start * WORK_QUEUE_ROW_HEIGHT, totalHeight: count * WORK_QUEUE_ROW_HEIGHT };
}

export function summarizeGraph(snapshot: TaskGraphSnapshotView) {
  const nodes = snapshot.nodes;
  return {
    total: nodes.length,
    succeeded: nodes.filter((n) => n.logicalState === "succeeded").length,
    logicalFailed: nodes.filter((n) => n.logicalState === "failed" || n.logicalState === "exhausted").length,
    attemptFailed: nodes.filter((n) => n.logicalState === "pending" && n.currentAttempt?.state === "failed").length,
    running: nodes.filter((n) => n.currentAttempt?.state === "running").length,
    ready: nodes.filter((n) => n.readiness === "ready" && n.currentAttempt?.state !== "running").length,
    blocked: nodes.filter((n) => n.blocker && n.blocker.category !== "none").length,
    verified: nodes.filter((n) => n.verification.state === "passed" || n.verification.state === "waived").length,
    unverified: nodes.filter((n) => ["pending", "failed", "stale"].includes(n.verification.state)).length,
  };
}
