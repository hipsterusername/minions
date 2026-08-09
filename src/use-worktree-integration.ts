import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  WorktreeContributionSnapshot,
  WorktreeLineageSnapshot,
} from "../shared/worktree-integration.ts";
import { subscribeSocketTopic, type ServerMessage, type SocketSubscribeLike } from "./use-socket.ts";
import { workItemTopic } from "../shared/ws-envelope.ts";

type Send = (data: unknown) => void;
type QueueEntry = WorktreeLineageSnapshot["queue"][number];
type Review = WorktreeLineageSnapshot["reviews"][number];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function newest<T>(entries: readonly T[], compare: (left: T, right: T) => number): T | null {
  let result: T | null = null;
  for (const entry of entries) {
    if (result === null || compare(entry, result) > 0) result = entry;
  }
  return result;
}

const compareQueueRecency = (left: QueueEntry, right: QueueEntry) =>
  left.updatedAt - right.updatedAt
  || left.revision - right.revision
  || left.enqueuedAt - right.enqueuedAt
  || compareText(left.id, right.id);

const compareReviewRecency = (left: Review, right: Review) =>
  left.recordedAt - right.recordedAt || compareText(left.id, right.id);

function mergeRevisioned<T extends { id: string; revision: number }>(
  current: readonly T[], incoming: readonly T[],
): T[] {
  const merged = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of incoming) {
    const prior = merged.get(entry.id);
    if (!prior || entry.revision >= prior.revision) merged.set(entry.id, entry);
  }
  return [...merged.values()];
}

/** Merge whole snapshots without allowing a delayed response to roll an entity back. */
export function mergeWorktreeIntegrationSnapshot(
  current: WorktreeLineageSnapshot | null,
  incoming: WorktreeLineageSnapshot,
): WorktreeLineageSnapshot {
  if (!current || current.id !== incoming.id) return incoming;
  const newest = incoming.revision >= current.revision ? incoming : current;
  const reviews = new Map(current.reviews.map((entry) => [entry.id, entry]));
  for (const entry of incoming.reviews) reviews.set(entry.id, entry);
  const gates = new Map(current.gates.map((entry) => [entry.id, entry]));
  for (const entry of incoming.gates) {
    const prior = gates.get(entry.id);
    if (!prior || entry.recordedAt >= prior.recordedAt) gates.set(entry.id, entry);
  }
  const memberships = new Map(current.memberships.map((entry) => [entry.workItemId, entry]));
  for (const entry of incoming.memberships) {
    const prior = memberships.get(entry.workItemId);
    if (!prior || entry.revision >= prior.revision) memberships.set(entry.workItemId, entry);
  }
  const resolutionRuns = new Map(current.resolutionRuns.map((entry) => [entry.runKey, entry]));
  for (const entry of incoming.resolutionRuns) {
    const prior = resolutionRuns.get(entry.runKey);
    if (!prior || entry.revision >= prior.revision) resolutionRuns.set(entry.runKey, entry);
  }
  return {
    ...newest,
    memberships: [...memberships.values()],
    resolutionRuns: [...resolutionRuns.values()],
    contributions: mergeRevisioned(current.contributions, incoming.contributions),
    queue: mergeRevisioned(current.queue, incoming.queue),
    gates: [...gates.values()],
    reviews: [...reviews.values()],
  };
}

export function selectWorktreeContribution(
  lineage: WorktreeLineageSnapshot | null,
  identity: { workItemId?: string | null; runKey?: string | null },
): WorktreeContributionSnapshot | null {
  if (!lineage) return null;
  const resolution = identity.runKey
    ? lineage.resolutionRuns.find((entry) => entry.runKey === identity.runKey) : null;
  const candidates = lineage.contributions.filter((entry) => identity.runKey
    ? entry.runKeys.includes(identity.runKey)
      || (!!resolution && entry.workItemId === resolution.workItemId)
    : entry.workItemId === identity.workItemId);
  return newest(candidates, (left, right) =>
    left.updatedAt - right.updatedAt
    || left.revision - right.revision
    || left.createdAt - right.createdAt
    || compareText(left.id, right.id));
}

/** Snapshot arrays are merged by identity and do not carry a meaningful display order. */
export function selectLatestQueueEntry(
  lineage: WorktreeLineageSnapshot,
  matches: (entry: QueueEntry) => boolean,
): QueueEntry | null {
  return newest(lineage.queue.filter(matches), compareQueueRecency);
}

/** Reviews are immutable history; select the latest explicitly instead of trusting array order. */
export function selectLatestLineageReview(lineage: WorktreeLineageSnapshot): Review | null {
  return newest(lineage.reviews.filter((review) => review.scope === "lineage"), compareReviewRecency);
}

export function useWorktreeIntegration(input: {
  workItemId?: string | null;
  runKey?: string | null;
  send?: Send | undefined;
  subscribe?: SocketSubscribeLike;
}) {
  const [lineage, setLineage] = useState<WorktreeLineageSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!input.subscribe || (!input.workItemId && !input.runKey)) return;
    setLineage(null);
    setError(null);
    const matches = (snapshot: WorktreeLineageSnapshot) =>
      (!input.workItemId || snapshot.memberships.some((entry) => entry.workItemId === input.workItemId))
      && (!input.runKey || snapshot.contributions.some((entry) => entry.runKeys.includes(input.runKey!))
        || snapshot.resolutionRuns.some((entry) => entry.runKey === input.runKey));
    const receive = (raw: unknown, allowBareError: boolean) => {
      const message = raw as ServerMessage;
      if (message.type === "worktree_integration_changed") {
        if (!matches(message.lineage)) return;
        setLineage((current) => mergeWorktreeIntegrationSnapshot(current, message.lineage));
      } else if (message.type === "worktree_integration_response") {
        if (message.success && message.result) {
          if (matches(message.result)) {
            setLineage((current) => mergeWorktreeIntegrationSnapshot(current, message.result!));
            setError(null);
          }
        } else if (!message.success) {
          if (message.latest && matches(message.latest))
            setLineage((current) => mergeWorktreeIntegrationSnapshot(current, message.latest!));
          if ((message.latest && matches(message.latest)) || (allowBareError
            && message.command === "get_worktree_lineage_status"))
            setError(message.error ?? "Integration command failed");
        }
      }
    };
    const topicAware = input.subscribe && "supportsTopics" in input.subscribe
      && input.subscribe.supportsTopics === true;
    const scoped = subscribeSocketTopic(input.subscribe,
      input.workItemId ? workItemTopic(input.workItemId) : "*",
      (raw) => receive(raw, topicAware === true));
    const global = input.workItemId && topicAware
      ? subscribeSocketTopic(input.subscribe, "*", (raw) => receive(raw, false)) : undefined;
    return () => { scoped?.(); global?.(); };
  }, [input.runKey, input.subscribe, input.workItemId]);

  const refresh = useCallback(() => {
    if (!input.send || (!input.workItemId && !input.runKey)) return;
    input.send({ type: "get_worktree_lineage_status",
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
      ...(input.runKey ? { runKey: input.runKey } : {}) });
  }, [input.runKey, input.send, input.workItemId]);

  useEffect(() => refresh(), [refresh]);
  const contribution = useMemo(() => selectWorktreeContribution(lineage, input),
    [input.runKey, input.workItemId, lineage]);
  return { lineage, contribution, error, refresh };
}
