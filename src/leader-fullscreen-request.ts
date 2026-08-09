/**
 * Cross-view "open this leader's fullscreen cockpit" channel.
 *
 * The desktop Activity view lets the user expand a session into the same
 * fullscreen cockpit the canvas already provides. That cockpit's open/close
 * state lives privately inside `LeaderNode` (it needs the node's focus-scope
 * ref for the Cmd/Ctrl+Shift+F handler), so it can't be driven by a prop from
 * an arbitrary sibling view without threading state through Canvas + the node
 * registry.
 *
 * This tiny pub/sub channel bridges that gap: a caller anywhere requests a
 * node by id, and the matching `LeaderNode` — which subscribes — opens its
 * cockpit. A monotonically increasing `nonce` makes repeated requests for the
 * same node distinguishable, so re-expanding a node that was just closed still
 * fires.
 */

export interface LeaderFullscreenRequest {
  /** Canvas node id whose cockpit should open. */
  nodeId: string;
  /** Monotonic counter so identical-node requests are still observable. */
  nonce: number;
}

let current: LeaderFullscreenRequest | null = null;
let nonce = 0;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* listener errors must not break siblings */
    }
  });
}

/** Request that the leader node with `nodeId` open its fullscreen cockpit. */
export function requestLeaderFullscreen(nodeId: string): void {
  nonce += 1;
  current = { nodeId, nonce };
  notify();
}

/**
 * Clear the pending request once a node has consumed it. Without this, a node
 * that unmounts (e.g. switching back to the Activity view) and later remounts
 * would replay the stale request and re-open its cockpit unprompted.
 */
export function clearLeaderFullscreen(): void {
  if (current === null) return;
  current = null;
  notify();
}

/**
 * Snapshot / subscribe pair for `useSyncExternalStore`. `getSnapshot` returns a
 * stable reference between requests, so consumers don't re-render needlessly.
 */
export const leaderFullscreenStore = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  getSnapshot(): LeaderFullscreenRequest | null {
    return current;
  },
};

/** Test-only: reset the channel between cases. */
export function resetLeaderFullscreenRequest(): void {
  current = null;
  nonce = 0;
  listeners.clear();
}
