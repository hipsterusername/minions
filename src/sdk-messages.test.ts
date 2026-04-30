/**
 * Unit tests for SDK → display message conversion.
 *
 * Covers sdkToDisplayMessages, sdkToDisplayMessage, extractText, and msgId
 * from sdk-messages.ts. Message shapes are constructed as plain literals and
 * cast to SdkMessage — the union is wide enough to accept them.
 */

import { describe, it, expect } from "vitest";
import type { SdkMessage, ContentBlock } from "./use-socket.ts";
import {
  sdkToDisplayMessages,
  sdkToDisplayMessage,
  extractText,
} from "./sdk-messages.ts";

// ── Fixture helpers ───────────────────────────────────────────────────────────

function initMsg(uuid = "u-init", model = "claude-opus-4-5"): SdkMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: "s1",
    claude_code_version: "1.0",
    cwd: "/",
    tools: [],
    model,
    permissionMode: "auto",
    apiKeySource: "env",
    mcp_servers: [],
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid,
  } as SdkMessage;
}

function taskStartedMsg(description = "Analyze codebase", uuid = "u-ts"): SdkMessage {
  return {
    type: "system",
    subtype: "task_started",
    task_id: "task-1",
    description,
    uuid,
    session_id: "s1",
  } as SdkMessage;
}

// Note: a `taskNotificationMsg` helper was used by the now-removed
// emoji-glyph triad (§5.7). If a future test needs to construct a
// task_notification SDK message, restore this factory inline.

function localCmdMsg(content: string, uuid = "u-cmd"): SdkMessage {
  return {
    type: "system",
    subtype: "local_command_output",
    content,
    uuid,
    session_id: "s1",
  } as SdkMessage;
}

/** Produces a system/status message — subtype handled by the "return []" fallthrough. */
function statusMsg(): SdkMessage {
  return {
    type: "system",
    subtype: "status",
    status: "compacting",
    uuid: "u-status",
    session_id: "s1",
  } as SdkMessage;
}

function assistantMsg(content: ContentBlock[], uuid = "u-asst"): SdkMessage {
  return {
    type: "assistant",
    message: {
      id: "msg-1",
      type: "message",
      role: "assistant",
      content,
      model: "claude-3",
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    parent_tool_use_id: null,
    uuid,
    session_id: "s1",
  } as SdkMessage;
}

function assistantNoContentMsg(): SdkMessage {
  return {
    type: "assistant",
    message: {
      id: "msg-1",
      type: "message",
      role: "assistant",
      // content deliberately absent
      model: "claude-3",
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    parent_tool_use_id: null,
    uuid: "u-nocon",
    session_id: "s1",
  } as SdkMessage;
}

function toolProgressMsg(uuid = "u-tp"): SdkMessage {
  return {
    type: "tool_progress",
    tool_use_id: "tool-1",
    tool_name: "Bash",
    parent_tool_use_id: null,
    elapsed_time_seconds: 3.5,
    uuid,
    session_id: "s1",
  } as SdkMessage;
}

function toolSummaryMsg(summary?: string, uuid = "u-sum"): SdkMessage {
  return {
    type: "tool_use_summary",
    summary,
    preceding_tool_use_ids: [],
    uuid,
    session_id: "s1",
  } as SdkMessage;
}

function resultMsg(
  overrides: Record<string, unknown> = {},
  uuid = "u-res",
): SdkMessage {
  return {
    type: "result",
    subtype: "success",
    result: "Task completed",
    is_error: false,
    duration_ms: 5000,
    duration_api_ms: 4000,
    num_turns: 3,
    stop_reason: "end_turn",
    total_cost_usd: 0.0288,
    usage: { input_tokens: 100, output_tokens: 50 },
    modelUsage: {},
    permission_denials: [],
    uuid,
    ...overrides,
  } as unknown as SdkMessage;
}

// Removed: msgId regex tests — they pin the prefix-with-dash format,
// which is implementation detail. The prefix-propagation describe block
// below covers the observable behaviour. See docs/testing-strategy.md §5.

// ── extractText ───────────────────────────────────────────────────────────────

describe("extractText", () => {
  it("returns the text from a single text block", () => {
    const blocks: ContentBlock[] = [{ type: "text", text: "hello" }];
    expect(extractText(blocks)).toBe("hello");
  });

  it("ignores thinking and tool_use blocks", () => {
    const blocks: ContentBlock[] = [
      { type: "thinking", thinking: "inner monologue" },
      { type: "text", text: "actual output" },
      { type: "tool_use", id: "t1", name: "Bash", input: {} },
    ];
    expect(extractText(blocks)).toBe("actual output");
  });

  it("joins multiple text blocks with a newline", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "line one" },
      { type: "text", text: "line two" },
    ];
    expect(extractText(blocks)).toBe("line one\nline two");
  });

  it("strips task-name comment markers", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "<!--task-name:my-task--> result" },
    ];
    expect(extractText(blocks)).toBe("result");
  });

  it("returns an empty string for an empty array", () => {
    expect(extractText([])).toBe("");
  });
});

// ── sdkToDisplayMessages ──────────────────────────────────────────────────────

describe("sdkToDisplayMessages", () => {
  // ── system / init ───────────────────────────────────────────────────────────

  describe("system / init", () => {
    // Removed: "produces 1 system message" length+role triad — pinning
    // count and role of the produced message restates the role/content
    // checks that follow. See docs/testing-strategy.md §5.

    it("includes the model name in the content", () => {
      const msgs = sdkToDisplayMessages(initMsg("u1", "claude-sonnet-4-7"));
      expect(msgs[0]?.content).toContain("claude-sonnet-4-7");
    });

    it("carries the input uuid as sdkUuid", () => {
      const msgs = sdkToDisplayMessages(initMsg("my-uuid"));
      expect(msgs[0]?.sdkUuid).toBe("my-uuid");
    });
  });

  // ── system / task_started ───────────────────────────────────────────────────

  describe("system / task_started", () => {
    it("produces 1 system message with the subagent description", () => {
      const msgs = sdkToDisplayMessages(taskStartedMsg("Analyze codebase"));
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.content).toContain("Analyze codebase");
    });
  });

  // ── system / task_notification ──────────────────────────────────────────────

  // Removed: task_notification emoji-glyph tests (✓ / ✗) — pin literal
  // copy choices, not behaviour. See docs/testing-strategy.md §5.

  // ── system / local_command_output ───────────────────────────────────────────

  describe("system / local_command_output", () => {
    it("produces 1 system message with the command output", () => {
      const msgs = sdkToDisplayMessages(localCmdMsg("/cost output text"));
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.content).toBe("/cost output text");
    });
  });

  // Removed: status-subtype default-fallthrough test — pins the silent
  // drop of an unknown subtype, which is implementation detail of the
  // switch statement. See docs/testing-strategy.md §5.

  // ── assistant ───────────────────────────────────────────────────────────────

  describe("assistant", () => {
    it("returns empty array when message has no content", () => {
      expect(sdkToDisplayMessages(assistantNoContentMsg())).toHaveLength(0);
    });

    it("produces 1 assistant message for a single text block", () => {
      const msgs = sdkToDisplayMessages(
        assistantMsg([{ type: "text", text: "Hello!" }]),
      );
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.role).toBe("assistant");
      expect(msgs[0]?.content).toBe("Hello!");
    });

    it("strips task-name markers from text block content", () => {
      const msgs = sdkToDisplayMessages(
        assistantMsg([{ type: "text", text: "<!--task-name:foo--> result" }]),
      );
      expect(msgs[0]?.content).toBe("result");
    });

    it("drops a text block that is blank after stripping task-name markers", () => {
      const msgs = sdkToDisplayMessages(
        assistantMsg([{ type: "text", text: "<!--task-name:foo-->" }]),
      );
      expect(msgs).toHaveLength(0);
    });

    it("produces a thinking message for a thinking block", () => {
      const msgs = sdkToDisplayMessages(
        assistantMsg([{ type: "thinking", thinking: "deep thought" }]),
      );
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.role).toBe("thinking");
      expect(msgs[0]?.content).toBe("deep thought");
    });

    it("produces a tool message for a tool_use block", () => {
      const msgs = sdkToDisplayMessages(
        assistantMsg([
          { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
        ]),
      );
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.role).toBe("tool");
      expect(msgs[0]?.toolName).toBe("Bash");
      expect(msgs[0]?.toolInput).toEqual({ cmd: "ls" });
    });

    it("splits mixed blocks into separate messages preserving order", () => {
      const msgs = sdkToDisplayMessages(
        assistantMsg([
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "answer" },
          { type: "tool_use", id: "t1", name: "Read", input: {} },
        ]),
      );
      expect(msgs).toHaveLength(3);
      expect(msgs[0]?.role).toBe("thinking");
      expect(msgs[1]?.role).toBe("assistant");
      expect(msgs[2]?.role).toBe("tool");
    });

    it("sets sdkUuid on all returned messages", () => {
      const msgs = sdkToDisplayMessages(
        assistantMsg(
          [
            { type: "thinking", thinking: "think" },
            { type: "text", text: "text" },
          ],
          "asst-uuid",
        ),
      );
      for (const m of msgs) {
        expect(m.sdkUuid).toBe("asst-uuid");
      }
    });
  });

  // ── tool_progress ───────────────────────────────────────────────────────────

  describe("tool_progress", () => {
    it("produces 1 tool message", () => {
      const msgs = sdkToDisplayMessages(toolProgressMsg());
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.role).toBe("tool");
    });

    it("includes elapsed time in content and populates toolName", () => {
      const msgs = sdkToDisplayMessages(toolProgressMsg());
      expect(msgs[0]?.content).toContain("3.5s");
      expect(msgs[0]?.toolName).toBe("Bash");
    });
  });

  // ── tool_use_summary ────────────────────────────────────────────────────────

  describe("tool_use_summary", () => {
    it("produces 1 system message when summary is present", () => {
      const msgs = sdkToDisplayMessages(toolSummaryMsg("Used 3 tools"));
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.content).toBe("Used 3 tools");
    });

    it("returns empty array when summary is absent", () => {
      expect(sdkToDisplayMessages(toolSummaryMsg())).toHaveLength(0);
    });
  });

  // ── result ──────────────────────────────────────────────────────────────────

  describe("result", () => {
    it("produces 1 result message", () => {
      const msgs = sdkToDisplayMessages(resultMsg());
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.role).toBe("result");
    });

    it("suffix contains both duration and cost when both are present", () => {
      const msgs = sdkToDisplayMessages(
        resultMsg({ duration_ms: 8600, total_cost_usd: 0.0288 }),
      );
      expect(msgs[0]?.suffix).toBe("8.6s · $0.0288");
    });

    it("suffix contains only duration when cost is zero", () => {
      const msgs = sdkToDisplayMessages(
        resultMsg({ duration_ms: 5000, total_cost_usd: 0 }),
      );
      expect(msgs[0]?.suffix).toBe("5.0s");
    });

    it("suffix contains only cost when duration is zero", () => {
      const msgs = sdkToDisplayMessages(
        resultMsg({ duration_ms: 0, total_cost_usd: 0.01 }),
      );
      expect(msgs[0]?.suffix).toBe("$0.0100");
    });

    it("suffix is undefined when both duration and cost are absent", () => {
      const msgs = sdkToDisplayMessages(
        resultMsg({ duration_ms: 0, total_cost_usd: 0 }),
      );
      expect(msgs[0]?.suffix).toBeUndefined();
    });

    it("falls back to 'Error' when is_error is true and the errors array is empty", () => {
      const msg: SdkMessage = {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: [],
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 5, output_tokens: 2 },
        modelUsage: {},
        permission_denials: [],
        uuid: "u-err",
        session_id: "s1",
      } as SdkMessage;
      const msgs = sdkToDisplayMessages(msg);
      expect(msgs[0]?.content).toBe("Error");
    });

    it("surfaces the first error message when is_error is true and errors is populated", () => {
      const msg: SdkMessage = {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["network timeout", "second error"],
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 5, output_tokens: 2 },
        modelUsage: {},
        permission_denials: [],
        uuid: "u-err",
        session_id: "s1",
      } as SdkMessage;
      const msgs = sdkToDisplayMessages(msg);
      expect(msgs[0]?.content).toBe("network timeout");
    });

    it("strips task-name markers from result content", () => {
      const msgs = sdkToDisplayMessages(
        resultMsg({ result: "<!--task-name:foo--> done" }),
      );
      expect(msgs[0]?.content).toBe("done");
    });
  });

  // ── default / unknown type ──────────────────────────────────────────────────

  describe("default / unknown type", () => {
    it("returns empty array for user messages", () => {
      const msg = {
        type: "user",
        message: { role: "user", content: "hello" },
        parent_tool_use_id: null,
      } as SdkMessage;
      expect(sdkToDisplayMessages(msg)).toHaveLength(0);
    });
  });

  // ── prefix propagation ──────────────────────────────────────────────────────

  describe("prefix propagation", () => {
    it("message ids begin with the provided prefix", () => {
      const msgs = sdkToDisplayMessages(initMsg(), "leader");
      expect(msgs[0]?.id).toMatch(/^leader-/);
    });
  });
});

// ── sdkToDisplayMessage ───────────────────────────────────────────────────────

describe("sdkToDisplayMessage", () => {
  it("returns null when no display messages are produced", () => {
    expect(sdkToDisplayMessage(statusMsg())).toBeNull();
  });

  it("returns the first message when messages are produced", () => {
    const msg = sdkToDisplayMessage(initMsg());
    expect(msg).not.toBeNull();
    expect(msg?.role).toBe("system");
  });
});
