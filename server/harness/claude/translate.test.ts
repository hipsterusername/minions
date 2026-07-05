/**
 * Unit tests for sdkToNormalized (server/harness/claude/translate.ts).
 *
 * Each test exercises one variant of SDKMessage that Minions handles in
 * production. The goal is to pin the mapping so a future refactor can
 * confirm the translation is unchanged.
 *
 * We construct minimal message objects that satisfy the discriminant fields
 * the translator inspects. Real SDK messages carry many more fields; the
 * translator ignores fields it does not need.
 *
 * Phase 1: new tests, no existing behaviour changed.
 */

import { describe, it, expect } from "vitest";
import { sdkToNormalized, translateSdkMessage } from "./translate.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Cast a plain object to `any` so we can feed it to sdkToNormalized without
 *  satisfying every SDK type field. */
function msg(o: Record<string, unknown>) {
  return o as never;
}

// ── system/init ───────────────────────────────────────────────────────────────

describe("sdkToNormalized: system/init", () => {
  it("emits a single init event with sessionId, model, and permissionMode", () => {
    const events = sdkToNormalized(
      msg({
        type: "system",
        subtype: "init",
        session_id: "sess-abc",
        model: "claude-opus-4-7",
        permissionMode: "auto",
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "init",
      sessionId: "sess-abc",
      model: "claude-opus-4-7",
      permissionMode: "auto",
    });
  });

  it("omits permissionMode when absent in source", () => {
    const events = sdkToNormalized(
      msg({ type: "system", subtype: "init", session_id: "s", model: "m" }),
    );
    expect(events[0]).not.toHaveProperty("permissionMode", expect.anything());
  });
});

// ── system/api_retry ──────────────────────────────────────────────────────────

describe("sdkToNormalized: system/api_retry", () => {
  it("emits an api_retry event with attempt and reason", () => {
    const events = sdkToNormalized(
      msg({
        type: "system",
        subtype: "api_retry",
        attempt: 2,
        error: "rate_limit",
        session_id: "s",
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "api_retry",
      attempt: 2,
      reason: "rate_limit",
    });
  });

  it("defaults attempt to 1 when absent", () => {
    const events = sdkToNormalized(
      msg({ type: "system", subtype: "api_retry", session_id: "s" }),
    );
    expect((events[0] as { attempt: number }).attempt).toBe(1);
  });
});

// ── Other system subtypes ─────────────────────────────────────────────────────

describe("sdkToNormalized: unrecognised system subtypes", () => {
  it("returns an empty array for status subtype", () => {
    expect(
      sdkToNormalized(msg({ type: "system", subtype: "status", session_id: "s" })),
    ).toEqual([]);
  });

  it("returns an empty array for task_started subtype", () => {
    expect(
      sdkToNormalized(msg({ type: "system", subtype: "task_started", session_id: "s" })),
    ).toEqual([]);
  });

  it("returns an empty array for compact_boundary subtype", () => {
    expect(
      sdkToNormalized(msg({ type: "system", subtype: "compact_boundary", session_id: "s" })),
    ).toEqual([]);
  });
});

// ── assistant ─────────────────────────────────────────────────────────────────

describe("sdkToNormalized: assistant", () => {
  it("produces text event for a text block", () => {
    const events = sdkToNormalized(
      msg({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "Hello!" }] },
      }),
    );
    const text = events.find((e) => e.kind === "text");
    expect(text).toMatchObject({ kind: "text", text: "Hello!", role: "assistant" });
  });

  it("produces thinking event for a thinking block", () => {
    const events = sdkToNormalized(
      msg({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "thinking", thinking: "Let me think…" }] },
      }),
    );
    const think = events.find((e) => e.kind === "thinking");
    expect(think).toMatchObject({ kind: "thinking", text: "Let me think…" });
  });

  it("produces tool_call event for a tool_use block", () => {
    const events = sdkToNormalized(
      msg({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [{ type: "tool_use", id: "tu-1", name: "Read", input: { path: "/foo" } }],
        },
      }),
    );
    const call = events.find((e) => e.kind === "tool_call");
    expect(call).toMatchObject({
      kind: "tool_call",
      id: "tu-1",
      name: "Read",
      input: { path: "/foo" },
    });
  });

  it("carries parent_tool_use_id as parentId on tool_call events", () => {
    const events = sdkToNormalized(
      msg({
        type: "assistant",
        parent_tool_use_id: "parent-tu-99",
        message: {
          content: [{ type: "tool_use", id: "tu-2", name: "Write", input: {} }],
        },
      }),
    );
    const call = events.find((e) => e.kind === "tool_call");
    expect((call as { parentId?: string }).parentId).toBe("parent-tu-99");
  });

  it("omits parentId when parent_tool_use_id is null (top-level call)", () => {
    const events = sdkToNormalized(
      msg({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [{ type: "tool_use", id: "tu-3", name: "Bash", input: {} }],
        },
      }),
    );
    const call = events.find((e) => e.kind === "tool_call");
    expect(call).not.toHaveProperty("parentId", expect.anything());
  });

  it("produces a usage event when message.usage is present", () => {
    const events = sdkToNormalized(
      msg({
        type: "assistant",
        uuid: "sdk-uuid-1",
        session_id: "claude-session",
        parent_tool_use_id: null,
        message: {
          id: "msg-usage-1",
          content: [],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }),
    );
    const usage = events.find((e) => e.kind === "usage");
    expect(usage).toMatchObject({
      kind: "usage",
      source: "assistant",
      messageId: "msg-usage-1",
      sdkSessionId: "claude-session",
      input: 100,
      output: 50,
    });
  });

  it("includes cacheRead when cache_read_input_tokens is present", () => {
    const events = sdkToNormalized(
      msg({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 200,
          },
        },
      }),
    );
    const usage = events.find((e) => e.kind === "usage") as { cacheRead?: number } | undefined;
    expect(usage?.cacheRead).toBe(200);
  });

  it("produces events for all block types in a mixed content message", () => {
    const events = sdkToNormalized(
      msg({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [
            { type: "thinking", thinking: "step 1" },
            { type: "text", text: "Here is my plan." },
            { type: "tool_use", id: "tu-x", name: "Bash", input: { cmd: "ls" } },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    );
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("thinking");
    expect(kinds).toContain("text");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("usage");
  });

  it("returns an empty array when content is empty and no usage", () => {
    const events = sdkToNormalized(
      msg({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [] },
      }),
    );
    expect(events).toEqual([]);
  });

  it("ignores blocks with unknown type", () => {
    const events = sdkToNormalized(
      msg({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [{ type: "server_tool_use", id: "x", name: "Search", input: {} }],
        },
      }),
    );
    expect(events).toEqual([]);
  });
});

// ── result/success ────────────────────────────────────────────────────────────

describe("sdkToNormalized: result success", () => {
  it("emits usage then done=completed", () => {
    const events = sdkToNormalized(
      msg({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "All done.",
        total_cost_usd: 0.0042,
        usage: { input_tokens: 500, output_tokens: 200 },
        permission_denials: [],
        session_id: "s",
      }),
    );
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["usage", "done"]);
    const done = events.find((e) => e.kind === "done") as { reason: string } | undefined;
    expect(done?.reason).toBe("completed");
  });

  it("includes costUSD on the usage event", () => {
    const events = sdkToNormalized(
      msg({
        type: "result",
        is_error: false,
        total_cost_usd: 0.0088,
        usage: { input_tokens: 10, output_tokens: 5 },
        permission_denials: [],
        session_id: "s",
      }),
    );
    const usage = events.find((e) => e.kind === "usage") as
      | { costUSD?: number; source?: string }
      | undefined;
    expect(usage?.costUSD).toBe(0.0088);
    expect(usage?.source).toBe("result");
  });

  it("emits permission_denial events before done", () => {
    const events = sdkToNormalized(
      msg({
        type: "result",
        is_error: false,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        permission_denials: [
          { tool_name: "Bash", tool_use_id: "x", tool_input: {} },
        ],
        session_id: "s",
      }),
    );
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["usage", "permission_denial", "done"]);
    const denial = events.find((e) => e.kind === "permission_denial") as
      | { tool: string; reason: string }
      | undefined;
    expect(denial?.tool).toBe("Bash");
  });
});

// ── result/error ─────────────────────────────────────────────────────────────

describe("sdkToNormalized: result error", () => {
  it("emits done=error with the first error string", () => {
    const events = sdkToNormalized(
      msg({
        type: "result",
        is_error: true,
        errors: ["Context window exceeded"],
        session_id: "s",
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "done",
      reason: "error",
      error: "Context window exceeded",
    });
  });

  it("falls back to 'Unknown error' when errors array is empty", () => {
    const events = sdkToNormalized(
      msg({ type: "result", is_error: true, errors: [], session_id: "s" }),
    );
    const done = events[0] as { error?: string } | undefined;
    expect(done?.error).toBe("Unknown error");
  });

  it("treats Claude tool-use diagnostics as non-error completion", () => {
    const events = sdkToNormalized(
      msg({
        type: "result",
        is_error: true,
        errors: [
          "Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
        ],
        session_id: "s",
      }),
    );

    expect(events).toEqual([{ kind: "done", reason: "completed" }]);
  });
});

// ── rate_limit_event ──────────────────────────────────────────────────────────

describe("sdkToNormalized: rate_limit_event", () => {
  it("emits a rate_limit event", () => {
    const events = sdkToNormalized(
      msg({ type: "rate_limit_event", rate_limit_info: {}, session_id: "s" }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "rate_limit" });
    expect(typeof (events[0] as { retryAfterMs: number }).retryAfterMs).toBe("number");
  });

  it("retryAfterMs is 0 when resetsAt is absent", () => {
    const events = sdkToNormalized(
      msg({ type: "rate_limit_event", rate_limit_info: {}, session_id: "s" }),
    );
    expect((events[0] as { retryAfterMs: number }).retryAfterMs).toBe(0);
  });

  it("carries resetAtMs when resetsAt is present", () => {
    const resetAtSeconds = Math.floor(Date.now() / 1000) + 60;
    const events = sdkToNormalized(
      msg({
        type: "rate_limit_event",
        rate_limit_info: { resetsAt: resetAtSeconds },
        session_id: "s",
      }),
    );
    expect(events[0]).toMatchObject({
      kind: "rate_limit",
      resetAtMs: resetAtSeconds * 1000,
    });
    expect((events[0] as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
  });
});

// ── stream_event and other pass-through types ─────────────────────────────────

describe("sdkToNormalized: pass-through / no-op messages", () => {
  it("returns [] for stream_event (partial message)", () => {
    expect(
      sdkToNormalized(
        msg({ type: "stream_event", event: {}, parent_tool_use_id: null, session_id: "s" }),
      ),
    ).toEqual([]);
  });

  it("returns a tool_progress NormalizedEvent for tool_progress", () => {
    // tool_progress is no longer a no-op — Phase 3 surfaces it.
    expect(
      sdkToNormalized(
        msg({ type: "tool_progress", tool_use_id: "tu-1", tool_name: "Read", elapsed_time_seconds: 1.5, session_id: "s" }),
      ),
    ).toEqual([{ kind: "tool_progress", id: "tu-1", name: "Read", elapsedSeconds: 1.5 }]);
  });

  it("returns [] for tool_use_summary", () => {
    expect(
      sdkToNormalized(msg({ type: "tool_use_summary", summary: "3 tools", session_id: "s" })),
    ).toEqual([]);
  });

  it("returns [] for auth_status", () => {
    expect(
      sdkToNormalized(
        msg({ type: "auth_status", isAuthenticating: false, output: [], session_id: "s" }),
      ),
    ).toEqual([]);
  });

  it("returns [] for prompt_suggestion", () => {
    expect(
      sdkToNormalized(
        msg({ type: "prompt_suggestion", suggestion: "Run tests?", session_id: "s" }),
      ),
    ).toEqual([]);
  });

  it("returns [] for completely unknown types", () => {
    expect(sdkToNormalized(msg({ type: "future_unknown_type" }))).toEqual([]);
  });

  it("returns [] for assistant messages with missing message.content", () => {
    // Defensive guard: malformed assistant messages should not throw.
    expect(
      sdkToNormalized(msg({ type: "assistant", text: "hello" })),
    ).toEqual([]);
  });
});

// ── done event extras ─────────────────────────────────────────────────────────

describe("sdkToNormalized: result done extras", () => {
  it("includes result text on done when result is present", () => {
    const events = sdkToNormalized(
      msg({ type: "result", is_error: false, result: "42", num_turns: 2, session_id: "s" }),
    );
    const done = events.find((e) => e.kind === "done");
    expect(done).toMatchObject({ kind: "done", reason: "completed", result: "42", turns: 2 });
  });

  it("omits result and turns from done when absent", () => {
    const events = sdkToNormalized(
      msg({ type: "result", session_id: "s" }),
    );
    const done = events.find((e) => e.kind === "done");
    expect(done).toEqual({ kind: "done", reason: "completed" });
  });
});

// ── translateSdkMessage ───────────────────────────────────────────────────────

describe("translateSdkMessage", () => {
  it("accepts unknown and delegates to sdkToNormalized", () => {
    const result = translateSdkMessage(
      msg({ type: "system", subtype: "init", session_id: "x", model: "opus" }),
    );
    expect(result).toEqual([{ kind: "init", sessionId: "x", model: "opus" }]);
  });

  it("returns [] for unknown message types", () => {
    expect(translateSdkMessage({ type: "bogus" })).toEqual([]);
  });
});
