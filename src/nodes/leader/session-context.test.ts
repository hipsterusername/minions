import { describe, expect, it } from "vitest";
import { buildSessionContext, extractLeaderCore } from "./session-context.ts";
import { sessionStreamReducer } from "../../session-stream.ts";
import { seedContextDelivery, diffContextDelivery } from "../../context-delivery.ts";
import type { LeaderData, LeaderMessage } from "./types.ts";
import { LEADER_DEFAULT_DATA } from "./types.ts";
import { buildInitialLeaderRun } from "./initial-run.ts";

describe("handoff user intent and source delivery", () => {
  it("keeps legacy history bounded without pinning the first request as a directive", () => {
    const messages = [
      { role: "user", content: "ORIGINAL_CONSTRAINT" },
      { role: "user", content: "CORRECTION: use the blue deployment" },
      ...Array.from({ length: 16 }, () => ({ role: "assistant", content: "x".repeat(1990) })),
    ] as LeaderMessage[];
    const prompt = buildSessionContext(messages, [], "Migrate safely");
    expect(prompt).toContain("earlier messages omitted");
    expect(prompt).not.toContain("ORIGINAL_CONSTRAINT");
    expect(prompt).not.toContain("CORRECTION");
    expect(prompt).not.toContain("<user-directives>");
  });

  it("leaves canonical iteration history to the server while delivering the latest request and sources", () => {
    const result = buildInitialLeaderRun({ userPrompt: "Make the button blue.",
      data: { ...LEADER_DEFAULT_DATA, workItemId: "work-1", messages: [
        { id: "old", role: "user", content: "ORIGINAL_REQUEST", timestamp: 1 },
      ] }, incomingModes: [], contextItems: [
        { nodeId: "spec", nodeType: "markdown", label: "Requirements", content: "CURRENT_SPEC" },
      ] });
    expect(result.prompt).toContain("CURRENT_SPEC");
    expect(result.prompt).toContain("Make the button blue.");
    expect(result.prompt).not.toContain("ORIGINAL_REQUEST");
    expect(result.prompt).not.toContain("<session-continuation>");
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
