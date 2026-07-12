import type { WorkItemSnapshot } from "../shared/work-item-contracts.ts";

/** Merge two snapshots using the lifecycle and workflow clocks independently. */
export function mergeWorkItemSnapshot(current: WorkItemSnapshot, incoming: WorkItemSnapshot): WorkItemSnapshot {
  const lifecycleNewer = incoming.lifecycle.lifecycleRevision > current.lifecycle.lifecycleRevision;
  const workflowNewer = incoming.workflowRevision > current.workflowRevision;
  if (!lifecycleNewer && !workflowNewer) return current;
  return {
    ...current,
    ...(lifecycleNewer ? {
      lifecycle: incoming.lifecycle, waitKind: incoming.waitKind,
      currentRunKey: incoming.currentRunKey, iteration: incoming.iteration,
      lastTransitionAt: incoming.lastTransitionAt,
    } : {}),
    ...(workflowNewer ? {
      title: incoming.title, workflowColumnId: incoming.workflowColumnId,
      workflowRank: incoming.workflowRank, workflowRevision: incoming.workflowRevision,
      card: incoming.card,
    } : {}),
    updatedAt: Math.max(current.updatedAt, incoming.updatedAt),
  };
}
