/**
 * Shared test harness for `server/commands/*.test.ts`.
 *
 * The dispatcher contract is: `(ctx, cmd, ws) => void`. Every handler
 * looks up the session via the registry, checks `host.runControl`, and either:
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
 *
 * Phase A: replaced `setQueryHandle`/`fakeQueryHandle` with
 * `setRunControl`/`fakeRunControl` to match the new HarnessRunControl surface.
 * Also imports the EchoHarness side-effect so tests that call `getHarness()`
 * for staticInfo queries have a registered harness available.
 */

import type { WebSocket, WebSocketServer } from "ws";
import { vi } from "vitest";
import { createBus, type Bus } from "../../server/bus.ts";
import { SessionHost } from "../../server/session-host.ts";
import { SessionRegistry } from "../../server/session-registry.ts";
import type { HarnessRunControl } from "../../server/harness/types.ts";
import type { CommandContext, WsCommand } from "../../server/commands/types.ts";

// Side-effect: register EchoHarness so tests that set harnessName = "echo"
// can call getHarness("echo").staticInfo() without errors.
import "../../server/harness/echo/index.ts";

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
  /** Set host.runControl for the current test. */
  setRunControl: (control: HarnessRunControl | null) => void;
  /** Set host.eventStream for the current test (rarely needed). */
  setEventStream: (stream: AsyncIterable<unknown> | null) => void;
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
    launchSession: async (options) => {
      registry.start(options);
      return { sessionKey: options.sessionKey, harness: options.harness ?? "claude", model: options.initialModel ?? "", permissionMode: options.permissionMode ?? "auto", reasons: [] };
    },
  };

  return {
    ctx,
    host,
    ws,
    busSent,
    wsSent,
    setRunControl(control: HarnessRunControl | null) {
      host.runControl = control;
    },
    setEventStream(stream: AsyncIterable<unknown> | null) {
      host.eventStream = stream as never;
    },
  };
}

/**
 * Build a fake HarnessRunControl for use in command tests.
 *
 * Pass any subset of HarnessRunControl methods; the result is cast as a full
 * HarnessRunControl so TypeScript accepts it in `setRunControl(...)`. Methods
 * not provided are simply absent at runtime — command handlers detect this and
 * return the "unsupported by harness" error.
 *
 * Example:
 *   setRunControl(fakeRunControl({ interrupt: vi.fn(async () => undefined) }))
 */
export function fakeRunControl(
  overrides: Partial<HarnessRunControl> = {},
): HarnessRunControl {
  return {
    abort() {},
    ...overrides,
  } as HarnessRunControl;
}

/** Build a WsCommand quickly. */
export function cmd(over: Partial<WsCommand> & { type: WsCommand["type"] }): WsCommand {
  return {
    sessionKey: "leader-1",
    requestId: "req-1",
    ...over,
  };
}
