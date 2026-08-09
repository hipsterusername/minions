import type {
  HarnessSandboxResolution,
  HarnessSandboxSupport,
  NormalizedPermissionMode,
} from "./types.ts";
import type { ApprovalPolicy, SandboxPolicy } from "../../shared/workspace-contracts.ts";

/** Explicit input accepted at the session boundary. */
export type HarnessSandboxPolicyInput = SandboxPolicy;

export function approvalPolicyForPermission(
  mode: NormalizedPermissionMode | undefined,
): ApprovalPolicy {
  switch (mode) {
    case "bypassPermissions": return "never";
    case "default":
    case "plan": return "on-request";
    case "acceptEdits":
    case "auto":
    case undefined: return "on-failure";
  }
}

/**
 * Resolve a run policy without ever inferring full-host access. An explicit
 * provider-neutral policy is authoritative; legacy permission mode is used
 * only when no policy was supplied.
 */
export function resolveHarnessSandboxPolicy(input: {
  requested?: HarnessSandboxPolicyInput | undefined;
  permissionMode?: NormalizedPermissionMode | undefined;
  worktreeScoped: boolean;
  support?: HarnessSandboxSupport | undefined;
}): HarnessSandboxResolution {
  const filesystemScope = input.requested === undefined && input.permissionMode === "plan"
    ? "read-only"
    : input.requested?.filesystemScope ?? "workspace-write";
  const requested: SandboxPolicy = {
    filesystemScope,
    networkAccess: input.requested?.networkAccess ?? "disabled",
    approvalPolicy: input.requested?.approvalPolicy
      ?? approvalPolicyForPermission(input.permissionMode),
  };
  const unsupported: string[] = [];
  const support = input.support;
  const effective: HarnessSandboxResolution["effective"] = {
    filesystemScope: support?.filesystem.includes(requested.filesystemScope)
      ? requested.filesystemScope : "unmanaged",
    networkAccess: support?.network === true ? requested.networkAccess : "unmanaged",
    approvalPolicy: support?.approval === true ? requested.approvalPolicy : "unmanaged",
  };
  if (effective.filesystemScope === "unmanaged") unsupported.push(`filesystem:${requested.filesystemScope}`);
  if (effective.networkAccess === "unmanaged") unsupported.push("network");
  if (effective.approvalPolicy === "unmanaged") unsupported.push("approval");
  return { requested, effective, unsupported };
}
