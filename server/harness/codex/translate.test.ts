
import { describe, it, expect, vi, afterEach } from "vitest";
import { createCodexTranslator } from "./translate.ts";

function makeTranslator(model = "codex-mini-latest") {
  return createCodexTranslator({ model });
}

describe("thread.started", () => {
  it("emits init with thread_id as sessionId and the requested model", () => {
    const tr = makeTranslator("o4-mini");
    const events = tr.translate({ type: "thread.started", thread_id: "th-abc" });
    expect(events).toEqual([{ kind: "init", sessionId: "th-abc", model: "o4-mini" }]);
  });

  it("uses the model passed to the translator, not a default", () => {
    const tr = makeTranslator("codex-mini-latest");
    const events = tr.translate({ type: "thread.started", thread_id: "th-xyz" });
    const init = events[0] as { kind: string; model: string } | undefined;
    expect(init?.model).toBe("codex-mini-latest");
  });
});

describe("turn.started", () => {
  it("is swallowed (returns empty array)", () => {
    const tr = makeTranslator();
    expect(tr.translate({ type: "turn.started" })).toEqual([]);
  });
});

describe("item.started: mcp_tool_call", () => {
  it("emits tool_call with mcp__<server>__<tool> name and arguments as input", () => {
    const tr = makeTranslator();
    const events = tr.translate({
      type: "item.started",
      item: {
        id: "mcp-1",
        type: "mcp_tool_call",
        server: "task-manager",
        tool: "plan_task",
        arguments: { title: "Implement feature" },
        status: "in_progress",
      },
    });
    expect(events).toEqual([
      {
        kind: "tool_call",
        id: "mcp-1",
        name: "mcp__task-manager__plan_task",
        input: { title: "Implement feature" },
      },
    ]);
  });
});

describe("item.updated: mcp_tool_call", () => {
  it("emits tool_progress with mcp__<server>__<tool> name and elapsedSeconds", () => {
    vi.useFakeTimers();
    try {
      const tr = makeTranslator();
      tr.translate({
        type: "item.started",
        item: {
          id: "mcp-2",
          type: "mcp_tool_call",
          server: "minion-tools",
          tool: "report_step",
          arguments: {},
          status: "in_progress",
        },
      });
      vi.advanceTimersByTime(2000);
      const events = tr.translate({
        type: "item.updated",
        item: {
          id: "mcp-2",
          type: "mcp_tool_call",
          server: "minion-tools",
          tool: "report_step",
          arguments: {},
          status: "in_progress",
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "tool_progress",
        id: "mcp-2",
        name: "mcp__minion-tools__report_step",
      });
      expect((events[0] as { elapsedSeconds: number }).elapsedSeconds).toBeCloseTo(2, 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("item.completed: mcp_tool_call success", () => {
  it("emits tool_result with output=result and isError=false", () => {
    const tr = makeTranslator();
    const result = { content: [], structured_content: { ok: true } };
    const events = tr.translate({
      type: "item.completed",
      item: {
        id: "mcp-3",
        type: "mcp_tool_call",
        server: "task-manager",
        tool: "assign_task",
        arguments: {},
        status: "completed",
        result,
      },
    });
    expect(events).toEqual([
      { kind: "tool_result", callId: "mcp-3", output: result, isError: false },
    ]);
  });

  it("falls back to null output when result is absent", () => {
    const tr = makeTranslator();
    const events = tr.translate({
      type: "item.completed",
      item: {
        id: "mcp-4",
        type: "mcp_tool_call",
        server: "task-manager",
        tool: "complete_task",
        arguments: {},
        status: "completed",
      },
    });
    expect(events).toEqual([
      { kind: "tool_result", callId: "mcp-4", output: null, isError: false },
    ]);
  });
});

describe("item.completed: mcp_tool_call failed", () => {
  it("emits tool_result with output=error.message and isError=true", () => {
    const tr = makeTranslator();
    const events = tr.translate({
      type: "item.completed",
      item: {
        id: "mcp-5",
        type: "mcp_tool_call",
        server: "task-manager",
        tool: "assign_task",
        arguments: {},
        status: "failed",
        error: { message: "Connection refused" },
      },
    });
    expect(events).toEqual([
      {
        kind: "tool_result",
        callId: "mcp-5",
        output: "Connection refused",
        isError: true,
      },
    ]);
  });

  it("falls back to 'Unknown error' when error.message is absent", () => {
    const tr = makeTranslator();
    const events = tr.translate({
      type: "item.completed",
      item: {
        id: "mcp-6",
        type: "mcp_tool_call",
        server: "s",
        tool: "t",
        arguments: {},
        status: "failed",
      },
    });
    expect((events[0] as { output: string }).output).toBe("Unknown error");
  });
});

describe("command_execution: full started → updated → completed lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("started → tool_call with codex_command name and { command } input", () => {
    const tr = makeTranslator();
    const events = tr.translate({
      type: "item.started",
      item: {
        id: "cmd-1",
        type: "command_execution",
        command: "cargo test",
        aggregated_output: "",
        status: "in_progress",
      },
    });
    expect(events).toEqual([
      {
        kind: "tool_call",
        id: "cmd-1",
        name: "codex_command",
        input: { command: "cargo test" },
      },
    ]);
  });

  it("updated → tool_progress with codex_command name and non-zero elapsedSeconds", () => {
    vi.useFakeTimers();
    const tr = makeTranslator();
    tr.translate({
      type: "item.started",
      item: {
        id: "cmd-2",
        type: "command_execution",
        command: "npm install",
        aggregated_output: "",
        status: "in_progress",
      },
    });
    vi.advanceTimersByTime(3000);
    const events = tr.translate({
      type: "item.updated",
      item: {
        id: "cmd-2",
        type: "command_execution",
        command: "npm install",
        aggregated_output: "added 100 packages",
        status: "in_progress",
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "tool_progress", id: "cmd-2", name: "codex_command" });
    expect((events[0] as { elapsedSeconds: number }).elapsedSeconds).toBeCloseTo(3, 1);
  });

  it("completed (success) → tool_result with command/aggregated_output/exit_code and isError=false", () => {
    const tr = makeTranslator();
    const events = tr.translate({
      type: "item.completed",
      item: {
        id: "cmd-3",
        type: "command_execution",
        command: "echo hello",
        aggregated_output: "hello",
        exit_code: 0,
        status: "completed",
      },
    });
    expect(events).toEqual([
      {
        kind: "tool_result",
        callId: "cmd-3",
        output: { command: "echo hello", aggregated_output: "hello", exit_code: 0 },
        isError: false,
      },
    ]);
  });

  it("completed (failed) → tool_result with isError=true", () => {
    const tr = makeTranslator();
    const events = tr.translate({
      type: "item.completed",
      item: {
        id: "cmd-4",
        type: "command_execution",
        command: "false",
        aggregated_output: "",
        exit_code: 1,
        status: "failed",
      },
    });
    expect(events).toEqual([
      {
        kind: "tool_result",
        callId: "cmd-4",
        output: { command: "false", aggregated_output: "", exit_code: 1 },
        isError: true,
      },
    ]);
  });
});

describe("item.completed: file_change", () => {
  it("emits synthetic tool_call then tool_result when no item.started was seen", () => {
    const tr = makeTranslator();
    const changes = [{ path: "/src/foo.ts", kind: "update" as const }];
    const events = tr.translate({
      type: "item.completed",
      item: { id: "fc-1", type: "file_change", changes, status: "completed" },
    });
    expect(events).toEqual([
      { kind: "tool_call", id: "fc-1", name: "codex_file_change", input: {} },
      {
        kind: "tool_result",
        callId: "fc-1",
        output: { changes, status: "completed" },
        isError: false,
      },
    ]);
  });

  it("emits only tool_result (no synthetic tool_call) when item.started was seen", () => {
    const tr = makeTranslator();
    const changes = [{ path: "/src/bar.ts", kind: "add" as const }];
    tr.translate({
      type: "item.started",
      item: { id: "fc-2", type: "file_change", changes: [], status: "completed" },
    });
    const events = tr.translate({
      type: "item.completed",
      item: { id: "fc-2", type: "file_change", changes, status: "completed" },
    });
    expect(events).toEqual([
      {
        kind: "tool_result",
        callId: "fc-2",
        output: { changes, status: "completed" },
        isError: false,
      },
    ]);
  });

  it("sets isError=true when status is failed", () => {
    const tr = makeTranslator();
    const events = tr.translate({
      type: "item.completed",
      item: { id: "fc-3", type: "file_change", changes: [], status: "failed" },
    });
    const result = events.find((e) => e.kind === "tool_result") as
      | { isError: boolean }
      | undefined;
    expect(result?.isError).toBe(true);
  });
});

describe("item.completed: web_search", () => {
  it("emits tool_result with { query } and isError=false", () => {
    const tr = makeTranslator();
    const events = tr.translate({
      type: "item.completed",
      item: { id: "ws-1", type: "web_search", query: "TypeScript strict mode" },
    });
    expect(events).toEqual([
      {
        kind: "tool_result",
        callId: "ws-1",
        output: { query: "TypeScript strict mode" },
        isError: false,
      },
    ]);
  });
});

describe("item.completed: agent_message", () => {
  it("emits text event with role=assistant", () => {
    const tr = makeTranslator();
    const events = tr.translate({
      type: "item.completed",
      item: { id: "am-1", type: "agent_message", text: "All done." },
    });
    expect(events).toEqual([{ kind: "text", role: "assistant", text: "All done." }]);
  });
});

describe("item.completed: reasoning", () => {
  it("emits thinking event", () => {
    const tr = makeTranslator();
    const events = tr.translate({
      type: "item.completed",
      item: { id: "r-1", type: "reasoning", text: "Let me think step by step." },
    });
    expect(events).toEqual([{ kind: "thinking", text: "Let me think step by step." }]);
  });
});

describe("item.completed: todo_list", () => {
  it("is swallowed (MVP)", () => {
    const tr = makeTranslator();
    const events = tr.translate({
      type: "item.completed",
      item: {
        id: "tl-1",
        type: "todo_list",
        items: [{ text: "Step 1", completed: false }],
      },
    });
    expect(events).toEqual([]);
  });
});

describe("item.completed: error (non-fatal)", () => {
  it("emits permission_denial with tool=codex and reason=message", () => {
    const tr = makeTranslator();
    const events = tr.translate({
      type: "item.completed",
      item: { id: "e-1", type: "error", message: "Approval required" },
    });
    expect(events).toEqual([
      { kind: "permission_denial", tool: "codex", reason: "Approval required" },
    ]);
  });
});

describe("turn.completed", () => {
  it("emits usage event with input, output, and cacheRead from cached_input_tokens", () => {
    const tr = makeTranslator();
    tr.translate({ type: "thread.started", thread_id: "thread-usage" });
    const events = tr.translate({
      type: "turn.completed",
      turn_id: "turn-usage",
      usage: {
        input_tokens: 200,
        output_tokens: 80,
        cached_input_tokens: 50,
        reasoning_output_tokens: 0,
      },
    } as never);
    expect(events).toEqual([
      {
        kind: "usage",
        source: "turn_completed",
        input: 200,
        output: 80,
        cacheRead: 50,
        turnId: "turn-usage",
        sdkSessionId: "thread-usage",
      },
    ]);
  });

  it("does NOT emit a done event (outer generator is responsible)", () => {
    const tr = makeTranslator();
    const events = tr.translate({
      type: "turn.completed",
      usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, reasoning_output_tokens: 0 },
    });
    expect(events.some((e) => e.kind === "done")).toBe(false);
  });
});

describe("turn.failed", () => {
  it("emits done with reason=error and the error message", () => {
    const tr = makeTranslator();
    const events = tr.translate({
      type: "turn.failed",
      error: { message: "Model overloaded" },
    });
    expect(events).toEqual([{ kind: "done", reason: "error", error: "Model overloaded" }]);
  });
});

describe("error (top-level ThreadErrorEvent)", () => {
  it("emits done with reason=error and the message", () => {
    const tr = makeTranslator();
    const events = tr.translate({ type: "error", message: "Stream terminated unexpectedly" });
    expect(events).toEqual([
      { kind: "done", reason: "error", error: "Stream terminated unexpectedly" },
    ]);
  });
});

describe("elapsedSeconds: computed from item.started timestamp", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("increases between two item.updated events spaced 1.5s apart", () => {
    vi.useFakeTimers();
    const tr = makeTranslator();

    const cmdItem = {
      id: "cmd-elapsed",
      type: "command_execution" as const,
      command: "long-task",
      aggregated_output: "",
      status: "in_progress" as const,
    };

    tr.translate({ type: "item.started", item: cmdItem });
    vi.advanceTimersByTime(1500);
    const [prog1] = tr.translate({ type: "item.updated", item: cmdItem });

    vi.advanceTimersByTime(1500);
    const [prog2] = tr.translate({ type: "item.updated", item: cmdItem });

    const elapsed1 = (prog1 as { kind: string; elapsedSeconds: number }).elapsedSeconds;
    const elapsed2 = (prog2 as { kind: string; elapsedSeconds: number }).elapsedSeconds;

    expect(elapsed1).toBeCloseTo(1.5, 1);
    expect(elapsed2).toBeCloseTo(3.0, 1);
    expect(elapsed2).toBeGreaterThan(elapsed1);
  });

  it("returns 0 for elapsedSeconds when no item.started was seen", () => {
    vi.useFakeTimers();
    const tr = makeTranslator();
    vi.advanceTimersByTime(5000);

    const events = tr.translate({
      type: "item.updated",
      item: {
        id: "orphan",
        type: "command_execution",
        command: "echo",
        aggregated_output: "",
        status: "in_progress",
      },
    });

    expect(events).toHaveLength(1);
    expect((events[0] as { elapsedSeconds: number }).elapsedSeconds).toBe(0);
  });
});

describe("TranslatorContext.sessionId (compatibility)", () => {
  it("accepts a sessionId getter without error", () => {
    let threadId = "initial";
    const tr = createCodexTranslator({
      model: "codex-mini-latest",
      sessionId: () => threadId,
    });
    const events = tr.translate({ type: "thread.started", thread_id: "th-compat" });
    threadId = "updated"; // mutating the closed-over variable is fine
    expect(events).toEqual([
      { kind: "init", sessionId: "th-compat", model: "codex-mini-latest" },
    ]);
  });
});
