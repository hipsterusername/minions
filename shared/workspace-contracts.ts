import { z } from "zod/v4";

/**
 * Stable workspace identity. A UUID is deliberately opaque: callers must not
 * derive filesystem locations from it or encode a source path into it.
 */
export const workspaceIdSchema = z.string().uuid();
export type WorkspaceId = z.infer<typeof workspaceIdSchema>;

/** A path-independent reference to a registered workspace. */
export const workspaceRefSchema = z.object({
  workspaceId: workspaceIdSchema,
}).strict();
export type WorkspaceRef = z.infer<typeof workspaceRefSchema>;

/** Filesystem visibility and mutation boundary granted to an execution. */
export const filesystemScopeSchema = z.enum([
  "read-only",
  "workspace-write",
  "unrestricted",
]);
export type FilesystemScope = z.infer<typeof filesystemScopeSchema>;

/** When an execution must obtain approval before performing guarded actions. */
export const approvalPolicySchema = z.enum([
  "always",
  "on-request",
  "on-failure",
  "never",
]);
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;

/**
 * Provider-neutral execution boundary. Both axes are required so a partial
 * policy can never silently inherit a provider-specific default.
 */
const sandboxPolicyAxesSchema = z.object({
  filesystemScope: filesystemScopeSchema,
  approvalPolicy: approvalPolicySchema,
}).strict();

/**
 * Older persisted policies included a networkAccess axis. Network isolation
 * is not consistently enforceable across harnesses, so accept and discard
 * that known legacy field while retaining strict validation for other keys.
 */
export const sandboxPolicySchema = z.preprocess(
  stripLegacyNetworkAccess,
  sandboxPolicyAxesSchema,
);
export type SandboxPolicy = z.infer<typeof sandboxPolicySchema>;

/** Safe, provider-neutral posture used when a project has no saved override. */
export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = {
  filesystemScope: "workspace-write",
  approvalPolicy: "on-failure",
};

const effectiveSandboxPolicyAxesSchema = z.object({
  filesystemScope: filesystemScopeSchema.or(z.literal("unmanaged")),
  approvalPolicy: approvalPolicySchema.or(z.literal("unmanaged")),
}).strict();
export const effectiveSandboxPolicySchema = z.preprocess(
  stripLegacyNetworkAccess,
  effectiveSandboxPolicyAxesSchema,
);
export type EffectiveSandboxPolicy = z.infer<typeof effectiveSandboxPolicySchema>;

/** Requested policy plus the guarantees the selected harness can actually enforce. */
export const sandboxResolutionSchema = z.object({
  requested: sandboxPolicySchema,
  effective: effectiveSandboxPolicySchema,
  unsupported: z.array(z.string()),
}).strict().transform((resolution) => ({
  ...resolution,
  unsupported: resolution.unsupported.filter((axis) => axis !== "network"),
}));
export type SandboxResolution = z.infer<typeof sandboxResolutionSchema>;

function stripLegacyNetworkAccess(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record["networkAccess"] !== "disabled"
    && record["networkAccess"] !== "enabled"
    && record["networkAccess"] !== "unmanaged") return value;
  const { networkAccess: _legacyNetworkAccess, ...remaining } = record;
  return remaining;
}
