import { describe, expect, it } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus } from "../../server/bus.ts";
import { sessionCompactedEnvelopeSchema, wsEnvelopeSchema } from "../../shared/ws-envelope.ts";

describe("contract: session_compacted WS event", () => {
  it("is emitted on the session topic with old/new thread audit fields", () => {
    const sent: string[] = [];
    const client = { readyState: 1, send: (raw: string) => sent.push(raw) };
    const bus = createBus({ clients: new Set([client]) } as unknown as WebSocketServer);

    bus.emitToSession("leader-1", {
      type: "session_compacted",
      sessionKey: "leader-1",
      oldSessionId: "old-thread",
      newSessionId: "new-thread",
      contextTokensBefore: 800_000,
      contextWindowTokens: 1_000_000,
      ratioBefore: 0.8,
      timestamp: 1,
    });

    const envelope = JSON.parse(sent[0]!);
    expect(wsEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(sessionCompactedEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.topic).toBe("session:leader-1");
  });
});

