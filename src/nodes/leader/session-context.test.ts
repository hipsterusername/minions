import { describe, expect, it } from "vitest";
import { buildSessionContext, extractLeaderCore } from "./session-context.ts";
import { sessionStreamReducer } from "../../session-stream.ts";
import { seedContextDelivery, diffContextDelivery } from "../../context-delivery.ts";
import type { LeaderData, LeaderMessage } from "./types.ts";

describe("handoff user intent and source delivery", () => {
  it("reserves original instructions and corrections outside the rolling assistant history", () => {
    const messages = [
      { role: "user", content: "ORIGINAL_CONSTRAINT" },
      { role: "user", content: "CORRECTION: use the blue deployment" },
      ...Array.from({ length: 16 }, () => ({ role: "assistant", content: "x".repeat(1990) })),
    ] as LeaderMessage[];
    const prompt = buildSessionContext(messages, [], "Migrate safely");
    expect(prompt).toContain("earlier messages omitted");
    expect(prompt).toContain("ORIGINAL_CONSTRAINT");
    expect(prompt).toContain("CORRECTION");
    expect(prompt).toContain("Later corrections supersede earlier conflicts");
  });

  it("invalidates unchanged and append-only source acknowledgements on a committed checkpoint", () => {
    const source = { nodeId: "spec", nodeType: "markdown", label: "Requirements", content: "prefix" };
    const ledger = seedContextDelivery([source], 1);
    const state = extractLeaderCore({ sessionKey: "leader", status: "idle", messages: [],
      streamingText: "", totalCost: 0, turns: 1, error: null, contextDelivery: ledger } as unknown as LeaderData);
    const event = { type: "session_compacted", sessionKey: "leader", checkpointId: "cp1", oldSessionId: "old", newSessionId: "new", trigger: "proactive", timestamp: 1 } as const;
    const next = sessionStreamReducer(state, event, "lm");
    expect(diffContextDelivery([source], next.contextDelivery!, 2).newItems).toEqual([source]);
    expect(sessionStreamReducer(next, event, "lm")).toBe(next);
    const synced = sessionStreamReducer(state, { type: "sync_response", sessionKey: "leader", found: true, events: [event] }, "lm");
    expect(synced.contextDelivery).toEqual({});
  });
});
