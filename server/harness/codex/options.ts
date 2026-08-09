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
import type { SandboxPolicy } from "../../../shared/workspace-contracts.ts";
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
  networkAccessEnabled: boolean;
}

/**
 * Map the resolved provider-neutral policy to Codex thread options.
 *
 * `plan` maps to a read-only sandbox: the agent may read and reason but the
 * sandbox blocks any mutation, which is the strongest possible enforcement of
 * plan mode's "don't change anything" contract (stronger than a model that
 * merely promises not to write). Dialectic planners rely on this.
 *
 * `permissionMode` is only a fallback for legacy payloads that do not carry a
 * provider-neutral policy. Once an explicit policy exists it is authoritative
 * for every Codex sandbox axis.
 */
export function mapPermission(
  policy: SandboxPolicy | undefined,
  legacyMode?: NormalizedPermissionMode | undefined,
): MappedPermission {
  const fallbackApproval = legacyMode === "bypassPermissions" ? "never"
    : legacyMode === "default" || legacyMode === "plan" ? "on-request" : "on-failure";
  const filesystem = policy?.filesystemScope ?? "read-only";
  const approvalPolicy = policy?.approvalPolicy === "always" ? "untrusted"
    : policy?.approvalPolicy ?? fallbackApproval;
  return {
    approvalPolicy,
    sandboxMode: filesystem === "unrestricted" ? "danger-full-access" : filesystem,
    networkAccessEnabled: policy?.networkAccess === "enabled",
  };
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
 * - authorized execution roots → "workspace-write"
 */
export function mapSandboxMode(opts: {
  worktreeIsolation: boolean;
  permissionMode?: NormalizedPermissionMode | undefined;
}): SandboxMode {
  if (opts.permissionMode === "plan") {
    return "read-only";
  }
  return "workspace-write";
}
