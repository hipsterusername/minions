/**
 * Codex permission and reasoning option mapping.
 *
 * Pure mapping functions from Minions normalized option types to their
 * Codex SDK equivalents. No I/O, no side effects.
 *
 * See docs/codex-harness-spec.md §5 (Open Questions / permission mapping table)
 * for the canonical mapping rationale.
 */

import type { ApprovalMode, ModelReasoningEffort, SandboxMode } from "@openai/codex-sdk";
import type {
  HarnessReasoningEffort,
  NormalizedPermissionMode,
} from "../types.ts";

// ── MappedPermission ──────────────────────────────────────────────────────────

export interface MappedPermission {
  approvalPolicy: ApprovalMode;
  sandboxMode: SandboxMode;
  /** True when the requested mode has no Codex equivalent and is approximated. */
  unsupported: boolean;
}

// ── mapPermission ─────────────────────────────────────────────────────────────

/**
 * Map a Minions NormalizedPermissionMode to Codex ApprovalMode / SandboxMode.
 *
 * | permissionMode    | approvalPolicy | sandboxMode     | unsupported |
 * |-------------------|----------------|-----------------|-------------|
 * | bypassPermissions | never          | danger-full-access | false    |
 * | auto              | on-failure     | danger-full-access | false    |
 * | default           | on-request     | danger-full-access | false    |
 * | plan              | on-request     | read-only       | true        |
 * | undefined         | on-failure     | danger-full-access | false    |
 */
export function mapPermission(mode: NormalizedPermissionMode | undefined): MappedPermission {
  switch (mode) {
    case "bypassPermissions":
      return { approvalPolicy: "never", sandboxMode: "danger-full-access", unsupported: false };
    case "default":
      return { approvalPolicy: "on-request", sandboxMode: "danger-full-access", unsupported: false };
    case "plan":
      return { approvalPolicy: "on-request", sandboxMode: "read-only", unsupported: true };
    case "auto":
    case undefined:
      return { approvalPolicy: "on-failure", sandboxMode: "danger-full-access", unsupported: false };
  }
}

// ── mapReasoningEffort ────────────────────────────────────────────────────────

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

// ── mapSandboxMode ────────────────────────────────────────────────────────────

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
