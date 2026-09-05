import { useCallback, useEffect, useRef, useState } from "react";
import { sessionTopic } from "../shared/ws-envelope.ts";
import type { LeaderData } from "./nodes/leader/types.ts";
import { randomUuid } from "./random-id.ts";
import { subscribeSocketTopic, type ServerMessage, type SocketSubscribeLike } from "./use-socket.ts";

type Diff = NonNullable<LeaderData["approvalDiff"]>;

/** Only the latest requested diff may replace the retained review. */
export function useReviewDiff(sessionKey: string, send: ((data: unknown) => void) | undefined, subscribe: SocketSubscribeLike) {
  const [diff, setDiff] = useState<Diff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refresh = useCallback(() => {
    clearTimeout(timer.current);
    if (!send || !subscribe) { setError("Changes unavailable: connection required."); return; }
    const requestId = randomUuid();
    pending.current = requestId;
    setLoading(true);
    setError(null);
    timer.current = setTimeout(() => {
      if (pending.current !== requestId) return;
      pending.current = null;
      setLoading(false);
      setError("Still waiting for changes. Retry to request the latest diff.");
    }, 15000);
    try { send({ type: "get_worktree_diff", sessionKey, requestId }); }
    catch (cause) {
      clearTimeout(timer.current);
      pending.current = null;
      setLoading(false);
      setError(cause instanceof Error ? cause.message : "Couldn’t load changes");
    }
  }, [send, sessionKey, subscribe]);

  useEffect(() => {
    setDiff(null);
    setLoadedAt(null);
    const unsubscribe = subscribeSocketTopic(subscribe, sessionTopic(sessionKey), raw => {
      const message = raw as ServerMessage;
      if (message.type === "socket_reconnected") { refresh(); return; }
      if (message.type !== "control_response" || message.command !== "get_worktree_diff"
        || message.sessionKey !== sessionKey || !pending.current || message.requestId !== pending.current) return;
      clearTimeout(timer.current);
      pending.current = null;
      setLoading(false);
      if (message.success && message["diff"]) {
        setDiff(message["diff"] as Diff);
        setLoadedAt(Date.now());
        setError(null);
      } else setError(message.error ?? "Couldn’t load changes");
    });
    refresh();
    return () => { unsubscribe?.(); clearTimeout(timer.current); pending.current = null; };
  }, [refresh, sessionKey, subscribe]);
  return { diff, loading, error, loadedAt, refresh };
}
