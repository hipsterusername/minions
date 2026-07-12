import { describe, expect, it } from "vitest";
import { createCodexTranslator } from "../../server/harness/codex/translate.ts";
import { translateSdkMessage } from "../../server/harness/claude/translate.ts";
import { echoHarness } from "../../server/harness/echo/index.ts";
import { normalizedEventSchema } from "../../shared/normalized-event.ts";

describe("harness producers → normalized event consumer", () => {
  it("accepts every event emitted by the echo harness in order", async () => {
    const { events } = echoHarness.start({
      model: "echo",
      prompt: "hello",
      cwd: "/tmp",
      tools: [],
      abortSignal: new AbortController().signal,
    });
    const parsed = [];
    for await (const event of events) parsed.push(normalizedEventSchema.parse(event));

    expect(parsed.map((event) => event.kind)).toEqual(["init", "text", "done"]);
    expect(parsed[1]).toMatchObject({ kind: "text", text: "hello", role: "assistant" });
  });

  it("accepts Claude translator output containing nested tool input and usage", () => {
    const produced = translateSdkMessage({
      type: "assistant",
      session_id: "claude-session",
      parent_tool_use_id: null,
      message: {
        id: "message-1",
        content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/repo/a.ts" } }],
        usage: { input_tokens: 12, output_tokens: 3 },
      },
    });

    expect(produced.map((event) => normalizedEventSchema.parse(event))).toEqual(produced);
    expect(produced.map((event) => event.kind)).toEqual(["tool_call", "usage"]);
  });

  it("accepts Codex translator output across init, progress, and completion", () => {
    const translator = createCodexTranslator({ model: "gpt-5.6-sol" });
    const produced = [
      ...translator.translate({ type: "thread.started", thread_id: "thread-1" } as never),
      ...translator.translate({ type: "item.started", item: { id: "cmd-1", type: "command_execution", command: "pnpm test", status: "in_progress" } } as never),
      ...translator.translate({ type: "item.completed", item: { id: "cmd-1", type: "command_execution", command: "pnpm test", status: "completed", aggregated_output: "ok", exit_code: 0 } } as never),
      ...translator.translate({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4, cached_input_tokens: 2 } } as never),
    ];

    expect(produced.map((event) => normalizedEventSchema.parse(event))).toEqual(produced);
    expect(produced.map((event) => event.kind)).toEqual(["init", "tool_call", "tool_result", "usage"]);
  });

  it("rejects malformed persisted or wire events before consumers switch on them", () => {
    expect(normalizedEventSchema.safeParse({ kind: "text", role: "assistant" }).success).toBe(false);
    expect(normalizedEventSchema.safeParse({ kind: "usage", input: -1, output: 2 }).success).toBe(false);
    expect(normalizedEventSchema.safeParse({ kind: "not-a-real-event" }).success).toBe(false);
  });
});
