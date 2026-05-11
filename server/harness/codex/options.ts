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
import type { NormalizedPermissionMode } from "../types.ts";

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
 * | bypassPermissions | never          | workspace-write | false       |
 * | auto              | on-failure     | workspace-write | false       |
 * | default           | on-request     | workspace-write | false       |
 * | plan              | on-request     | read-only       | true        |
 * | undefined         | on-failure     | workspace-write | false       |
 */
export function mapPermission(mode: NormalizedPermissionMode | undefined): MappedPermission {
  switch (mode) {
    case "bypassPermissions":
      return { approvalPolicy: "never", sandboxMode: "workspace-write", unsupported: false };
    case "default":
      return { approvalPolicy: "on-request", sandboxMode: "workspace-write", unsupported: false };
    case "plan":
      return { approvalPolicy: "on-request", sandboxMode: "read-only", unsupported: true };
    case "auto":
    case undefined:
      return { approvalPolicy: "on-failure", sandboxMode: "workspace-write", unsupported: false };
  }
}

// ── mapReasoningEffort ────────────────────────────────────────────────────────

/**
 * Map a Minions thinking effort level to a Codex ModelReasoningEffort value.
 *
 * The harness thinking.effort union is low/medium/high. Codex also supports
 * "minimal" and "xhigh", but those are not surfaced through the harness API yet.
 */
export function mapReasoningEffort(effort: "low" | "medium" | "high"): ModelReasoningEffort {
  return effort;
}

// ── mapSandboxMode ────────────────────────────────────────────────────────────

/**
 * Determine the Codex SandboxMode for a given set of session options.
 *
 * - plan mode → "read-only" (agent may read only, not write)
 * - all other modes → "workspace-write" (full write access in the worktree)
 *
 * The worktreeIsolation parameter is a forward-compatibility hook. When
 * worktree isolation is active the session already runs inside an isolated
 * git worktree, so "workspace-write" is safe. The value is reserved for
 * future use and is not consulted in the MVP mapping.
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
