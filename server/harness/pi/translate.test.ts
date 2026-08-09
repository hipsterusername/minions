import { describe, expect, it, vi } from "vitest";
import { createPiTranslator } from "./translate.ts";

describe("Pi event translation", () => {
  it("translates session, deltas, tools, usage, and completion", () => {
    vi.useFakeTimers();
    try {
      const translator = createPiTranslator("anthropic/claude-sonnet-4-5", "fallback", "auto");
      expect(translator.translate({ type: "session", id: "pi-session" })).toEqual([
        { kind: "init", sessionId: "pi-session", model: "anthropic/claude-sonnet-4-5", permissionMode: "auto" },
      ]);
      translator.translate({ type: "turn_start" });
      expect(translator.translate({ type: "message_update", assistantMessageEvent: {
        type: "text_delta", contentIndex: 0, delta: "Hello",
      } })).toEqual([{ kind: "text_delta", text: "Hello", blockIndex: 0 }]);
      expect(translator.translate({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "a.ts" } })).toEqual([
        { kind: "tool_call", id: "tool-1", name: "read", input: { path: "a.ts" } },
      ]);
      vi.advanceTimersByTime(1500);
      expect(translator.translate({ type: "tool_execution_update", toolCallId: "tool-1", toolName: "read" })[0]).toMatchObject({
        kind: "tool_progress", id: "tool-1", elapsedSeconds: 1.5,
      });
      expect(translator.translate({ type: "message_end", message: {
        role: "assistant", content: [{ type: "text", text: "Hello" }],
        usage: { input: 5, output: 2, cacheRead: 1, cacheWrite: 0, cost: { total: 0.001 } },
      } })).toEqual([{ kind: "usage", source: "assistant", input: 5, output: 2,
        cacheRead: 1, cacheCreation: 0, costUSD: 0.001 }]);
      expect(translator.translate({ type: "agent_end", messages: [] })).toEqual([
        { kind: "stream_end" },
        { kind: "done", reason: "completed", result: "Hello", turns: 1 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the final message when no deltas were emitted", () => {
    const translator = createPiTranslator("local/model", "fallback");
    expect(translator.translate({ type: "message_end", message: {
      role: "assistant", content: [{ type: "text", text: "Complete answer" }],
    } })).toEqual([
      { kind: "init", sessionId: "fallback", model: "local/model" },
      { kind: "text", role: "assistant", text: "Complete answer" },
    ]);
    expect(translator.result()).toBe("Complete answer");
  });
});
