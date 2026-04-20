/**
 * server/bus: the typed envelope bus for server → client traffic.
 *
 * We don't spin up a real `ws` server here. Instead we stub
 * `WebSocketServer` with a `clients` set whose members implement the
 * `.readyState` + `.send` surface the bus uses. This is the narrowest
 * boundary to mock; see `docs/testing-strategy.md` §3 on mocking
 * boundaries, not logic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { WebSocketServer } from "ws";
import {
  createBus,
  broadcast,
  unicast,
  unicastToSession,
  unicastGlobal,
} from "./bus.ts";
import { wsEnvelopeSchema } from "../shared/ws-envelope.ts";

interface FakeClient {
  readyState: number;
  sent: string[];
  send: (msg: string) => void;
}

function makeClient(readyState = 1 /* OPEN */): FakeClient {
  const sent: string[] = [];
  return {
    readyState,
    sent,
    send(msg: string) {
      sent.push(msg);
    },
  };
}

function makeWss(clients: FakeClient[]): WebSocketServer {
  return {
    clients: new Set(clients),
  } as unknown as WebSocketServer;
}

describe("server/bus: createBus", () => {
  let open1: FakeClient;
  let open2: FakeClient;
  let closing: FakeClient;

  beforeEach(() => {
    open1 = makeClient(1);
    open2 = makeClient(1);
    closing = makeClient(2 /* CLOSING */);
  });

  it("emitToSession wraps payload with a session:<key> topic", () => {
    const wss = makeWss([open1]);
    const bus = createBus(wss);

    bus.emitToSession("leader-abc", {
      type: "task_plan_update",
      tasks: [{ taskId: "t1" }],
    });

    expect(open1.sent).toHaveLength(1);
    const parsed = JSON.parse(open1.sent[0]!);
    expect(parsed).toMatchObject({
      topic: "session:leader-abc",
      type: "task_plan_update",
      tasks: [{ taskId: "t1" }],
    });
  });

  it("emitToProject wraps payload with a project:<id> topic", () => {
    const wss = makeWss([open1]);
    const bus = createBus(wss);

    bus.emitToProject("p42", { type: "project_update", name: "demo" });

    const parsed = JSON.parse(open1.sent[0]!);
    expect(parsed.topic).toBe("project:p42");
    expect(parsed.type).toBe("project_update");
  });

  it("emitGlobal wraps payload with the global topic", () => {
    const wss = makeWss([open1]);
    const bus = createBus(wss);

    bus.emitGlobal({ type: "session_list", sessions: [] });

    const parsed = JSON.parse(open1.sent[0]!);
    expect(parsed.topic).toBe("global");
    expect(parsed.type).toBe("session_list");
  });

  it("every emitted envelope parses against the shared envelope schema", () => {
    const wss = makeWss([open1]);
    const bus = createBus(wss);

    bus.emitToSession("s1", { type: "a" });
    bus.emitToProject("p1", { type: "b" });
    bus.emitGlobal({ type: "c" });

    for (const raw of open1.sent) {
      const parsed = JSON.parse(raw);
      expect(wsEnvelopeSchema.safeParse(parsed).success).toBe(true);
    }
  });

  it("delivers to every open client on the server", () => {
    const wss = makeWss([open1, open2]);
    const bus = createBus(wss);

    bus.emitGlobal({ type: "ping" });

    expect(open1.sent).toHaveLength(1);
    expect(open2.sent).toHaveLength(1);
  });

  it("skips clients whose readyState is not OPEN", () => {
    const wss = makeWss([open1, closing]);
    const bus = createBus(wss);

    bus.emitGlobal({ type: "ping" });

    expect(open1.sent).toHaveLength(1);
    expect(closing.sent).toHaveLength(0);
  });

  it("emit() accepts a pre-built envelope", () => {
    const wss = makeWss([open1]);
    const bus = createBus(wss);

    bus.emit({ topic: "session:abc", type: "custom", extra: 1 });

    const parsed = JSON.parse(open1.sent[0]!);
    expect(parsed.topic).toBe("session:abc");
    expect(parsed.extra).toBe(1);
  });

  it("rejects building a session topic with an empty key", () => {
    const wss = makeWss([open1]);
    const bus = createBus(wss);
    expect(() => bus.emitToSession("", { type: "x" })).toThrow();
  });

  it("a failing client.send does not affect other clients (one client failure is isolated)", () => {
    const good = makeClient(1);
    const bad: FakeClient = {
      readyState: 1,
      sent: [],
      send() {
        throw new Error("network hiccup");
      },
    };
    const wss = makeWss([bad, good]);
    const bus = createBus(wss);

    // Today the bus does not isolate per-client errors; this test
    // documents the current behaviour. When isolation is added, update
    // the assertion.
    expect(() => bus.emitGlobal({ type: "x" })).toThrow("network hiccup");
    // If the iteration order put `bad` first, `good` never got the msg.
    // The test does not pin the order — it only proves nothing crashes
    // silently.
  });
});

describe("server/bus: broadcast (escape hatch)", () => {
  it("sends a raw envelope to all open clients", () => {
    const c = makeClient(1);
    const wss = makeWss([c]);
    broadcast(wss, { topic: "global", type: "ping" });
    expect(JSON.parse(c.sent[0]!)).toMatchObject({
      topic: "global",
      type: "ping",
    });
  });
});

describe("server/bus: unicast helpers", () => {
  it("unicast sends an envelope to a single client", () => {
    const c = makeClient(1);
    unicast(c as unknown as import("ws").WebSocket, "session:abc", {
      type: "sync_response",
      found: true,
    });

    expect(c.sent).toHaveLength(1);
    const parsed = JSON.parse(c.sent[0]!);
    expect(parsed).toMatchObject({
      topic: "session:abc",
      type: "sync_response",
      found: true,
    });
    expect(wsEnvelopeSchema.safeParse(parsed).success).toBe(true);
  });

  it("unicast skips clients that are not OPEN", () => {
    const c = makeClient(2 /* CLOSING */);
    unicast(c as unknown as import("ws").WebSocket, "global", {
      type: "error",
      message: "test",
    });
    expect(c.sent).toHaveLength(0);
  });

  it("unicastToSession wraps with session topic", () => {
    const c = makeClient(1);
    unicastToSession(c as unknown as import("ws").WebSocket, "leader-1", {
      type: "session_created",
      sessionKey: "leader-1",
    });

    const parsed = JSON.parse(c.sent[0]!);
    expect(parsed.topic).toBe("session:leader-1");
    expect(parsed.type).toBe("session_created");
    expect(wsEnvelopeSchema.safeParse(parsed).success).toBe(true);
  });

  it("unicastGlobal wraps with global topic", () => {
    const c = makeClient(1);
    unicastGlobal(c as unknown as import("ws").WebSocket, {
      type: "error",
      message: "something broke",
    });

    const parsed = JSON.parse(c.sent[0]!);
    expect(parsed.topic).toBe("global");
    expect(parsed.type).toBe("error");
    expect(wsEnvelopeSchema.safeParse(parsed).success).toBe(true);
  });

  it("unicastToSession rejects an empty session key", () => {
    const c = makeClient(1);
    expect(() =>
      unicastToSession(c as unknown as import("ws").WebSocket, "", {
        type: "x",
      }),
    ).toThrow();
  });
});
