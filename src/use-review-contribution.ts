import { useEffect, useRef, useState } from "react";
import type { WorktreeContributionSnapshot } from "../shared/worktree-integration.ts";
import { workItemTopic } from "../shared/ws-envelope.ts";
import { randomUuid } from "./random-id.ts";
import { subscribeSocketTopics, type ServerMessage, type SocketSubscribeLike } from "./use-socket.ts";

type Pending = { requestId: string; revision: number; decision: "approved" | "rejected" };

export function useReviewContribution(contribution: WorktreeContributionSnapshot | null, send: (data: unknown) => void, subscribe: SocketSubscribeLike) {
  const [pending, setPending] = useState<Pending | null>(null);
  const refreshId = useRef<string | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  // Keep the newest command correlated after a snapshot releases the UI lock.
  const responseRef = useRef<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<WorktreeContributionSnapshot | null>(null);
  const current = receipt?.id === contribution?.id && receipt && contribution && receipt.revision > contribution.revision ? receipt : contribution;
  useEffect(() => {
    pendingRef.current = null;
    responseRef.current = null;
    refreshId.current = null;
    setPending(null);
    setReceipt(null);
    setError(null);
  }, [contribution?.id]);
  useEffect(() => subscribeSocketTopics(subscribe, contribution ? ["*", workItemTopic(contribution.workItemId)] : ["*"], raw => {
    const message = raw as ServerMessage;
    const intent = responseRef.current;
    if (message.type === "worktree_integration_response" && message.command === "get_worktree_lineage_status" && refreshId.current && message.requestId === refreshId.current) {
      refreshId.current = null;
      const next = message.result?.contributions.find(item => item.id === contribution?.id);
      if (message.success && next) {
        setReceipt(previous => previous && previous.revision > next.revision ? previous : next);
        pendingRef.current = null;
        setPending(null);
        setError(next.reviewState === "pending" ? "Review is pending in the latest state. Review the current changes before trying again." : null);
      } else setError(message.error ?? "Couldn’t refresh review status. Try again.");
      return;
    }
    if (!intent) return;
    if (message.type === "socket_reconnected" && pendingRef.current) {
      setError("Review not confirmed after reconnect. Refresh review status before trying again.");
      return;
    }
    if (message.type !== "worktree_integration_response" || message.requestId !== intent.requestId
      || message.command !== "review_worktree_contribution") return;
    const next = (message.success ? message.result : message.latest)?.contributions.find(item => item.id === contribution?.id);
    if (message.success && (!next || next.revision <= intent.revision)) {
      setError("Review acknowledgement needs current state. Refresh review status.");
      return;
    }
    responseRef.current = null;
    if (next) setReceipt(previous => previous && previous.revision > next.revision ? previous : next);
    pendingRef.current = null;
    setPending(null);
    setError(message.success ? null : message.code === "conflict"
      ? "Changes updated. Review again." : message.error ?? "Couldn’t record review. Try again.");
  }), [subscribe, contribution?.id, contribution?.workItemId]);
  useEffect(() => {
    const intent = pendingRef.current;
    if (!intent || !current || current.revision <= intent.revision) return;
    pendingRef.current = null;
    setPending(null);
    setError(current.reviewState === intent.decision ? null : "Changes updated. Review again.");
  }, [current]);
  function review(decision: Pending["decision"]) {
    if (!current || pendingRef.current || current.state !== "ready" || current.reviewState !== "pending") return;
    const intent = { requestId: randomUuid(), revision: current.revision, decision };
    pendingRef.current = intent;
    responseRef.current = intent;
    setPending(intent);
    setError(null);
    try {
      send({ type: "review_worktree_contribution", requestId: intent.requestId,
        contributionId: current.id, expectedIntegrationRevision: intent.revision,
        decision, actor: "user", summary: decision === "approved"
          ? "Approved contribution changes" : "Contribution needs another iteration" });
    } catch (cause) {
      responseRef.current = null;
      pendingRef.current = null;
      setPending(null);
      setError(cause instanceof Error ? cause.message : "Couldn’t record review");
    }
  }
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setError("Review not confirmed. Refresh review status before trying again."), 15000);
    return () => clearTimeout(timer);
  }, [pending]);
  function refresh() {
    if (!current) return;
    refreshId.current = randomUuid();
    try { send({ type: "get_worktree_lineage_status", workItemId: current.workItemId, requestId: refreshId.current }); }
    catch { setError("Couldn’t refresh review status. Try again."); }
  }
  return { contribution: current, pending, error, review, refresh };
}
