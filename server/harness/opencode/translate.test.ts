import { describe, expect, it } from "vitest";
import { createOpenCodeTranslator } from "./translate.ts";

describe("OpenCode event translation", () => {
  it("emits init, text, tool lifecycle, and usage", () => {
    const translator = createOpenCodeTranslator("openai/gpt-5.2", "fallback");
    expect(translator.translate({ type: "step_start", part: { sessionID: "ses-1" } })).toEqual([
      { kind: "init", sessionId: "ses-1", model: "openai/gpt-5.2" },
    ]);
    expect(translator.translate({ type: "text", part: { id: "p1", text: "hello" } })).toEqual([
      { kind: "text", role: "assistant", text: "hello", id: "p1" },
    ]);
    expect(translator.translate({ type: "tool_use", part: {
      callID: "call-1", tool: "bash", state: { status: "completed", input: { command: "pwd" }, output: "/repo" },
    } })).toEqual([
      { kind: "tool_call", id: "call-1", name: "bash", input: { command: "pwd" } },
      { kind: "tool_result", callId: "call-1", output: "/repo", isError: false },
    ]);
    expect(translator.translate({ type: "step_finish", part: {
      sessionID: "ses-1", cost: 0.01, tokens: { input: 10, output: 3, cache: { read: 2, write: 1 } },
    } })).toEqual([{ kind: "usage", source: "turn_completed", input: 10, output: 3,
      cacheRead: 2, cacheCreation: 1, costUSD: 0.01, sdkSessionId: "ses-1" }]);
    expect(translator.result()).toBe("hello");
  });

  it("turns an error record into the terminal event", () => {
    const translator = createOpenCodeTranslator("local/model", "fallback");
    expect(translator.translate({ type: "error", message: "provider failed" })).toEqual([
      { kind: "init", sessionId: "fallback", model: "local/model" },
      { kind: "done", reason: "error", error: "provider failed" },
    ]);
    expect(translator.terminalSeen()).toBe(true);
  });
});
