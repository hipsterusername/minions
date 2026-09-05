/**
 * Per-leader-session connected-canvas context snapshots.
 *
 * Stored out of band from the SessionHost class so `session-host.ts` stays
 * under its architectural file-size budget. Session continuity persists the
 * snapshot and repopulates this lookup during restart hydration.
 */
const canvasContextBySession = new Map<string, string>();

export function getSessionCanvasContext(sessionKey: string): string | null {
  return canvasContextBySession.get(sessionKey) ?? null;
}

export function setSessionCanvasContext(
  sessionKey: string,
  canvasContext: string | null,
): void {
  if (canvasContext) {
    canvasContextBySession.set(sessionKey, canvasContext);
  } else {
    canvasContextBySession.delete(sessionKey);
  }
}
