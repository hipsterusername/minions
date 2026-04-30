/**
 * Utility: extract session-end information from a bus envelope.
 *
 * Extracted from `server/routine-registry.ts` so the registry stays under
 * the 400-line server-file limit while the logic remains unit-testable.
 */

import type { WsEnvelope } from "../../shared/ws-envelope.ts";

/**
 * Inspect a session-scoped envelope and decide whether it represents a
 * session end. We accept idle (graceful), error, stopped, or completed.
 */
export function extractSessionEnd(
  envelope: WsEnvelope,
): { reason: string; isError: boolean } | null {
  const type = envelope["type"];
  if (type === "session_status") {
    const status = envelope["status"];
    if (status === "idle" || status === "stopped") {
      return { reason: status, isError: false };
    }
    if (status === "error") return { reason: "error", isError: true };
  }
  if (type === "session_error") {
    const error = envelope["error"];
    return {
      reason: typeof error === "string" ? error : "session_error",
      isError: true,
    };
  }
  if (type === "session_completed") {
    const reason =
      typeof envelope["reason"] === "string"
        ? (envelope["reason"] as string)
        : "completed";
    return { reason, isError: false };
  }
  return null;
}
