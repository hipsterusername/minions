/**
 * Contract tests for the `NormalizedEvent` wire format.
 *
 * NormalizedEvent is the shared type between server and client (both import
 * from `shared/normalized-event.ts`). These tests verify the structural
 * contract: every known `kind` is representable, every event round-trips
 * through JSON, and the discriminant union exhausts all variants.
 *
 * Design: no mocking, no I/O — pure structural assertions over the type.
 */

import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "../../shared/normalized-event.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Round-trip through JSON.stringify / JSON.parse to exercise serialisation. */
function roundTrip(event: NormalizedEvent): NormalizedEvent {
  return JSON.parse(JSON.stringify(event)) as NormalizedEvent;
}

/** Narrow helper: assert an event round-trips losslessly. */
function assertRoundTrip(event: NormalizedEvent): void {
  expect(roundTrip(event)).toEqual(event);
}

// ── Kind coverage ─────────────────────────────────────────────────────────────

describe("NormalizedEvent: every kind round-trips through JSON", () => {
  it("init", () => {
    const e: NormalizedEvent = {
      kind: "init",
      sessionId: "sess-001",
      model: "claude-opus-4-5",
      permissionMode: "default",
    };
    assertRoundTrip(e);
    expect(e.kind).toBe("init");
  });

  it("text (assistant)", () => {
    const e: NormalizedEvent = {
      kind: "text",
      text: "Hello world",
      role: "assistant",
    };
    assertRoundTrip(e);
  });

  it("text (user)", () => {
    const e: NormalizedEvent = { kind: "text", text: "Hi", role: "user" };
    assertRoundTrip(e);
  });

  it("thinking", () => {
    const e: NormalizedEvent = { kind: "thinking", text: "Let me think..." };
    assertRoundTrip(e);
  });

  it("tool_call (top-level)", () => {
    const e: NormalizedEvent = {
      kind: "tool_call",
      id: "toolu_01",
      name: "Read",
      input: { file_path: "/repo/src/index.ts" },
    };
    assertRoundTrip(e);
  });

  it("tool_call (sub-agent, has parentId)", () => {
    const e: NormalizedEvent = {
      kind: "tool_call",
      id: "toolu_02",
      name: "Bash",
      input: { command: "ls" },
      parentId: "toolu_parent",
    };
    assertRoundTrip(e);
    expect(e.parentId).toBe("toolu_parent");
  });

  it("tool_result", () => {
    const e: NormalizedEvent = {
      kind: "tool_result",
      callId: "toolu_01",
      output: "file contents here",
      isError: false,
    };
    assertRoundTrip(e);
  });

  it("tool_result (error)", () => {
    const e: NormalizedEvent = {
      kind: "tool_result",
      callId: "toolu_01",
      output: "file not found",
      isError: true,
    };
    assertRoundTrip(e);
    expect(e.isError).toBe(true);
  });

  it("usage (minimal)", () => {
    const e: NormalizedEvent = { kind: "usage", input: 120, output: 40 };
    assertRoundTrip(e);
  });

  it("usage (with costUSD and cache fields)", () => {
    const e: NormalizedEvent = {
      kind: "usage",
      input: 120,
      output: 40,
      cacheRead: 10,
      cacheCreation: 5,
      costUSD: 0.0042,
    };
    assertRoundTrip(e);
    expect(e.costUSD).toBe(0.0042);
  });

  it("usage (no costUSD — pre-stop update)", () => {
    const e: NormalizedEvent = { kind: "usage", input: 0, output: 0 };
    assertRoundTrip(e);
    expect(e.costUSD).toBeUndefined();
  });

  it("permission_denial", () => {
    const e: NormalizedEvent = {
      kind: "permission_denial",
      tool: "Bash",
      reason: "not allowed in default mode",
    };
    assertRoundTrip(e);
  });

  it("rate_limit", () => {
    const e: NormalizedEvent = {
      kind: "rate_limit",
      retryAfterMs: 5000,
      resetAtMs: 1779860999000,
      message: "too many requests",
    };
    assertRoundTrip(e);
    expect(e.retryAfterMs).toBe(5000);
    expect(e.resetAtMs).toBe(1779860999000);
  });

  it("api_retry", () => {
    const e: NormalizedEvent = {
      kind: "api_retry",
      attempt: 2,
      reason: "overloaded_error",
    };
    assertRoundTrip(e);
  });

  it("done (completed)", () => {
    const e: NormalizedEvent = {
      kind: "done",
      reason: "completed",
      result: "Patched 1 file",
      turns: 3,
    };
    assertRoundTrip(e);
    expect(e.reason).toBe("completed");
    expect(e.turns).toBe(3);
  });

  it("done (abort)", () => {
    const e: NormalizedEvent = { kind: "done", reason: "abort" };
    assertRoundTrip(e);
  });

  it("done (error)", () => {
    const e: NormalizedEvent = {
      kind: "done",
      reason: "error",
      error: "model overloaded",
    };
    assertRoundTrip(e);
    expect(e.error).toBe("model overloaded");
  });

  it("text_delta", () => {
    const e: NormalizedEvent = {
      kind: "text_delta",
      text: "Hello",
      blockIndex: 0,
    };
    assertRoundTrip(e);
  });

  it("text_delta (sub-agent, has parentId)", () => {
    const e: NormalizedEvent = {
      kind: "text_delta",
      text: " world",
      blockIndex: 0,
      parentId: "tool-abc",
    };
    assertRoundTrip(e);
    expect(e.parentId).toBe("tool-abc");
  });

  it("stream_end", () => {
    const e: NormalizedEvent = { kind: "stream_end" };
    assertRoundTrip(e);
  });

  it("tool_progress", () => {
    const e: NormalizedEvent = {
      kind: "tool_progress",
      id: "toolu_01",
      name: "Bash",
      elapsedSeconds: 1.5,
    };
    assertRoundTrip(e);
    expect(e.elapsedSeconds).toBe(1.5);
  });

  it("tool_progress (sub-agent, has parentId)", () => {
    const e: NormalizedEvent = {
      kind: "tool_progress",
      id: "toolu_99",
      name: "Read",
      elapsedSeconds: 0.3,
      parentId: "parent-toolu",
    };
    assertRoundTrip(e);
    expect(e.parentId).toBe("parent-toolu");
  });
});

// ── Discriminant exhaustiveness ───────────────────────────────────────────────

describe("NormalizedEvent: discriminant exhaustiveness", () => {
  /** All known kinds — update when adding a new variant. */
  const ALL_KINDS: NormalizedEvent["kind"][] = [
    "init",
    "text",
    "thinking",
    "tool_call",
    "tool_result",
    "usage",
    "permission_denial",
    "rate_limit",
    "api_retry",
    "done",
    "text_delta",
    "stream_end",
    "tool_progress",
  ];

  it("covers all 13 known kinds", () => {
    expect(ALL_KINDS).toHaveLength(13);
  });

  it("each kind in ALL_KINDS is a valid NormalizedEvent discriminant", () => {
    // Build one representative event per kind and confirm it has the right `kind`.
    const samples: NormalizedEvent[] = [
      { kind: "init", sessionId: "s", model: "m" },
      { kind: "text", text: "t", role: "assistant" },
      { kind: "thinking", text: "t" },
      { kind: "tool_call", id: "i", name: "n", input: {} },
      { kind: "tool_result", callId: "i", output: "o", isError: false },
      { kind: "usage", input: 0, output: 0 },
      { kind: "permission_denial", tool: "t", reason: "r" },
      { kind: "rate_limit", retryAfterMs: 1000 },
      { kind: "api_retry", attempt: 1, reason: "r" },
      { kind: "done", reason: "completed" },
      { kind: "text_delta", text: "t", blockIndex: 0 },
      { kind: "stream_end" },
      { kind: "tool_progress", id: "i", name: "n", elapsedSeconds: 0 },
    ];
    const sampledKinds = samples.map((e) => e.kind).sort();
    expect(sampledKinds).toEqual([...ALL_KINDS].sort());
  });
});

// ── Wire format invariants ────────────────────────────────────────────────────

describe("NormalizedEvent: wire format invariants", () => {
  it("init is always emittable (has required fields)", () => {
    const e: NormalizedEvent = {
      kind: "init",
      sessionId: "sess-001",
      model: "claude-opus-4-5",
    };
    // permissionMode is optional
    expect(e.permissionMode).toBeUndefined();
    assertRoundTrip(e);
  });

  it("done without result or turns is valid (abort/error reasons)", () => {
    const e: NormalizedEvent = { kind: "done", reason: "abort" };
    assertRoundTrip(e);
    expect(e.result).toBeUndefined();
    expect(e.turns).toBeUndefined();
  });

  it("usage without costUSD is valid (pre-stop token counts)", () => {
    const e: NormalizedEvent = { kind: "usage", input: 120, output: 4 };
    expect(e.costUSD).toBeUndefined();
    assertRoundTrip(e);
  });

  it("text_delta without parentId is a top-level delta", () => {
    const e: NormalizedEvent = { kind: "text_delta", text: "hello", blockIndex: 0 };
    expect(e.parentId).toBeUndefined();
    assertRoundTrip(e);
  });
});
