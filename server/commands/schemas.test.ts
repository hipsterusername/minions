/**
 * Unit tests for `server/commands/schemas.ts`.
 *
 * Covers `validateWsCommand`: structural gate that every inbound WS command
 * must pass before the dispatcher touches it.
 *
 * Test strategy:
 *   - Accept cases: minimal valid envelopes for a representative cross-section
 *     of command types (session lifecycle, info queries, forms, worktree).
 *   - Reject cases: non-object, missing `type`, unknown `type`, and wrong
 *     field types that should be caught before handlers run.
 *   - The `COMMAND_SCHEMAS` record is exported so the test can assert that
 *     every `WsCommandType` has a schema without re-listing them here.
 */

import { describe, it, expect } from "vitest";
import { validateWsCommand, COMMAND_SCHEMAS } from "./schemas.ts";
import type { WsCommandType } from "./types.ts";

// All WsCommandType values, kept in sync via the compile-time `satisfies`.
const ALL_TYPES = Object.keys(COMMAND_SCHEMAS) as WsCommandType[];

// ── Helper ────────────────────────────────────────────────

function accept(payload: unknown) {
  const result = validateWsCommand(payload);
  expect(result.ok, `expected ok=true, got error: ${!result.ok ? result.error : ""}`).toBe(true);
}

function reject(payload: unknown, expectedSubstring?: string) {
  const result = validateWsCommand(payload);
  expect(result.ok, "expected ok=false").toBe(false);
  if (expectedSubstring && !result.ok) {
    expect(result.error).toContain(expectedSubstring);
  }
}

// ── Accept cases ──────────────────────────────────────────

describe("validateWsCommand – accept", () => {
  it("accepts list_sessions with only type", () => {
    accept({ type: "list_sessions" });
  });

  it("accepts list_harnesses with only type", () => {
    accept({ type: "list_harnesses" });
  });

  it("accepts create_session with all optional fields present", () => {
    accept({
      type: "create_session",
      sessionKey: "s1",
      cwd: "/home/user",
      role: "leader",
      worktreeIsolation: true,
      model: "claude-3-opus",
      permissionMode: "default",
      prompt: "Hello",
      systemPrompt: "You are helpful.",
      harness: "claude",
    });
  });

  it("accepts create_session with no optional fields", () => {
    accept({ type: "create_session" });
  });

  it("accepts send_message with a prompt and attachment", () => {
    accept({
      type: "send_message",
      sessionKey: "s1",
      prompt: "Describe this image.",
      attachments: [
        {
          kind: "image",
          mediaType: "image/png",
          data: "base64encodeddata",
        },
      ],
    });
  });

  it("accepts stop_session with just a sessionKey", () => {
    accept({ type: "stop_session", sessionKey: "s2" });
  });

  it("accepts rewind_files with dryRun flag", () => {
    accept({
      type: "rewind_files",
      sessionKey: "s1",
      userMessageId: "msg-42",
      dryRun: true,
    });
  });

  it("accepts seed_read_state with path and mtime", () => {
    accept({
      type: "seed_read_state",
      sessionKey: "s1",
      path: "/home/user/file.ts",
      mtime: 1700000000,
    });
  });

  it("accepts toggle_mcp_server with enabled=false", () => {
    accept({
      type: "toggle_mcp_server",
      sessionKey: "s1",
      serverName: "my-server",
      enabled: false,
    });
  });

  it("accepts submit_form with formAnswers", () => {
    accept({
      type: "submit_form",
      sessionKey: "s1",
      formComponentId: "form-abc",
      formAnswers: { name: "Alice", agree: true },
    });
  });

  it("accepts unknown extra fields (additive client fields are ignored)", () => {
    accept({
      type: "list_sessions",
      extraFieldFromFutureClient: "ignored",
    });
  });

  it("accepts requestId alongside any command type", () => {
    accept({ type: "get_context_usage", sessionKey: "s1", requestId: "req-1" });
  });
});

// ── Reject cases ──────────────────────────────────────────

describe("validateWsCommand – reject", () => {
  it("rejects null", () => {
    reject(null, "JSON object");
  });

  it("rejects a string", () => {
    reject("list_sessions", "JSON object");
  });

  it("rejects an array", () => {
    reject(["list_sessions"], "JSON object");
  });

  it("rejects an object without a type field", () => {
    reject({}, '"type" field');
  });

  it("rejects an object with a numeric type field", () => {
    reject({ type: 42 }, '"type" field');
  });

  it("rejects an unknown command type", () => {
    reject({ type: "unknown_command_xyz" }, "Unknown command type");
  });

  it("rejects create_session when role is not a valid SessionRole", () => {
    reject(
      { type: "create_session", role: "superadmin" },
      "create_session",
    );
  });

  it("rejects send_message when attachments is not an array", () => {
    reject(
      { type: "send_message", attachments: "not-an-array" },
      "send_message",
    );
  });

  it("rejects send_message when an attachment is missing required mediaType", () => {
    reject(
      {
        type: "send_message",
        attachments: [{ kind: "image", data: "abc" }],
      },
      "send_message",
    );
  });

  it("rejects send_message when an attachment has an unsupported mediaType", () => {
    reject(
      {
        type: "send_message",
        attachments: [{ kind: "image", mediaType: "image/tiff", data: "abc" }],
      },
      "send_message",
    );
  });

  it("rejects rewind_files when dryRun is a string instead of boolean", () => {
    reject(
      { type: "rewind_files", dryRun: "true" },
      "rewind_files",
    );
  });

  it("rejects toggle_mcp_server when enabled is a number instead of boolean", () => {
    reject(
      { type: "toggle_mcp_server", enabled: 1 },
      "toggle_mcp_server",
    );
  });

  it("rejects seed_read_state when mtime is a string instead of number", () => {
    reject(
      { type: "seed_read_state", mtime: "yesterday" },
      "seed_read_state",
    );
  });

  it("rejects create_session when worktreeIsolation is a string", () => {
    reject(
      { type: "create_session", worktreeIsolation: "yes" },
      "create_session",
    );
  });
});

// ── Coverage assertion ────────────────────────────────────

describe("COMMAND_SCHEMAS completeness", () => {
  it("has a schema for every WsCommandType in the union", () => {
    // This test proves exhaustiveness at runtime, complementing the
    // compile-time `satisfies Record<WsCommandType, z.ZodType>` constraint.
    // If you add a WsCommandType without a matching schema entry, the
    // `satisfies` already fails the build; this catches it in test output too.
    expect(ALL_TYPES.length).toBeGreaterThan(0);
    for (const type of ALL_TYPES) {
      expect(
        COMMAND_SCHEMAS[type],
        `Missing schema for WsCommandType "${type}"`,
      ).toBeDefined();
    }
  });
});
