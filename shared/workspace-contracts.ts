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

/** Network availability is independent from filesystem and approval posture. */
export const networkAccessSchema = z.enum([
  "disabled",
  "enabled",
]);
export type NetworkAccess = z.infer<typeof networkAccessSchema>;

/**
 * Provider-neutral execution boundary. All axes are required so a partial
 * policy can never silently inherit a provider-specific default.
 */
export const sandboxPolicySchema = z.object({
  filesystemScope: filesystemScopeSchema,
  approvalPolicy: approvalPolicySchema,
  networkAccess: networkAccessSchema,
}).strict();
export type SandboxPolicy = z.infer<typeof sandboxPolicySchema>;

export const effectiveSandboxPolicySchema = z.object({
  filesystemScope: filesystemScopeSchema.or(z.literal("unmanaged")),
  approvalPolicy: approvalPolicySchema.or(z.literal("unmanaged")),
  networkAccess: networkAccessSchema.or(z.literal("unmanaged")),
}).strict();
export type EffectiveSandboxPolicy = z.infer<typeof effectiveSandboxPolicySchema>;

/** Requested policy plus the guarantees the selected harness can actually enforce. */
export const sandboxResolutionSchema = z.object({
  requested: sandboxPolicySchema,
  effective: effectiveSandboxPolicySchema,
  unsupported: z.array(z.string()),
}).strict();
export type SandboxResolution = z.infer<typeof sandboxResolutionSchema>;
