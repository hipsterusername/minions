/**
 * Bridge that turns inbound `ServerMessage`s into `DebugRecord`s for
 * the per-session debug buffer.
 *
 * Lives in its own module so:
 *   1. {@link import("./use-session-stream")} can import it without
 *      pulling component code into the reducer's dependency graph,
 *   2. {@link import("./nodes/ClaudeSessionNode")} (which still has its
 *      own ad-hoc subscription instead of using the shared hook) can
 *      reuse the same digest format — keeping the recorder useful for
 *      the very component most likely to harbour the duplicate-text bug.
 *
 * The bridge only inspects fields. It never holds onto the raw
 * NormalizedEvent / ServerMessage, so debug buffers stay small.
 */

import { recordDebug } from "./debug.ts";
import type { ServerMessage } from "./use-socket.ts";

/**
 * Append a digest of `msg` to the debug buffer scoped to `sessionKey`.
 *
 * `note` is opaque caller text — by convention the consuming node's
 * prefix (`"lm"`, `"mm"`, …) so multiple inspectors against the same
 * session can be told apart in copied JSON dumps.
 */
export function recordWsMessageForDebug(
  sessionKey: string | null,
  msg: ServerMessage,
  note?: string,
): void {
  if (!sessionKey) return;

  // Cheap top-level cases first — they don't carry an event payload.
  if (msg.type === "session_status") {
    recordDebug(sessionKey, {
      source: "ws",
      type: "session_status",
      ...(note ? { note } : {}),
    });
    return;
  }
  if (msg.type === "session_error") {
    recordDebug(sessionKey, {
      source: "ws",
      type: "session_error",
      ...(note ? { note } : {}),
    });
    return;
  }
  if (msg.type === "sync_response") {
    const eventCount = msg.events?.length ?? 0;
    recordDebug(sessionKey, {
      source: "ws",
      type: "sync_response",
      ...(note ? { note: `${note} · ${eventCount} events` } : { note: `${eventCount} events` }),
    });
    return;
  }

  if (msg.type !== "sdk_event") return;
  // Filter for-this-session events — the same socket multiplexes many.
  if (msg.sessionKey !== sessionKey) return;

  const event = msg.event;
  recordDebug(sessionKey, {
    source: "ws",
    type: "sdk_event",
    sdkType: event.kind,
    ...(note ? { note } : {}),
  });
}
