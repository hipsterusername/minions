/**
 * Per-connection WebSocket wiring.
 *
 * Extracted from `server/index.ts` so the listener contract can be tested
 * without booting the HTTP server. The function attaches every listener
 * a freshly-accepted client needs:
 *
 *   - `error`   — keeps `ws`-internal errors (e.g. `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH`
 *                 when a client sends a frame larger than `WS_MAX_PAYLOAD_BYTES`)
 *                 from bubbling out as an unhandled `'error'` event and
 *                 crashing the Node process. The library will follow the
 *                 error with `close` (code 1009) on its own; no need for
 *                 explicit cleanup here.
 *   - `message` — JSON-decode + dispatch through the command table.
 *   - `close`   — log the disconnect.
 *
 * On attach we also send the current session list so the client can paint
 * its tray immediately.
 */

import type { WebSocket } from "ws";
import { unicastGlobal } from "./bus.ts";
import type { WsCommand } from "./commands/index.ts";
import { validateWsCommand } from "./commands/schemas.ts";
import type { SessionListItem } from "./session-registry.ts";

export interface ConnectionDeps {
  /** Current session list; sent once on connect. */
  snapshotSessions: () => SessionListItem[];
  /** Route a parsed WS command. */
  dispatch: (cmd: WsCommand, ws: WebSocket) => void;
}

export function attachConnectionListeners(
  ws: WebSocket,
  deps: ConnectionDeps,
): void {
  console.log("Client connected");

  unicastGlobal(ws, {
    type: "session_list",
    sessions: deps.snapshotSessions(),
  });

  ws.on("error", (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ws] Connection error: ${msg}`);
  });

  ws.on("message", (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      unicastGlobal(ws, { type: "error", message: msg });
      return;
    }
    const validation = validateWsCommand(parsed);
    if (!validation.ok) {
      console.warn(`[ws] Invalid command rejected: ${validation.error}`);
      unicastGlobal(ws, { type: "error", message: validation.error });
      return;
    }
    deps.dispatch(validation.cmd, ws);
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
}
