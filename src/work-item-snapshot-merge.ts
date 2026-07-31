import type { WorkItemSnapshot } from "../shared/work-item-contracts.ts";

/** Merge snapshots using the canonical lifecycle revision. */
export function mergeWorkItemSnapshot(current: WorkItemSnapshot, incoming: WorkItemSnapshot): WorkItemSnapshot {
  const lifecycleNewer = incoming.lifecycle.lifecycleRevision > current.lifecycle.lifecycleRevision;
  if (!lifecycleNewer) return current;
  return {
    ...current,
    title: incoming.title,
    lifecycle: incoming.lifecycle,
    waitKind: incoming.waitKind,
    currentRunKey: incoming.currentRunKey,
    iteration: incoming.iteration,
    lastTransitionAt: incoming.lastTransitionAt,
    updatedAt: Math.max(current.updatedAt, incoming.updatedAt),
  };
}
