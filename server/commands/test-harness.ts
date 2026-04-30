/**
 * Shared test harness for `server/commands/*.test.ts`.
 *
 * The dispatcher contract is: `(ctx, cmd, ws) => void`. Every handler
 * looks up the session via the registry, makes some assertions about the
 * SessionHost's queryHandle, and either:
 *   - replies via `unicast*(ws, ...)` (sent into ws.send), OR
 *   - emits via `bus.emitTo*(...)` (captured by the bus subscription)
 *
 * This harness exposes a single `setup()` factory that materialises:
 *   - a real `Bus` over a fake WebSocketServer (every fan-out ends up in
 *     `harness.busSent`)
 *   - a `SessionRegistry` populated with one ready SessionHost
 *   - a `ws` whose `.send` calls land in `harness.wsSent` as parsed JSON
 *
 * Per docs/testing-strategy.md §5.2, only the WebSocket boundary is faked.
 * The bus, registry, and SessionHost are real instances.
 */

import type { WebSocket, WebSocketServer } from "ws";
import { vi } from "vitest";
import { createBus, type Bus } from "../bus.ts";
import { SessionHost } from "../session-host.ts";
import { SessionRegistry } from "../session-registry.ts";
import type { CommandContext, WsCommand } from "./types.ts";

export interface CapturedEnvelope {
  topic?: string;
  type?: string;
  [key: string]: unknown;
}

export interface CommandHarness {
  ctx: CommandContext;
  host: SessionHost;
  ws: WebSocket;
  /** Every envelope the bus fanned out to clients (wraps payload + topic). */
  busSent: CapturedEnvelope[];
  /** Every payload sent directly to `ws.send` via `unicast*`. */
  wsSent: CapturedEnvelope[];
  /** Mutable handle to swap in a fake queryHandle per test. */
  setQueryHandle: (handle: unknown) => void;
}

export function setup(opts?: {
  sessionKey?: string;
  cwd?: string;
  status?: SessionHost["status"];
}): CommandHarness {
  const sessionKey = opts?.sessionKey ?? "leader-1";
  const cwd = opts?.cwd ?? "/proj";

  // Real bus over a fake WSS so the in-process subscription captures fan-outs.
  const fakeWss = { clients: new Set() } as unknown as WebSocketServer;
  const bus: Bus = createBus(fakeWss);
  const busSent: CapturedEnvelope[] = [];
  bus.subscribe((env) => {
    busSent.push(env as CapturedEnvelope);
  });

  // Real registry + real host.
  const registry = new SessionRegistry();
  const host = new SessionHost(sessionKey, cwd);
  if (opts?.status) host.status = opts.status;
  // Reach into the registry's private map to seed without invoking start().
  (registry as unknown as { map: Map<string, SessionHost> }).map.set(
    sessionKey,
    host,
  );

  // Fake ws — captures every send().
  const wsSent: CapturedEnvelope[] = [];
  const ws = {
    readyState: 1,
    send: (raw: string) => {
      wsSent.push(JSON.parse(raw) as CapturedEnvelope);
    },
  } as unknown as WebSocket;

  const ctx: CommandContext = {
    registry,
    bus,
    generateKey: () => "auto-gen",
    maxSessions: 50,
    routines: {
      // Minimal stub — most commands ignore this.
      list: () => [],
      get: () => null,
      register: () => {},
      remove: () => {},
    } as unknown as CommandContext["routines"],
  };

  return {
    ctx,
    host,
    ws,
    busSent,
    wsSent,
    setQueryHandle(handle: unknown) {
      host.queryHandle = handle as never;
    },
  };
}

/** Helper: build a fake queryHandle that resolves the named method to a value. */
export function fakeQueryHandle(
  responses: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  const handle: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(responses)) {
    if (typeof value === "function") {
      handle[name] = value;
    } else {
      handle[name] = vi.fn(async () => value);
    }
  }
  return handle;
}

/** Build a WsCommand quickly. */
export function cmd(over: Partial<WsCommand> & { type: WsCommand["type"] }): WsCommand {
  return {
    sessionKey: "leader-1",
    requestId: "req-1",
    ...over,
  };
}
