/**
 * Tests for the `create_session` command handler — pinned around the two
 * regressions that broke NEW leader initiation in production:
 *
 *   1. The cap counts *live* sessions, not on-disk records. A registry
 *      hydrated with `MAX_SESSIONS` stopped sessions must still accept a
 *      new `create_session`.
 *   2. Rejection routing: when the client supplies a `sessionKey` (every
 *      LeaderNode does), a rejection MUST go out as a session-scoped
 *      `session_error` so the LeaderNode reducer transitions to
 *      `status: "error"`. Sending it to the global topic gets dropped
 *      and the UI sticks at `creating` forever.
 */

import { describe, expect, it } from "vitest";
import { createSession } from "./create-session.ts";
import { SessionRegistry } from "../session-registry.ts";
import { SessionHost } from "../session-host.ts";
import type { CommandContext, WsCommand } from "./types.ts";
import type { Bus } from "../bus.ts";
import type { StartSessionOptions } from "../session-host.ts";
// Side-effect: registers EchoHarness so the harness-validation branch can
// look it up via `registeredHarnessNames()`.
import "../harness/echo/index.ts";

interface SentMessage {
  payload: unknown;
}

/** Capture every `ws.send` call as a parsed JSON object. */
function makeFakeWs(): { ws: { send: (s: string) => void; readyState: 1 }; sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  return {
    sent,
    ws: {
      readyState: 1, // OPEN — `unicast` checks this before sending
      send: (raw: string) => sent.push({ payload: JSON.parse(raw) }),
    },
  };
}

function makeBus(): Bus {
  // None of the rejection paths use the bus — every reply goes via
  // `unicast*`. We supply a no-op bus for the success path.
  return {
    emit: () => {},
    emitToSession: () => {},
    emitToProject: () => {},
    emitGlobal: () => {},
    subscribe: () => () => {},
  };
}

function makeCtx(registry: SessionRegistry, maxSessions: number): CommandContext {
  return {
    registry,
    bus: makeBus(),
    generateKey: () => "auto-key",
    maxSessions,
    routines: {
      list: () => [],
      get: () => null,
      register: () => {},
      remove: () => {},
    } as unknown as CommandContext["routines"],
  };
}

function fillRegistryWithStopped(
  r: SessionRegistry,
  count: number,
): void {
  const map = (r as unknown as { map: Map<string, SessionHost> }).map;
  for (let i = 0; i < count; i++) {
    const h = new SessionHost(`hydrated-${i}`, "/tmp/work");
    h.status = "stopped";
    map.set(h.id, h);
  }
}

function fillRegistryWithRunning(
  r: SessionRegistry,
  count: number,
): void {
  const map = (r as unknown as { map: Map<string, SessionHost> }).map;
  for (let i = 0; i < count; i++) {
    const h = new SessionHost(`live-${i}`, "/tmp/work");
    h.status = "running";
    map.set(h.id, h);
  }
}

describe("createSession — MAX_SESSIONS cap", () => {
  it("accepts a new session when the registry holds N stopped (hydrated) sessions where N === maxSessions (regression)", () => {
    const registry = new SessionRegistry();
    fillRegistryWithStopped(registry, 50);

    // setDeps so the start() call inside the handler doesn't throw.
    // We don't care if the SDK actually opens — we just need the cap
    // check to pass and the unicast `session_created` to fire.
    registry.setDeps({
      bus: makeBus(),
      startChildSession: () => {},
      forEachLeaderTaskState: () => {},
    });

    const { ws, sent } = makeFakeWs();
    const ctx = makeCtx(registry, 50);
    const cmd: WsCommand = {
      type: "create_session",
      sessionKey: "leader-new",
      prompt: "hi",
      cwd: process.cwd(),
      role: "leader",
    };

    createSession(ctx, cmd, ws as unknown as Parameters<typeof createSession>[2]);

    const types = sent.map((m) => (m.payload as { type: string }).type);
    expect(types).toContain("session_created");
    expect(types).not.toContain("error");
    expect(types).not.toContain("session_error");
  });

  it("rejects when the registry is full of LIVE sessions, not stopped ones", () => {
    const registry = new SessionRegistry();
    fillRegistryWithRunning(registry, 3);

    const { ws, sent } = makeFakeWs();
    const ctx = makeCtx(registry, 3);
    const cmd: WsCommand = {
      type: "create_session",
      sessionKey: "leader-new",
      prompt: "hi",
      cwd: process.cwd(),
      role: "leader",
    };

    createSession(ctx, cmd, ws as unknown as Parameters<typeof createSession>[2]);

    const types = sent.map((m) => (m.payload as { type: string }).type);
    expect(types).toContain("session_error");
  });
});

describe("createSession — rejection routing", () => {
  it("sends a session-scoped session_error when sessionKey is supplied (LeaderNode UI can recover)", () => {
    const registry = new SessionRegistry();
    fillRegistryWithRunning(registry, 1);

    const { ws, sent } = makeFakeWs();
    const ctx = makeCtx(registry, 1);
    const cmd: WsCommand = {
      type: "create_session",
      sessionKey: "leader-rejected",
      prompt: "go",
    };

    createSession(ctx, cmd, ws as unknown as Parameters<typeof createSession>[2]);

    expect(sent).toHaveLength(1);
    const env = sent[0]?.payload as Record<string, unknown>;
    expect(env["topic"]).toBe("session:leader-rejected");
    expect(env["type"]).toBe("session_error");
    expect(env["sessionKey"]).toBe("leader-rejected");
    expect(typeof env["error"]).toBe("string");
    expect(env["error"]).toMatch(/Maximum session limit/);
  });

  it("falls back to global error when no sessionKey is supplied", () => {
    const registry = new SessionRegistry();
    fillRegistryWithRunning(registry, 1);

    const { ws, sent } = makeFakeWs();
    const ctx = makeCtx(registry, 1);
    const cmd: WsCommand = {
      type: "create_session",
      // no sessionKey
      prompt: "go",
    };

    createSession(ctx, cmd, ws as unknown as Parameters<typeof createSession>[2]);

    expect(sent).toHaveLength(1);
    const env = sent[0]?.payload as Record<string, unknown>;
    expect(env["topic"]).toBe("global");
    expect(env["type"]).toBe("error");
  });

  it("forwards `permissionMode` into registry.start so the harness sees it", () => {
    const registry = new SessionRegistry();
    const starts: StartSessionOptions[] = [];
    (registry as unknown as { start: (opts: StartSessionOptions) => void }).start = (
      opts,
    ) => {
      starts.push(opts);
    };

    const { ws } = makeFakeWs();
    const ctx = makeCtx(registry, 50);
    const cmd: WsCommand = {
      type: "create_session",
      sessionKey: "leader-perm",
      prompt: "hi",
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
    };

    createSession(ctx, cmd, ws as unknown as Parameters<typeof createSession>[2]);

    expect(starts).toHaveLength(1);
    expect(starts[0]?.permissionMode).toBe("bypassPermissions");
  });

  it("omits permissionMode from the registry.start payload when the command lacks it", () => {
    const registry = new SessionRegistry();
    const starts: StartSessionOptions[] = [];
    (registry as unknown as { start: (opts: StartSessionOptions) => void }).start = (
      opts,
    ) => {
      starts.push(opts);
    };

    const { ws } = makeFakeWs();
    const ctx = makeCtx(registry, 50);
    const cmd: WsCommand = {
      type: "create_session",
      sessionKey: "leader-no-perm",
      prompt: "hi",
      cwd: process.cwd(),
    };

    createSession(ctx, cmd, ws as unknown as Parameters<typeof createSession>[2]);

    expect(starts).toHaveLength(1);
    expect(starts[0]).not.toHaveProperty("permissionMode");
  });

  it("forwards a valid `harness` into registry.start so the host runs on it", () => {
    const registry = new SessionRegistry();
    // Capture every registry.start() call.
    const starts: StartSessionOptions[] = [];
    (registry as unknown as { start: (opts: StartSessionOptions) => void }).start = (
      opts,
    ) => {
      starts.push(opts);
    };

    const { ws, sent } = makeFakeWs();
    const ctx = makeCtx(registry, 50);
    const cmd: WsCommand = {
      type: "create_session",
      sessionKey: "leader-echo",
      prompt: "hi",
      cwd: process.cwd(),
      harness: "echo",
    };

    createSession(ctx, cmd, ws as unknown as Parameters<typeof createSession>[2]);

    expect(starts).toHaveLength(1);
    expect(starts[0]?.harness).toBe("echo");
    const types = sent.map((m) => (m.payload as { type: string }).type);
    expect(types).toContain("session_created");
    expect(types).not.toContain("session_error");
  });

  it("rejects an unknown harness with a session-scoped session_error and does not start a host", () => {
    const registry = new SessionRegistry();
    const starts: StartSessionOptions[] = [];
    (registry as unknown as { start: (opts: StartSessionOptions) => void }).start = (
      opts,
    ) => {
      starts.push(opts);
    };

    const { ws, sent } = makeFakeWs();
    const ctx = makeCtx(registry, 50);
    const cmd: WsCommand = {
      type: "create_session",
      sessionKey: "leader-bad-harness",
      prompt: "hi",
      cwd: process.cwd(),
      harness: "definitely-not-registered",
    };

    createSession(ctx, cmd, ws as unknown as Parameters<typeof createSession>[2]);

    // Host was never started.
    expect(starts).toHaveLength(0);
    expect(registry.has("leader-bad-harness")).toBe(false);

    // Session-scoped session_error envelope so the LeaderNode reducer
    // surfaces it; a global `error` would be silently dropped.
    expect(sent).toHaveLength(1);
    const env = sent[0]?.payload as Record<string, unknown>;
    expect(env["topic"]).toBe("session:leader-bad-harness");
    expect(env["type"]).toBe("session_error");
    expect(env["error"]).toMatch(/Unknown harness/);
    expect(env["error"]).toMatch(/definitely-not-registered/);
  });

  it("routes invalid-cwd rejection to the session topic too", () => {
    const registry = new SessionRegistry();
    registry.setDeps({
      bus: makeBus(),
      startChildSession: () => {},
      forEachLeaderTaskState: () => {},
    });

    const { ws, sent } = makeFakeWs();
    const ctx = makeCtx(registry, 50);
    const cmd: WsCommand = {
      type: "create_session",
      sessionKey: "leader-bad-cwd",
      prompt: "go",
      // path-guard rejects anything outside HOME — `/etc` is always outside
      cwd: "/etc",
    };

    createSession(ctx, cmd, ws as unknown as Parameters<typeof createSession>[2]);

    expect(sent).toHaveLength(1);
    const env = sent[0]?.payload as Record<string, unknown>;
    expect(env["topic"]).toBe("session:leader-bad-cwd");
    expect(env["type"]).toBe("session_error");
    expect(env["error"]).toMatch(/Invalid cwd/);
  });
});
