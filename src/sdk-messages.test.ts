/**
 * Unit tests for NormalizedEvent → display message conversion.
 *
 * Phase 3: tests cover normalizedToDisplayMessages (replaces
 * sdkToDisplayMessages) and msgId from sdk-messages.ts.
 */

import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "../shared/normalized-event.ts";
import { normalizedToDisplayMessages } from "./sdk-messages.ts";

// ── normalizedToDisplayMessages ───────────────────────────────────────────────

describe("normalizedToDisplayMessages", () => {
  // ── init ──────────────────────────────────────────────────────────────────

  describe("init", () => {
    it("produces 1 system message containing the model name", () => {
      const event: NormalizedEvent = {
        kind: "init",
        sessionId: "s1",
        model: "claude-sonnet-4-7",
      };
      const msgs = normalizedToDisplayMessages(event);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.role).toBe("system");
      expect(msgs[0]?.content).toContain("claude-sonnet-4-7");
    });
  });

  // ── text ──────────────────────────────────────────────────────────────────

  describe("text", () => {
    it("produces 1 assistant message for an assistant text event", () => {
      const event: NormalizedEvent = { kind: "text", text: "Hello!", role: "assistant" };
      const msgs = normalizedToDisplayMessages(event);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.role).toBe("assistant");
      expect(msgs[0]?.content).toBe("Hello!");
    });

    it("strips task-name markers from assistant text", () => {
      const event: NormalizedEvent = {
        kind: "text",
        text: "<!--task-name:foo--> result",
        role: "assistant",
      };
      const msgs = normalizedToDisplayMessages(event);
      expect(msgs[0]?.content).toBe("result");
    });

    it("drops a text block that is blank after stripping task-name markers", () => {
      const event: NormalizedEvent = {
        kind: "text",
        text: "<!--task-name:foo-->",
        role: "assistant",
      };
      expect(normalizedToDisplayMessages(event)).toHaveLength(0);
    });

    it("returns empty array for user-role text events", () => {
      const event: NormalizedEvent = { kind: "text", text: "hi", role: "user" };
      expect(normalizedToDisplayMessages(event)).toHaveLength(0);
    });
  });

  // ── thinking ──────────────────────────────────────────────────────────────

  describe("thinking", () => {
    it("produces 1 thinking message", () => {
      const event: NormalizedEvent = { kind: "thinking", text: "deep thought" };
      const msgs = normalizedToDisplayMessages(event);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.role).toBe("thinking");
      expect(msgs[0]?.content).toBe("deep thought");
    });
  });

  // ── tool_call ─────────────────────────────────────────────────────────────

  describe("tool_call", () => {
    it("produces 1 tool message for a top-level tool call", () => {
      const event: NormalizedEvent = {
        kind: "tool_call",
        id: "t1",
        name: "Bash",
        input: { command: "ls" },
      };
      const msgs = normalizedToDisplayMessages(event);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.role).toBe("tool");
      expect(msgs[0]?.toolName).toBe("Bash");
      expect(msgs[0]?.toolInput).toEqual({ command: "ls" });
    });

    it("drops tool_call events with a parentId (sub-agent calls)", () => {
      const event: NormalizedEvent = {
        kind: "tool_call",
        id: "t1",
        name: "Read",
        input: {},
        parentId: "parent-tool",
      };
      expect(normalizedToDisplayMessages(event)).toHaveLength(0);
    });
  });

  // ── tool_progress ─────────────────────────────────────────────────────────

  describe("tool_progress", () => {
    it("produces 1 tool message with elapsed time", () => {
      const event: NormalizedEvent = {
        kind: "tool_progress",
        id: "t1",
        name: "Bash",
        elapsedSeconds: 3.5,
      };
      const msgs = normalizedToDisplayMessages(event);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.role).toBe("tool");
      expect(msgs[0]?.content).toContain("3.5s");
      expect(msgs[0]?.toolName).toBe("Bash");
    });

    it("drops tool_progress events with a parentId", () => {
      const event: NormalizedEvent = {
        kind: "tool_progress",
        id: "t1",
        name: "Read",
        elapsedSeconds: 1.0,
        parentId: "parent-tool",
      };
      expect(normalizedToDisplayMessages(event)).toHaveLength(0);
    });
  });

  // ── done ──────────────────────────────────────────────────────────────────

  describe("done", () => {
    it("produces 1 result message for a completed turn with result text", () => {
      const event: NormalizedEvent = {
        kind: "done",
        reason: "completed",
        result: "Task done",
      };
      const msgs = normalizedToDisplayMessages(event);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.role).toBe("result");
      expect(msgs[0]?.content).toBe("Task done");
    });

    it("produces 1 result message for a stop reason", () => {
      const event: NormalizedEvent = { kind: "done", reason: "stop", result: "Stopped" };
      const msgs = normalizedToDisplayMessages(event);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.role).toBe("result");
    });

    it("produces 1 error result for done/error", () => {
      const event: NormalizedEvent = {
        kind: "done",
        reason: "error",
        error: "network timeout",
      };
      const msgs = normalizedToDisplayMessages(event);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.role).toBe("result");
      expect(msgs[0]?.content).toBe("network timeout");
    });

    it("falls back to 'Error' when done/error has no error string", () => {
      const event: NormalizedEvent = { kind: "done", reason: "error" };
      const msgs = normalizedToDisplayMessages(event);
      expect(msgs[0]?.content).toBe("Error");
    });

    it("returns empty array for done/completed with no result", () => {
      const event: NormalizedEvent = { kind: "done", reason: "completed" };
      expect(normalizedToDisplayMessages(event)).toHaveLength(0);
    });

    it("strips task-name markers from result content", () => {
      const event: NormalizedEvent = {
        kind: "done",
        reason: "completed",
        result: "<!--task-name:foo--> done",
      };
      const msgs = normalizedToDisplayMessages(event);
      expect(msgs[0]?.content).toBe("done");
    });
  });

  // ── api_retry ─────────────────────────────────────────────────────────────

  describe("api_retry", () => {
    it("produces 1 system message with attempt info", () => {
      const event: NormalizedEvent = { kind: "api_retry", attempt: 2, reason: "429" };
      const msgs = normalizedToDisplayMessages(event);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.role).toBe("system");
      expect(msgs[0]?.content).toContain("2");
    });
  });

  // ── rate_limit ────────────────────────────────────────────────────────────

  describe("rate_limit", () => {
    it("produces 1 system message", () => {
      const event: NormalizedEvent = { kind: "rate_limit", retryAfterMs: 5000 };
      const msgs = normalizedToDisplayMessages(event);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.role).toBe("system");
    });
  });

  // ── permission_denial ─────────────────────────────────────────────────────

  describe("permission_denial", () => {
    it("produces 1 system message with the tool name", () => {
      const event: NormalizedEvent = {
        kind: "permission_denial",
        tool: "Bash",
        reason: "not allowed",
      };
      const msgs = normalizedToDisplayMessages(event);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.role).toBe("system");
      expect(msgs[0]?.content).toContain("Bash");
    });
  });

  // ── no-display events ─────────────────────────────────────────────────────

  describe("no-display events", () => {
    it.each([
      ["usage", { kind: "usage", input: 100, output: 50 } as NormalizedEvent],
      ["text_delta", { kind: "text_delta", text: "hi", blockIndex: 0 } as NormalizedEvent],
      ["stream_end", { kind: "stream_end" } as NormalizedEvent],
      [
        "tool_result",
        { kind: "tool_result", callId: "c1", output: "ok", isError: false } as NormalizedEvent,
      ],
    ])("returns empty array for %s events", (_label, event) => {
      expect(normalizedToDisplayMessages(event)).toHaveLength(0);
    });
  });

  // ── prefix propagation ────────────────────────────────────────────────────

  describe("prefix propagation", () => {
    it("message ids begin with the provided prefix", () => {
      const event: NormalizedEvent = {
        kind: "init",
        sessionId: "s1",
        model: "claude-opus-4-5",
      };
      const msgs = normalizedToDisplayMessages(event, "leader");
      expect(msgs[0]?.id).toMatch(/^leader-/);
    });
  });

  // ── stable ID dedup ───────────────────────────────────────────────────────

  describe("stable ID dedup", () => {
    it("produces the same message ID when the same text event is processed twice", () => {
      const event: NormalizedEvent = { kind: "text", text: "Hello world", role: "assistant" };
      const msgs1 = normalizedToDisplayMessages(event, "t");
      const msgs2 = normalizedToDisplayMessages(event, "t");
      expect(msgs1[0]?.id).toBe(msgs2[0]?.id);
    });

    it("produces the same ID for the same thinking content", () => {
      const event: NormalizedEvent = { kind: "thinking", text: "Consider options" };
      const m1 = normalizedToDisplayMessages(event, "t");
      const m2 = normalizedToDisplayMessages(event, "t");
      expect(m1[0]?.id).toBe(m2[0]?.id);
    });
  });
});
