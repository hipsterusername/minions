import { describe, expect, it, vi } from "vitest";
import type { RunMutationCoordination } from "../../mutation-coordination.ts";
import { createClaudeMutationHooks } from "./mutation-hooks.ts";

function callback(hooks: ReturnType<typeof createClaudeMutationHooks>, key: keyof typeof hooks) {
  return hooks[key]![0]!.hooks[0]!;
}
describe("Claude mutation hooks", () => {
  it("coordinates known writes from pre through successful post", async () => {
    const coordination = { beforeTool: vi.fn(), finishTool: vi.fn(), cancelTool: vi.fn() };
    const hooks = createClaudeMutationHooks(coordination as unknown as RunMutationCoordination, new Set());
    const result = await callback(hooks, "PreToolUse")({ tool_name: "Write",
      tool_input: { file_path: "src/a.ts" }, tool_use_id: "call" });
    expect(coordination.beforeTool).toHaveBeenCalledWith("call",
      { operation: "write", paths: ["src/a.ts"], opaque: false });
    expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
    await callback(hooks, "PostToolUse")({ tool_use_id: "call" });
    expect(coordination.finishTool).toHaveBeenCalledWith("call", "success");
  });

  it("stops cleanly instead of rejecting PostToolUse when baseline refresh fails", async () => {
    const coordination = { beforeTool: vi.fn(),
      finishTool: vi.fn().mockReturnValue("live-edit baseline refresh failed: read denied"),
      cancelTool: vi.fn() };
    const hooks = createClaudeMutationHooks(coordination as unknown as RunMutationCoordination, new Set());
    await expect(callback(hooks, "PostToolUse")({ tool_use_id: "call" })).resolves.toEqual({
      continue: false, stopReason: "live-edit baseline refresh failed: read denied",
    });
  });

  it("uses repository scope for unknown MCP routes and denies claim failures", async () => {
    const coordination = { beforeTool: vi.fn().mockRejectedValue(new Error("conflict")),
      finishTool: vi.fn(), cancelTool: vi.fn() };
    const hooks = createClaudeMutationHooks(coordination as unknown as RunMutationCoordination, new Set());
    const result = await callback(hooks, "PreToolUse")({ tool_name: "mcp__external__do_thing",
      tool_input: {}, tool_use_id: "opaque" });
    expect(coordination.beforeTool).toHaveBeenCalledWith("opaque",
      { operation: "shell", paths: [], opaque: true });
    expect(result).toMatchObject({ hookSpecificOutput: {
      permissionDecision: "deny", permissionDecisionReason: "conflict" } });
  });

  it("does not trust mutation-like MCP names or semantic path fields as filesystem coverage", async () => {
    const coordination = { beforeTool: vi.fn(), finishTool: vi.fn(), cancelTool: vi.fn() };
    const hooks = createClaudeMutationHooks(coordination as unknown as RunMutationCoordination, new Set());
    await callback(hooks, "PreToolUse")({ tool_name: "mcp__external__update_route",
      tool_input: { path: "customers/42" }, tool_use_id: "external" });
    expect(coordination.beforeTool).toHaveBeenCalledWith("external",
      { operation: "shell", paths: [], opaque: true });
  });

  it("never wraps change-intent coordination tools in a second lease", async () => {
    const coordination = { beforeTool: vi.fn(), finishTool: vi.fn(), cancelTool: vi.fn() };
    const hooks = createClaudeMutationHooks(coordination as unknown as RunMutationCoordination, new Set());
    await callback(hooks, "PreToolUse")({ tool_name: "mcp__change-intent__open_change_intent",
      tool_input: {}, tool_use_id: "intent" });
    expect(coordination.beforeTool).not.toHaveBeenCalled();
  });
});
