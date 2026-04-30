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
import type { ServerMessage } from "./use-socket.ts";

/** Subscription function shape consumed by the hook. */
export type SocketSubscribe = (
  fn: (msg: unknown) => void,
) => () => void;

export interface UseSessionStreamOptions {
  /**
   * The subscription primitive. May be `undefined` while the socket is
   * still being established — the hook is a no-op in that case.
   */
  socketSubscribe?: SocketSubscribe | undefined;
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

  // Latest props, accessed via ref so the subscription effect's
  // identity does not depend on them.
  const stateRef = useRef(opts.state);
  stateRef.current = opts.state;
  const onChangeRef = useRef(opts.onChange);
  onChangeRef.current = opts.onChange;
  const prefixRef = useRef(prefix);
  prefixRef.current = prefix;

  useEffect(() => {
    if (!socketSubscribe) return;
    return socketSubscribe((msg: unknown) => {
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
        onChangeRef.current(next);
      }
    });
  }, [socketSubscribe]);
}
