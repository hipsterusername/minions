import { useEffect, useMemo, useRef, useState } from "react";

import type { WorkItemRunSnapshot } from "../shared/work-item-contracts.ts";
import {
  emptySessionStreamState,
  sessionStreamReducer,
  type SessionStreamState,
} from "./session-stream.ts";
import type { ServerMessage, SocketSubscribe } from "./use-socket.ts";

export interface WorkItemHistoryState {
  orderedRuns: WorkItemRunSnapshot[];
  streams: Record<string, SessionStreamState>;
  loading: boolean;
}

/**
 * Rebuild every run transcript using the same bounded sync replay as a normal
 * session inspector. Run metadata remains owned by the canonical work-item
 * ledger; this hook only joins those immutable run keys to their session logs.
 */
export function useWorkItemHistory(input: {
  workItemId: string | null | undefined;
  runs: readonly WorkItemRunSnapshot[];
  runNextCursor: string | null | undefined;
  onLoadRuns?: (cursor?: string) => void;
  socketSend?: (data: unknown) => void;
  socketSubscribe?: SocketSubscribe;
}): WorkItemHistoryState {
  const { workItemId, runs, runNextCursor, onLoadRuns, socketSend, socketSubscribe } = input;
  const [streams, setStreams] = useState<Record<string, SessionStreamState>>({});
  const requestedPages = useRef(new Set<string>());
  const requestedRuns = useRef(new Set<string>());
  const orderedRuns = useMemo(
    () => [...runs].sort((a, b) => a.startedAt - b.startedAt || a.runKey.localeCompare(b.runKey)),
    [runs],
  );
  const runKeySignature = orderedRuns.map((run) => run.runKey).join("\u0000");

  useEffect(() => {
    requestedPages.current.clear();
    requestedRuns.current.clear();
    setStreams({});
  }, [workItemId]);

  useEffect(() => {
    // A new subscription identity means reconnect. Re-request ledger pages and
    // snapshots so history converges after events or responses were missed.
    requestedPages.current.clear();
    requestedRuns.current.clear();
  }, [socketSubscribe]);

  useEffect(() => {
    if (!workItemId || !onLoadRuns) return;
    // `undefined` means no ledger page has been requested yet; `null` means
    // the server confirmed the final page. A live run event may populate
    // `runs` before the first ledger response, so runs.length cannot decide
    // whether history is complete.
    const cursorKey = runNextCursor === undefined ? "__first__" : runNextCursor;
    if (!cursorKey || requestedPages.current.has(cursorKey)) return;
    requestedPages.current.add(cursorKey);
    onLoadRuns(cursorKey === "__first__" ? undefined : cursorKey);
  }, [onLoadRuns, runNextCursor, socketSubscribe, workItemId]);

  useEffect(() => {
    if (!workItemId || !socketSubscribe) return;
    const runKeys = new Set(runKeySignature ? runKeySignature.split("\u0000") : []);
    const unsubscribe = socketSubscribe("*", (raw: unknown) => {
      const msg = raw as ServerMessage;
      const sessionKey = "sessionKey" in msg && typeof msg.sessionKey === "string"
        ? msg.sessionKey
        : null;
      if (!sessionKey || !runKeys.has(sessionKey)) return;
      setStreams((current) => {
        const previous = current[sessionKey] ?? emptySessionStreamState(sessionKey);
        const next = sessionStreamReducer(previous, msg, `work-history-${sessionKey}`);
        return next === previous ? current : { ...current, [sessionKey]: next };
      });
    });
    for (const runKey of runKeys) {
      if (requestedRuns.current.has(runKey)) continue;
      requestedRuns.current.add(runKey);
      socketSend?.({ type: "sync_session", sessionKey: runKey });
    }
    return unsubscribe;
  }, [runKeySignature, socketSend, socketSubscribe, workItemId]);

  return {
    orderedRuns,
    streams,
    loading: Boolean(workItemId && onLoadRuns && runNextCursor !== null),
  };
}
