import { z } from "zod/v4";

export const worktreeLineageStatusSchema = z.enum(["open", "integrated", "abandoned"]);
export const worktreeContributionStateSchema = z.enum([
  "planned", "provisioning", "active", "ready", "queued", "integrating", "integrated", "conflicted", "failed", "discarded",
]);
export const worktreeReviewStateSchema = z.enum(["pending", "approved", "rejected"]);
export const worktreeCleanupStateSchema = z.enum(["retained", "eligible", "cleaned"]);
export const integrationQueueStateSchema = z.enum([
  "queued", "running", "succeeded", "conflicted", "failed", "cancelled",
]);
export const integrationGateStateSchema = z.enum(["pending", "passed", "failed", "waived"]);

export const worktreeContributionSnapshotSchema = z.object({
  id: z.string().min(1), lineageId: z.string().min(1), workItemId: z.string().min(1),
  originatingRunKey: z.string().min(1), runKeys: z.array(z.string().min(1)),
  branchName: z.string().min(1), worktreePath: z.string().min(1),
  baseSha: z.string().min(1), headSha: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  state: worktreeContributionStateSchema, reviewState: worktreeReviewStateSchema,
  cleanupState: worktreeCleanupStateSchema,
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
});

export const integrationGateSnapshotSchema = z.object({
  id: z.string().min(1), lineageId: z.string().min(1), contributionId: z.string().min(1).nullable(),
  scope: z.enum(["contribution", "lineage"]), name: z.string().min(1),
  status: integrationGateStateSchema, details: z.string().nullable(),
  recordedAt: z.number().int().nonnegative(),
});

export const integrationReviewSnapshotSchema = z.object({
  id: z.string().min(1), lineageId: z.string().min(1), contributionId: z.string().min(1).nullable(),
  scope: z.enum(["contribution", "lineage"]), decision: z.enum(["approved", "rejected"]),
  actor: z.string().min(1), notes: z.string().nullable(), reviewedHeadSha: z.string().nullable(),
  recordedAt: z.number().int().nonnegative(),
});

export const integrationQueueEntrySnapshotSchema = z.object({
  id: z.string().min(1), lineageId: z.string().min(1), contributionId: z.string().min(1).nullable(),
  kind: z.enum(["contribution", "lineage"]), repositoryPath: z.string().min(1),
  targetRef: z.string().min(1), expectedSourceSha: z.string().min(1),
  expectedTargetSha: z.string().min(1), state: integrationQueueStateSchema,
  revision: z.number().int().nonnegative(),
  attempt: z.number().int().positive(), workerId: z.string().nullable(), resultSha: z.string().nullable(),
  fencingToken: z.number().int().nonnegative(),
  error: z.string().nullable(), conflictDetails: z.object({ conflicts: z.array(z.string()),
    preservedPaths: z.array(z.string()), targetSha: z.string().min(1), sourceSha: z.string().min(1) }).nullable(),
  position: z.number().int().positive().nullable(),
  enqueuedAt: z.number().int().nonnegative(), startedAt: z.number().int().nonnegative().nullable(),
  finishedAt: z.number().int().nonnegative().nullable(), updatedAt: z.number().int().nonnegative(),
});

export const worktreeLineageMembershipSnapshotSchema = z.object({
  workItemId: z.string().min(1), status: z.enum(["active", "left"]),
  revision: z.number().int().nonnegative(), actor: z.string().min(1),
  joinedAt: z.number().nonnegative(), leftAt: z.number().nonnegative().nullable(),
});
export const worktreeLineageResolutionRunSnapshotSchema = z.object({
  lineageId: z.string().min(1), runKey: z.string().min(1), workItemId: z.string().min(1),
  state: z.enum(["active", "resolved", "failed"]), revision: z.number().int().nonnegative(),
  headSha: z.string().nullable(), error: z.string().nullable(),
  startedAt: z.number().nonnegative(), finishedAt: z.number().nonnegative().nullable(),
});

export const worktreeLineageSnapshotSchema = z.object({
  id: z.string().min(1), projectId: z.string().min(1), repositoryPath: z.string().min(1),
  targetRef: z.string().min(1), baseSha: z.string().min(1),
  integrationRef: z.string().min(1), integrationWorktreePath: z.string().min(1),
  integrationHeadSha: z.string().nullable(), revision: z.number().int().nonnegative(),
  integrationState: z.enum(["active", "queued", "integrating", "conflicted", "integrated", "abandoned"]),
  status: worktreeLineageStatusSchema,
  memberships: z.array(worktreeLineageMembershipSnapshotSchema),
  resolutionRuns: z.array(worktreeLineageResolutionRunSnapshotSchema),
  contributions: z.array(worktreeContributionSnapshotSchema),
  queue: z.array(integrationQueueEntrySnapshotSchema), gates: z.array(integrationGateSnapshotSchema),
  reviews: z.array(integrationReviewSnapshotSchema),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
});

export const worktreeIntegrationErrorCodeSchema = z.enum([
  "not_found", "conflict", "invalid_state", "gate_failed", "queue_busy", "validation_failed", "internal",
]);
export const worktreeIntegrationErrorSchema = z.object({ code: worktreeIntegrationErrorCodeSchema,
  message: z.string().min(1), latest: worktreeLineageSnapshotSchema.nullable() });
export const worktreeIntegrationEventSchema = z.object({
  type: z.literal("worktree_integration_changed"), operation: z.string().min(1),
  workItemId: z.string().min(1).nullable(), lineage: worktreeLineageSnapshotSchema,
  timestamp: z.number().int().nonnegative(),
});

export type WorktreeLineageStatus = z.infer<typeof worktreeLineageStatusSchema>;
export type WorktreeContributionState = z.infer<typeof worktreeContributionStateSchema>;
export type WorktreeContributionSnapshot = z.infer<typeof worktreeContributionSnapshotSchema>;
export type WorktreeLineageSnapshot = z.infer<typeof worktreeLineageSnapshotSchema>;
export type WorktreeIntegrationErrorCode = z.infer<typeof worktreeIntegrationErrorCodeSchema>;
