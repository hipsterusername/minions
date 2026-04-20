/**
 * Contract: every server → client WebSocket message parses against the
 * shared envelope schema.
 *
 * `shared/ws-envelope.ts` is the single source of truth for the shape of
 * server → client traffic. The bus in `server/bus.ts` wraps every payload
 * in this envelope before sending, and the client in `src/use-socket.ts`
 * validates incoming messages against the same schema.
 *
 * This test runs `createBus(...)` against a stubbed `WebSocketServer` and
 * asserts that the full matrix of emission helpers (session / project /
 * global) produces envelopes that parse cleanly. It's a contract, not a
 * unit test — its job is to fail loudly if someone changes the bus or
 * the envelope shape in a way that drifts them apart.
 */

import { describe, it, expect } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus } from "../../server/bus.ts";
import { wsEnvelopeSchema } from "../../shared/ws-envelope.ts";

interface FakeClient {
  readyState: number;
  sent: string[];
  send: (msg: string) => void;
}

function makeClient(): FakeClient {
  const sent: string[] = [];
  return {
    readyState: 1, // OPEN
    sent,
    send(msg: string) {
      sent.push(msg);
    },
  };
}

function makeWss(client: FakeClient): WebSocketServer {
  return { clients: new Set([client]) } as unknown as WebSocketServer;
}

describe("contract: server → client envelope shape", () => {
  it("session, project, and global emissions all produce valid envelopes", () => {
    const client = makeClient();
    const bus = createBus(makeWss(client));

    bus.emitToSession("leader-abc", {
      type: "task_plan_update",
      leaderSessionKey: "leader-abc",
      tasks: [{ taskId: "t1", title: "demo" }],
    });
    bus.emitToProject("p42", {
      type: "project_update",
      name: "demo project",
    });
    bus.emitGlobal({ type: "session_list", sessions: [] });

    expect(client.sent).toHaveLength(3);

    const envelopes = client.sent.map((raw) => JSON.parse(raw));

    for (const envelope of envelopes) {
      const result = wsEnvelopeSchema.safeParse(envelope);
      expect(
        result.success,
        `envelope failed schema: ${JSON.stringify(envelope)}`,
      ).toBe(true);
    }

    // Topic grammar is respected.
    expect(envelopes[0].topic).toBe("session:leader-abc");
    expect(envelopes[1].topic).toBe("project:p42");
    expect(envelopes[2].topic).toBe("global");
  });

  it("payload fields are preserved at the top level (legacy `type` listeners keep working)", () => {
    const client = makeClient();
    const bus = createBus(makeWss(client));

    bus.emitToSession("s1", {
      type: "render_update",
      leaderSessionKey: "s1",
      action: "set",
      components: [{ id: "c1", type: "metric", label: "X", value: 1 }],
    });

    const envelope = JSON.parse(client.sent[0]!);
    expect(envelope.type).toBe("render_update");
    expect(envelope.action).toBe("set");
    expect(envelope.components).toEqual([
      { id: "c1", type: "metric", label: "X", value: 1 },
    ]);
  });

  it("emit() with a pre-built envelope also conforms", () => {
    const client = makeClient();
    const bus = createBus(makeWss(client));

    bus.emit({
      topic: "session:xyz",
      type: "sdk_event",
      sessionKey: "xyz",
      message: { type: "assistant" } as never,
    });

    const envelope = JSON.parse(client.sent[0]!);
    expect(wsEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });
});
