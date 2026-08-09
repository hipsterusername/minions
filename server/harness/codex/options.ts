/**
 * Codex permission and reasoning option mapping.
 *
 * Pure mapping functions from Minions normalized option types to their
 * Codex SDK equivalents. No I/O, no side effects.
 */

import type { ApprovalMode, ModelReasoningEffort, SandboxMode } from "@openai/codex-sdk";
import type {
  HarnessReasoningEffort,
  NormalizedPermissionMode,
} from "../types.ts";
import type { CodexConfigObject } from "./mcp-config.ts";

/**
 * Merge per-session instructions into the constructor-level Codex config.
 *
 * Verified against the Codex CLI bundled with @openai/codex-sdk 0.144.1:
 * `codex -c developer_instructions="sentinel" debug prompt-input` renders the
 * sentinel as an additional developer-role item while the built-in permission
 * and skills instructions remain. `base_instructions` did not render the
 * sentinel. The SDK serializes constructor config before both fresh and
 * `resume` executions, so this additive key applies to both thread paths.
 */
export function buildCodexConfig(
  baseConfig: Readonly<CodexConfigObject>,
  systemPrompt: string | undefined,
): CodexConfigObject {
  const config = { ...baseConfig };
  if (systemPrompt !== undefined && systemPrompt.length > 0) {
    config["developer_instructions"] = systemPrompt;
  }
  return config;
}

export interface MappedPermission {
  approvalPolicy: ApprovalMode;
  sandboxMode: SandboxMode;
}

/**
 * Map a Minions NormalizedPermissionMode to Codex ApprovalMode / SandboxMode.
 *
 * `plan` maps to a read-only sandbox: the agent may read and reason but the
 * sandbox blocks any mutation, which is the strongest possible enforcement of
 * plan mode's "don't change anything" contract (stronger than a model that
 * merely promises not to write). Dialectic planners rely on this.
 *
 * | permissionMode    | approvalPolicy | sandboxMode        |
 * |-------------------|----------------|--------------------|
 * | bypassPermissions | never          | danger-full-access |
 * | auto              | on-failure     | danger-full-access |
 * | default           | on-request     | danger-full-access |
 * | plan              | on-request     | read-only          |
 * | undefined         | on-failure     | danger-full-access |
 */
export function mapPermission(mode: NormalizedPermissionMode | undefined): MappedPermission {
  switch (mode) {
    case "bypassPermissions":
      return { approvalPolicy: "never", sandboxMode: "danger-full-access" };
    case "default":
      return { approvalPolicy: "on-request", sandboxMode: "danger-full-access" };
    case "plan":
      return { approvalPolicy: "on-request", sandboxMode: "read-only" };
    case "auto":
    case undefined:
      return { approvalPolicy: "on-failure", sandboxMode: "danger-full-access" };
  }
}

/**
 * Map a Minions thinking effort level to a Codex ModelReasoningEffort value.
 *
 * The stable Codex CLI accepts GPT-5.6's documented `max` value, but the
 * current TypeScript SDK's `ModelReasoningEffort` declaration still stops at
 * `xhigh`. Keep the compatibility assertion isolated here while forwarding
 * the value unchanged to the CLI.
 */
export function mapReasoningEffort(
  effort: HarnessReasoningEffort,
): ModelReasoningEffort {
  return effort as ModelReasoningEffort;
}

/**
 * Determine the Codex SandboxMode for a given set of session options.
 *
 * - plan mode → "read-only" (agent may read only, not write)
 * - all other modes → "danger-full-access", matching Claude's filesystem
 *   reach while preserving Codex's approval policy for command execution
 *
 * The worktreeIsolation parameter is a forward-compatibility hook. Isolation
 * still selects the session cwd and branch, but—like Claude—it does not impose
 * an additional OS-level filesystem boundary. The value is therefore not
 * consulted by the current mapping.
 */
export function mapSandboxMode(opts: {
  worktreeIsolation: boolean;
  permissionMode?: NormalizedPermissionMode | undefined;
}): SandboxMode {
  if (opts.permissionMode === "plan") {
    return "read-only";
  }
  return "danger-full-access";
}
