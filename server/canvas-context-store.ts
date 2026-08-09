/**
 * Per-leader-session connected-canvas context snapshots.
 *
 * Stored out of band from the SessionHost class so `session-host.ts` stays
 * under its architectural file-size budget. In-memory only — snapshots do not
 * survive a server restart, matching the `canvas_context` command contract.
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
