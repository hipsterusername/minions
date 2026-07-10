/**
 * One-shot "focus this leader's prompt input on mount" channel.
 *
 * When the user creates a brand-new (empty) leader node, we want its prompt
 * textarea to receive focus immediately so they can start typing — a small
 * but meaningful UX win. A leader node also mounts on every page load /
 * rehydration, however, where stealing focus would be wrong.
 *
 * This module bridges the gap: the creation site (Canvas) registers the new
 * node id via {@link requestLeaderInputFocus}, and the LeaderNode renderer
 * consumes it exactly once on mount via {@link consumeLeaderInputFocus}.
 * Rehydrated nodes never have a pending request, so they are left untouched.
 */
const pendingFocusNodeIds = new Set<string>();

/** Mark a freshly created leader node so its prompt input auto-focuses on mount. */
export function requestLeaderInputFocus(nodeId: string): void {
  pendingFocusNodeIds.add(nodeId);
}

/**
 * Claim a pending focus request for `nodeId`. Returns true exactly once per
 * request (the request is cleared on claim), so repeat mounts / StrictMode
 * double-invocation do not re-steal focus.
 */
export function consumeLeaderInputFocus(nodeId: string): boolean {
  return pendingFocusNodeIds.delete(nodeId);
}

/** Test-only: clear any outstanding focus requests between cases. */
export function resetLeaderInputFocusRequestsForTests(): void {
  pendingFocusNodeIds.clear();
}
