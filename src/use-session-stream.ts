/**
 * Controlled React hook around `sessionStreamReducer`.
 *
 * Subscribes to a socket and, for every inbound `ServerMessage`, runs
 * the pure reducer against the caller's current state. When the
 * reducer returns a new state reference, the hook fires `onChange`.
 *
 * **Why "controlled":** every node in this codebase persists its
 * session messages via the canvas state (`onUpdateData`). If the hook
 * owned the state internally, persistence would silently break on
 * reload (the persisted data would be ignored on mount). Keeping the
 * caller as the source of truth means the hook is purely additive —
 * nodes adopt it by replacing their hand-written subscription effect
 * with one call to this hook, and persistence keeps working unchanged.
 *
 * Migration sketch:
 * ```tsx
 * useSessionStream({
 *   socketSubscribe,
 *   prefix: "mm",
 *   state: extractCore(data),
 *   onChange: (next) => emitUpdate({ ...dataRef.current, ...next }),
 * });
 * ```
 *
 * Node-specific concerns (LeaderNode's worktree/approval, MinionNode's
 * task queue + auto-advance, ClaudeSessionNode's tool groups) live in a
 * **separate** subscription in the node — `socketSubscribe` supports
 * multiple subscribers.
 */

import { useEffect, useRef } from "react";

import { recordWsMessageForDebug } from "./debug-record-bridge.ts";
import {
  sessionStreamReducer,
  type SessionStreamState,
} from "./session-stream.ts";
import {
  subscribeSocketTopic,
  type ServerMessage,
  type SocketSubscribe,
} from "./use-socket.ts";
import { sessionTopic } from "../shared/ws-envelope.ts";

/** Subscription function shape consumed by the hook. */
export interface UseSessionStreamOptions {
  /**
   * The subscription primitive. May be `undefined` while the socket is
   * still being established — the hook is a no-op in that case.
   */
  socketSubscribe?:
    | SocketSubscribe
    | ((fn: (msg: unknown) => void) => () => void)
    | undefined;
  /** Current shared state. The caller owns this and persists it. */
  state: SessionStreamState;
  /**
   * Called with the next state when the reducer produces a change.
   * The caller is responsible for merging this with any node-specific
   * fields and persisting the result.
   */
  onChange: (next: SessionStreamState) => void;
  /**
   * Prefix passed to `sdkToDisplayMessages` so message IDs are scoped
   * to the consuming node type (e.g. `"lm"` for leader, `"mm"` for
   * minion).
   */
  prefix: string;
}

type ScheduledFrame =
  | { kind: "raf"; id: number }
  | { kind: "timeout"; id: ReturnType<typeof setTimeout> };

function scheduleFrame(fn: () => void): ScheduledFrame {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    return { kind: "raf", id: window.requestAnimationFrame(fn) };
  }
  return { kind: "timeout", id: setTimeout(fn, 16) };
}

function cancelFrame(frame: ScheduledFrame | null): void {
  if (!frame) return;
  if (frame.kind === "raf" && typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(frame.id);
    return;
  }
  clearTimeout(frame.id);
}

function isTransientStreamingOnlyChange(
  previous: SessionStreamState,
  next: SessionStreamState,
): boolean {
  return (
    previous.sessionKey === next.sessionKey &&
    previous.status === next.status &&
    previous.messages === next.messages &&
    previous.totalCost === next.totalCost &&
    previous.turns === next.turns &&
    previous.error === next.error &&
    previous.fullError === next.fullError &&
    (
      previous.streamingText !== next.streamingText ||
      previous.streamingBlockIndex !== next.streamingBlockIndex
    )
  );
}

/**
 * Subscribe to the socket and run every message through
 * `sessionStreamReducer` against the latest `state`. Calls `onChange`
 * exactly when the reducer returns a new state reference.
 *
 * The hook tracks `state` and `onChange` via refs so the subscription
 * doesn't tear down on every render. The subscription only resets when
 * `socketSubscribe` itself changes (e.g. socket reconnect).
 */
export function useSessionStream(opts: UseSessionStreamOptions): void {
  const { socketSubscribe, prefix } = opts;
  const sessionKey = opts.state.sessionKey;

  // Latest props, accessed via ref so the subscription effect's
  // identity does not depend on them.
  const stateRef = useRef(opts.state);
  const pendingFrameRef = useRef<ScheduledFrame | null>(null);
  const pendingTransientRef = useRef<SessionStreamState | null>(null);
  if (!pendingTransientRef.current) {
    stateRef.current = opts.state;
  } else if (opts.state !== stateRef.current) {
    const pending = pendingTransientRef.current;
    if (opts.state.sessionKey === pending.sessionKey) {
      const rebased = {
        ...opts.state,
        streamingText: pending.streamingText,
        streamingBlockIndex: pending.streamingBlockIndex,
      };
      pendingTransientRef.current = rebased;
      stateRef.current = rebased;
    } else {
      pendingTransientRef.current = null;
      stateRef.current = opts.state;
    }
  }
  const onChangeRef = useRef(opts.onChange);
  onChangeRef.current = opts.onChange;
  const prefixRef = useRef(prefix);
  prefixRef.current = prefix;

  const flushTransientRef = useRef<() => void>(() => undefined);
  flushTransientRef.current = () => {
    const pending = pendingTransientRef.current;
    pendingFrameRef.current = null;
    pendingTransientRef.current = null;
    if (pending) {
      onChangeRef.current(pending);
    }
  };

  useEffect(() => {
    if (!socketSubscribe || !sessionKey) return;
    const listener = (msg: unknown) => {
      const current = stateRef.current;
      const serverMsg = msg as ServerMessage;
      // Debug capture — no-ops when debug mode is off, scoped to the
      // node prefix so leader/minion buffers don't collide.
      recordWsMessageForDebug(
        current.sessionKey,
        serverMsg,
        prefixRef.current,
      );
      const next = sessionStreamReducer(
        current,
        serverMsg,
        prefixRef.current,
      );
      if (next !== current) {
        // Update ref synchronously so back-to-back messages within the
        // same tick each see the latest state, then notify the caller.
        stateRef.current = next;
        if (isTransientStreamingOnlyChange(current, next)) {
          pendingTransientRef.current = next;
          if (!pendingFrameRef.current) {
            pendingFrameRef.current = scheduleFrame(() => {
              flushTransientRef.current();
            });
          }
          return;
        }

        cancelFrame(pendingFrameRef.current);
        pendingFrameRef.current = null;
        pendingTransientRef.current = null;
        onChangeRef.current(next);
      }
    };

    const unsubscribe = subscribeSocketTopic(socketSubscribe, sessionTopic(sessionKey), listener);
    return () => {
      unsubscribe?.();
      cancelFrame(pendingFrameRef.current);
      pendingFrameRef.current = null;
      pendingTransientRef.current = null;
    };
  }, [socketSubscribe, sessionKey]);

  useEffect(() => {
    return () => {
      cancelFrame(pendingFrameRef.current);
      pendingFrameRef.current = null;
      pendingTransientRef.current = null;
    };
  }, []);
}
