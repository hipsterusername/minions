/**
 * WS-envelope producer ↔ consumer round-trip — the §2.3 Wave 2 rewrite.
 *
 * The shared test in `shared/ws-envelope.test.ts` only covers the topic
 * helper functions. This contract test pins the producer side: every
 * `bus.emit*` call must produce a payload that parses cleanly through
 * the envelope schema, with the topic the helper documents.
 *
 * Per `docs/testing-strategy.md` §5.4 every envelope tested here
 * originates from a real producer (`bus.emit*`). No hand-built literals.
 */

import { describe, expect, it } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus, broadcast, unicastToSession, unicastGlobal } from "../../server/bus.ts";
import {
  GLOBAL_TOPIC,
  projectTopic,
  sessionTopic,
  wsEnvelopeSchema,
  type WsEnvelope,
} from "../../shared/ws-envelope.ts";
import type { WebSocket } from "ws";

interface Capture {
  envelopes: WsEnvelope[];
  /** Raw JSON strings from the WSS broadcast path, parsed back as objects. */
  broadcasts: WsEnvelope[];
}

function rig(): {
  bus: ReturnType<typeof createBus>;
  wss: WebSocketServer;
  ws: WebSocket;
  capture: Capture;
} {
  const envelopes: WsEnvelope[] = [];
  const broadcasts: WsEnvelope[] = [];
  // One real-shaped client whose .send capture lets us verify the
  // broadcast path too.
  const client = {
    readyState: 1,
    send(raw: string) {
      broadcasts.push(JSON.parse(raw) as WsEnvelope);
    },
  } as unknown as WebSocket;
  const wss = { clients: new Set([client]) } as unknown as WebSocketServer;
  const bus = createBus(wss);
  bus.subscribe((env) => envelopes.push(env));
  return { bus, wss, ws: client, capture: { envelopes, broadcasts } };
}

describe("bus.emit* → envelope schema round-trip", () => {
  it("emitToSession produces a payload the envelope schema accepts on the session topic", () => {
    const { bus, capture } = rig();
    bus.emitToSession("leader-1", {
      type: "session_status",
      sessionKey: "leader-1",
      status: "running",
      timestamp: 1,
    });
    expect(capture.envelopes).toHaveLength(1);
    const env = capture.envelopes[0]!;
    const parsed = wsEnvelopeSchema.safeParse(env);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.topic).toBe(sessionTopic("leader-1"));
      expect(parsed.data.type).toBe("session_status");
    }
  });

  it("emitToProject and emitGlobal produce envelope-conformant payloads with the correct topic", () => {
    const { bus, capture } = rig();
    bus.emitToProject("p1", { type: "project_update", projectId: "p1" });
    bus.emitGlobal({ type: "session_list", sessions: [] });

    expect(capture.envelopes).toHaveLength(2);
    for (const env of capture.envelopes) {
      const parsed = wsEnvelopeSchema.safeParse(env);
      expect(parsed.success).toBe(true);
    }
    expect(capture.envelopes[0]!.topic).toBe(projectTopic("p1"));
    expect(capture.envelopes[1]!.topic).toBe(GLOBAL_TOPIC);
  });

  it("the bus fan-out produces the SAME payload for the WSS broadcast and the in-process subscribe path", () => {
    const { bus, capture } = rig();
    bus.emitToSession("leader-1", {
      type: "render_update",
      leaderSessionKey: "leader-1",
      action: "set",
      components: [],
    });
    expect(capture.envelopes).toHaveLength(1);
    expect(capture.broadcasts).toHaveLength(1);
    expect(capture.envelopes[0]).toEqual(capture.broadcasts[0]);
  });

  it("unicastToSession produces an envelope that round-trips through the schema with the right topic", () => {
    const { ws, capture } = rig();
    unicastToSession(ws, "leader-2", {
      type: "control_response",
      command: "set_model",
      sessionKey: "leader-2",
      requestId: null,
      success: true,
    });
    expect(capture.broadcasts).toHaveLength(1);
    const env = capture.broadcasts[0]!;
    const parsed = wsEnvelopeSchema.safeParse(env);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.topic).toBe(sessionTopic("leader-2"));
    }
  });

  it("unicastGlobal lands on the GLOBAL_TOPIC", () => {
    const { ws, capture } = rig();
    unicastGlobal(ws, { type: "error", message: "boom" });
    const env = capture.broadcasts[0]!;
    const parsed = wsEnvelopeSchema.safeParse(env);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.topic).toBe(GLOBAL_TOPIC);
    }
  });

  it("broadcast() — the escape hatch — passes the envelope to every connected OPEN client unchanged", () => {
    const { wss, capture } = rig();
    const env: WsEnvelope = {
      topic: sessionTopic("k"),
      type: "agent_task_update",
      leaderSessionKey: "k",
      taskId: "t1",
      status: "running",
    } as unknown as WsEnvelope;
    broadcast(wss, env);
    expect(capture.broadcasts).toEqual([env]);
  });
});
