/**
 * Claim a spawn event once its parent Leader is present on the canvas.
 * Events that race project hydration remain retryable; duplicate events after
 * a successful claim are ignored.
 */
export function claimSpawnEvent(
  claimedKeys: Set<string>,
  key: string,
  parentLeaderPresent: boolean,
): boolean {
  if (!parentLeaderPresent || claimedKeys.has(key)) return false;
  claimedKeys.add(key);
  return true;
}

export function agentSpawnDedupKey(taskId: string): string {
  return `agent-${taskId}`;
}
