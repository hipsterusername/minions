import { describe, expect, it } from "vitest";
import { emptySessionStreamState, sessionStreamReducer } from "./session-stream.ts";
import { buildSessionContext } from "./nodes/leader/session-context.ts";
describe("history window stream contract", () => {
  it("consumes live and replayed archive previews without creating transcript messages", () => {
    const archived = { type: "sdk_event" as const, sessionKey: "s", timestamp: 1, historyId: 1,
      historyRef: { id: 1, bytes: 100_000, url: "/api/history/s/events/1" },
      event: { kind: "text" as const, role: "assistant" as const,
        text: "[Archive preview] Archived event\nRAW_TOOL_OUTPUT" } };
    const live = sessionStreamReducer(emptySessionStreamState("s"), archived, "lm");
    const replayed = sessionStreamReducer(emptySessionStreamState("s"), {
      type: "sync_response", sessionKey: "s", found: true, events: [archived],
    }, "lm");
    expect(live.messages).toEqual(replayed.messages);
    expect(live.messages).toEqual([]);
    expect(live.historyHighWater).toBe(1);
    expect(sessionStreamReducer(live, archived, "lm")).toBe(live);
    expect(JSON.stringify(live.messages)).not.toContain("RAW_TOOL_OUTPUT");
    expect(buildSessionContext(live.messages)).toBe("");
  });
  it("keeps archived tool results out of prose without clearing an active text stream", () => {
    const state = { ...emptySessionStreamState("s"), streamingText: "Working", streamingBlockIndex: 0 };
    const next = sessionStreamReducer(state, { type: "sdk_event", sessionKey: "s", historyId: 1,
      historyRef: { id: 1, bytes: 100_000, url: "/api/history/s/events/1" },
      event: { kind: "tool_result", callId: "call-1", output: "Archived event", isError: false },
    }, "lm");
    expect(next.streamingText).toBe("Working");
    expect(next.messages).toEqual([]);
    expect(next.historyHighWater).toBe(1);
    expect(buildSessionContext(next.messages)).toBe("");
  });
  it("removes saved archive placeholders when replay has no displayable messages", () => {
    const state = { ...emptySessionStreamState("s"), messages: [
      { id: "lm-archive-42", role: "system" as const, timestamp: 1,
        content: "[Read archived event (16384 bytes)](/api/history/run-00000000-0000-4000-8000-000000000001/events/42)" },
    ] };
    const next = sessionStreamReducer(state, { type: "sync_response", sessionKey: "s", found: true, events: [] }, "lm");
    expect(next.messages).toEqual([]);
  });
  const sdk = (id: number) => ({ type: "sdk_event" as const, sessionKey: "s", historyId: id,
    event: { kind: "text" as const, role: "assistant" as const, text: `event ${id}`, id: String(id) } });
  it("deduplicates replay/live IDs and rejects older snapshots after newer live delivery", () => {
    let state = emptySessionStreamState("s");
    state = sessionStreamReducer(state, sdk(10), "s");
    expect(sessionStreamReducer(state, sdk(10), "s")).toBe(state);
    expect(sessionStreamReducer(state, { type: "sync_response", sessionKey: "s", found: true,
      status: "stopped", history: { before: 2, highWater: 9, url: "/api/history/s" }, events: [] }, "s")).toBe(state);
    state = sessionStreamReducer(state, sdk(11), "s");
    expect(state.messages.map(m => m.content)).toEqual(["event 10", "event 11"]);
  });
  it("restores authoritative status/counters after folding historical events and exposes older history", () => {
    const state = sessionStreamReducer(emptySessionStreamState("s"), { type: "sync_response", sessionKey: "s", found: true,
      status: "stopped", totalCost: 4, turns: 8, lastError: null,
      history: { before: 3, highWater: 4, url: "/api/history/s" }, events: [
        { type: "session_status", sessionKey: "s", status: "running", timestamp: 1 },
        { type: "sdk_event", sessionKey: "s", timestamp: 2, event: { kind: "usage", input: 0, output: 0, costUSD: 1 } },
      ] }, "s");
    expect(state.status).toBe("stopped"); expect(state.totalCost).toBe(4); expect(state.turns).toBe(8);
    expect(state.messages[0]?.content).toContain("/api/history/s?before=3");
  });
  it("bounds growing client transcripts while retaining archive navigation", () => {
    let state = emptySessionStreamState("s");
    for (let i = 1; i < 1000; i++) state = sessionStreamReducer(state, sdk(i), "s");
    expect(state.messages.length).toBeLessThanOrEqual(201);
    expect(JSON.stringify(state.messages).length * 2).toBeLessThan(513 * 1024);
    expect(state.messages[0]?.content).toContain("/api/history/s");
    expect(state.messages.at(-1)?.content).toBe("event 999");
  });
});
