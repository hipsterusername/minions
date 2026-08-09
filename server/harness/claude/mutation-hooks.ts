import { describeMutationToolCall, type MutationDescriptor } from "../../mutation-observability.ts";
import type { RunMutationCoordination } from "../../mutation-coordination.ts";

type HookInput = { hook_event_name?: string; tool_name?: string; tool_input?: unknown;
  tool_use_id?: string; is_interrupt?: boolean };
type HookCallback = (input: HookInput, toolUseId?: string,
  options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>;

function descriptorFor(input: HookInput, readOnlyTools: ReadonlySet<string>): MutationDescriptor | null {
  const name = input.tool_name ?? ""; const id = input.tool_use_id ?? "unknown";
  const observation = describeMutationToolCall("claude", id, name, input.tool_input);
  // MCP input fields are server-defined. A field named `path` may be a
  // database key, URL route, or other semantic value rather than the complete
  // set of files the handler can mutate. Only trust the explicit read-only
  // allowlist; conservatively coordinate every other MCP call repository-wide.
  if (name.startsWith("mcp__")) {
    if (readOnlyTools.has(name) || observation.coverage === "non_mutating") return null;
    return { operation: "shell", paths: [], opaque: true };
  }
  if (observation.descriptor) return observation.descriptor;
  return null;
}

export function createClaudeMutationHooks(coordination: RunMutationCoordination,
  readOnlyTools: ReadonlySet<string>) {
  const pre: HookCallback = async (input, toolUseId, options) => {
    const callId = input.tool_use_id ?? toolUseId ?? "unknown";
    const descriptor = descriptorFor(input, readOnlyTools);
    if (!descriptor) return { continue: true };
    const cancel = () => coordination.cancelTool(callId);
    options?.signal?.addEventListener("abort", cancel, { once: true });
    try {
      await coordination.beforeTool(callId, descriptor);
      if (options?.signal?.aborted) {
        coordination.cancelTool(callId);
        throw new Error("mutation cancelled before tool execution");
      }
      return { continue: true, hookSpecificOutput: {
        hookEventName: "PreToolUse", permissionDecision: "allow",
      } };
    } catch (error) {
      return { continue: true, hookSpecificOutput: {
        hookEventName: "PreToolUse", permissionDecision: "deny",
        permissionDecisionReason: error instanceof Error ? error.message : String(error),
      } };
    } finally { options?.signal?.removeEventListener("abort", cancel); }
  };
  const success: HookCallback = async (input, toolUseId) => {
    const error = coordination.finishTool(input.tool_use_id ?? toolUseId ?? "unknown", "success");
    if (error) return { continue: false, stopReason: error };
    return { continue: true };
  };
  const failure: HookCallback = async (input, toolUseId) => {
    coordination.finishTool(input.tool_use_id ?? toolUseId ?? "unknown",
      input.is_interrupt ? "cancelled" : "error");
    return { continue: true };
  };
  return {
    PreToolUse: [{ hooks: [pre], timeout: 180 }],
    PostToolUse: [{ hooks: [success] }],
    PostToolUseFailure: [{ hooks: [failure] }],
  };
}
