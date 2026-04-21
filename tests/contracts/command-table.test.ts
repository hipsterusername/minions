/**
 * Contract: every `WsCommandType` has a registered handler in the
 * `COMMAND_TABLE`, and no extra entries exist.
 *
 * The value of splitting the dispatcher in Phase 5.2 is that adding a new
 * command becomes a typed, file-local change. This test exists to make
 * sure the dispatcher stays exhaustive — if someone adds a `WsCommandType`
 * without wiring a handler, this test fails loudly instead of the command
 * silently producing a runtime "Unknown command type" error.
 *
 * It also guards the reverse: the registry cannot have handlers for
 * command names that are not in the `WsCommandType` union.
 */

import { describe, expect, it } from "vitest";
import { COMMAND_TABLE } from "../../server/commands/index.ts";
import type { WsCommandType } from "../../server/commands/types.ts";

// Authoritative list of every command the server accepts. Keep this
// aligned with the `WsCommandType` union; the `expectedCommands` constant
// is what the typechecker will flag on drift.
const EXPECTED_COMMANDS: readonly WsCommandType[] = [
  "create_session",
  "send_message",
  "stop_session",
  "sync_session",
  "list_sessions",
  "interrupt",
  "interrupt_session",
  "close_session",
  "set_permission_mode",
  "set_model",
  "stop_task",
  "merge_worktree",
  "discard_worktree",
  "get_worktree_diff",
  "approve_changes",
  "force_merge",
  "theirs_merge",
  "retry_merge",
  "remove_session",
  "rewind_files",
  "seed_read_state",
  "get_context_usage",
  "get_supported_models",
  "get_supported_commands",
  "get_supported_agents",
  "get_account_info",
  "get_mcp_server_status",
  "reconnect_mcp_server",
  "toggle_mcp_server",
];

describe("commands/index — COMMAND_TABLE contract", () => {
  it("has a registered handler for every WsCommandType", () => {
    const missing: string[] = [];
    for (const cmd of EXPECTED_COMMANDS) {
      if (typeof COMMAND_TABLE[cmd] !== "function") {
        missing.push(cmd);
      }
    }
    expect(missing).toEqual([]);
  });

  it("has no unexpected entries beyond WsCommandType", () => {
    const registered = Object.keys(COMMAND_TABLE);
    const expected = new Set<string>(EXPECTED_COMMANDS);
    const extra = registered.filter((key) => !expected.has(key));
    expect(extra).toEqual([]);
  });

  it("covers the full EXPECTED_COMMANDS list", () => {
    const registered = new Set(Object.keys(COMMAND_TABLE));
    expect(registered.size).toBe(EXPECTED_COMMANDS.length);
    for (const cmd of EXPECTED_COMMANDS) {
      expect(registered.has(cmd)).toBe(true);
    }
  });
});
