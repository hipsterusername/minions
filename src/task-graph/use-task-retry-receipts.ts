import { useCallback, useEffect, useRef, useState } from "react";
import { workItemTopic } from "../../shared/ws-envelope.ts";
import { subscribeSocketTopics, type ServerMessage, type SocketSubscribeLike } from "../use-socket.ts";
import type { GraphInspectorAction, TaskGraphSnapshotView } from "./types.ts";

export interface TaskRetryReceipt {
  requestId: string;
  runId: string;
  attemptId: string | null;
  pending: boolean;
  accepted: boolean;
  error: string | null;
}

/** A command acknowledgement is not an attempt. Only projection changes settle retries. */
export function useTaskRetryReceipts(workItemId: string | null, snapshot: TaskGraphSnapshotView | null,
  subscribe: SocketSubscribeLike, refetch: () => void) {
  const [receipts, setReceipts] = useState<Record<string, TaskRetryReceipt>>({});
  const receiptsRef = useRef(receipts);
  const update = useCallback((next: Record<string, TaskRetryReceipt>) => {
    receiptsRef.current = next;
    setReceipts(next);
  }, []);
  useEffect(() => update({}), [workItemId, update]);
  useEffect(() => subscribeSocketTopics(subscribe, workItemId ? ["*", workItemTopic(workItemId)] : ["*"], raw => {
    const message = raw as ServerMessage;
    if (message.type === "socket_reconnected") {
      update(Object.fromEntries(Object.entries(receiptsRef.current).map(([id, receipt]) => [id,
        receipt.pending && !receipt.accepted ? { ...receipt, error: "Retry not confirmed after reconnect. Refresh task state before retrying." } : receipt])));
      return;
    }
    if (message.type !== "task_graph_response") return;
    const entry = Object.entries(receiptsRef.current).find(([, receipt]) => receipt.requestId === message.requestId);
    if (!entry || (message.command !== "retry_task_node" && message.command !== "adjudicate_task_node")) return;
    const [id, receipt] = entry;
    if (!receipt.pending) return;
    if (message.success) {
      update({ ...receiptsRef.current, [id]: { ...receipt, accepted: true, error: null } });
      return;
    }
    update({ ...receiptsRef.current, [id]: { ...receipt, pending: false,
      error: message.code === "conflict" ? `Task state changed. Refresh and retry. ${message.error}` : message.error } });
    refetch();
  }), [subscribe, workItemId, update, refetch]);
  useEffect(() => {
    if (!snapshot) return;
    const next = { ...receiptsRef.current };
    let changed = false;
    // An unchanged attempt cannot tell us whether admission is waiting or the ack was lost.
    for (const [id, receipt] of Object.entries(next)) {
      const node = snapshot.nodes.find(item => item.id === id);
      if (receipt.runId !== snapshot.graphRunId || !node || (node.currentAttempt?.id ?? null) !== receipt.attemptId) {
        delete next[id];
        changed = true;
      }
    }
    if (changed) update(next);
  }, [snapshot, update]);
  useEffect(() => {
    const waiting = Object.entries(receipts).filter(([, receipt]) => receipt.pending && !receipt.accepted && !receipt.error);
    if (!waiting.length) return;
    const timer = setTimeout(() => {
      const next = { ...receiptsRef.current };
      for (const [id, receipt] of waiting) {
        if (next[id]?.requestId === receipt.requestId) next[id] = { ...receipt,
          error: "Retry not confirmed. Refresh task state before trying again." };
      }
      update(next);
    }, 15000);
    return () => clearTimeout(timer);
  }, [receipts, update]);
  const fail = useCallback((action: GraphInspectorAction, error: unknown) => {
    if (!action.nodeId) return;
    const receipt = receiptsRef.current[action.nodeId];
    if (!receipt || receipt.requestId !== action.requestId) return;
    update({ ...receiptsRef.current, [action.nodeId]: { ...receipt, pending: false,
      error: error instanceof Error ? error.message : "Couldn’t request retry. Try again." } });
  }, [update]);
  const begin = useCallback((action: GraphInspectorAction) => {
    if (action.type !== "retry" && !(action.type === "adjudicate" && action.decision === "retry")) return true;
    if (!action.nodeId || receiptsRef.current[action.nodeId]?.pending) return false;
    update({ ...receiptsRef.current, [action.nodeId]: { requestId: action.requestId,
      runId: action.graphRunId, attemptId: action.currentAttemptId, pending: true, accepted: false, error: null } });
    return true;
  }, [update]);
  return { retryReceipts: receipts, begin, fail };
}
