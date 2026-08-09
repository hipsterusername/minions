import { useEffect, useRef, useSyncExternalStore } from "react";

import { clearLeaderFullscreen, leaderFullscreenStore } from "./leader-fullscreen-request.ts";

/**
 * Open a leader node's fullscreen cockpit in response to an external request
 * (e.g. the Activity view's "Expand fullscreen" action).
 *
 * The cockpit's open state lives privately inside `LeaderNode`, so this hook
 * bridges the global request channel to that local state: when a request names
 * this `nodeId`, `onOpen` fires. A per-node "last handled nonce" guard means a
 * fresh request re-opens a node even after the user closed it, while the
 * request is consumed (cleared) so a later remount of the node doesn't replay
 * a stale request unprompted.
 */
export function useLeaderFullscreenRequest(nodeId: string, onOpen: () => void): void {
  const request = useSyncExternalStore(
    leaderFullscreenStore.subscribe,
    leaderFullscreenStore.getSnapshot,
    leaderFullscreenStore.getSnapshot,
  );
  const handledNonceRef = useRef(0);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    if (!request) return;
    if (request.nodeId !== nodeId) return;
    if (request.nonce === handledNonceRef.current) return;
    handledNonceRef.current = request.nonce;
    onOpenRef.current();
    clearLeaderFullscreen();
  }, [request, nodeId]);
}
