import { z } from "zod/v4";

export const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const jsonRecordSchema = z.record(z.string(), z.unknown());
export const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(20),
  backoffMs: z.number().int().nonnegative().max(86_400_000),
  retryableOutcomes: z.array(z.enum(["failed", "lost", "cancelled"])),
  jitterMs: z.number().int().nonnegative().max(60_000).default(0),
});
export const expansionPolicySchema = z.object({
  maxChildren: z.number().int().nonnegative().max(1_000),
  maxDepth: z.number().int().nonnegative().max(8),
}).nullable().default(null);
export const ownershipRequestSchema = z.object({
  scope:z.enum(["path","symbol"]),mode:z.enum(["read","write"]),normalizedValue:z.string().min(1),
});
export const budgetRequestSchema = z.looseObject({
  tokens:z.number().int().positive().optional(),maxTokens:z.number().int().positive().optional(),
  costMicros:z.number().int().positive().optional(),maxCostMicros:z.number().int().positive().optional(),
});
export const taskNodeSchema = z.object({
  id: z.string().min(1), title: z.string().min(1), objective: z.string().min(1),
  inputBindings: jsonRecordSchema.default({}), outputSchemas: jsonRecordSchema.default({}),
  constraints: z.array(z.string()).default([]), acceptanceCriteria: z.array(z.string()).default([]),
  executorClass: z.enum(["mechanical","standard","reasoning"]), allowedHarnesses: z.array(z.string().min(1)).min(1),
  allowedTools: z.array(z.string()).default([]), ownershipRequest: z.array(ownershipRequestSchema).default([]),
  budgetRequest: budgetRequestSchema.default({}), timeoutMs: z.number().int().positive().max(604_800_000),
  retryPolicy: retryPolicySchema, verificationRequired: z.boolean().default(false),
  failurePolicy: z.enum(["fail_graph", "block_for_decision", "continue_optional", "satisfy_all_terminal_only", "activate_fallback_node"]),
  expansionPolicy: expansionPolicySchema,
});
export const taskEdgeSchema = z.object({
  id: z.string().min(1), sourceNodeId: z.string().min(1), targetNodeId: z.string().min(1),
  kind: z.enum(["control", "artifact", "verified_artifact", "human_gate"]),
  sourceOutput: z.string().nullable().default(null), targetInput: z.string().nullable().default(null),
  satisfactionPolicy: z.enum(["all_success", "all_terminal", "any_success", "quorum", "reduce"]),
  quorum: z.number().int().positive().optional(),
  failurePolicy: z.enum(["block", "skip", "fail"]), optional: z.boolean().default(false),
});
export const graphRevisionInputSchema = z.object({
  definitionId: z.string().min(1), revisionId: z.string().min(1), workItemId: z.string().min(1),
  workspaceId: z.string().min(1), objective: z.string().min(1),
  acceptanceCriteria: z.array(z.string()), nonGoals: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]), terminalNodeIds: z.array(z.string()).min(1),
  nodes: z.array(taskNodeSchema).min(1).max(1_000), edges: z.array(taskEdgeSchema).max(20_000),
  maxActiveAttempts: z.number().int().min(1).max(100),
  budgetLimits: z.object({ tokenLimit:z.number().int().nonnegative().nullable(),
    costMicrosLimit:z.number().int().nonnegative().nullable() }).optional(),
});
export const sourceSnapshotSchema = z.object({
  id: z.string().min(1), workItemId: z.string().min(1), primaryRunKey: z.string().min(1),
  taskGraphRevisionId: z.string().min(1), repositoryBaseCommit: z.string().min(1),
  dirtyDiffDigest: hashSchema, workspaceId: z.string().min(1), worktreeIdentity: z.string().min(1),
  systemModelDigest: hashSchema, workPacketRevisionId: z.string().min(1).nullable(),
  connectedContext: z.array(z.object({ sourceId: z.string(), contentHash: hashSchema, classification: z.string() })),
  compiledSkills: z.array(z.object({ skillId: z.string(), version: z.string(), contentHash: hashSchema, valuesHash: hashSchema })),
  harnessPolicyDigest: hashSchema, toolPolicyDigest: hashSchema, createdAt: z.number().int().nonnegative(),
});
export const attemptEventSchema = z.object({
  runId: z.string().min(1), attemptId: z.string().min(1), generation: z.number().int().positive(),
  actorSessionKey: z.string().min(1), idempotencyKey: z.string().min(1),
  expectedRunRevision: z.number().int().nonnegative(), at: z.number().int().nonnegative(),
});
export const artifactInputSchema = z.object({
  id: z.string().min(1), schemaName: z.string().min(1), schemaVersion: z.string().min(1),
  contentHash: hashSchema, storageRef: z.string().min(1), byteSize: z.number().int().nonnegative(),
  classification: z.enum(["public", "internal", "sensitive", "secret"]),
  retentionPolicy: z.string().min(1), outputName: z.string().min(1), observedWriteSet: z.array(z.string()),
});
export const verificationInputSchema = z.object({
  id: z.string().min(1), runId: z.string().min(1), nodeId: z.string().min(1),
  producerAttemptId: z.string().min(1), verifierAttemptId: z.string().min(1), sourceSnapshotId: z.string().min(1),
  artifactHashes: z.array(hashSchema).min(1), acceptanceCriteriaVersion: hashSchema,
  method: z.enum(["deterministic", "independent_agent", "human"]),
  evidenceRefs: z.array(z.string()), result: z.enum(["pending", "passed", "failed", "inconclusive", "waived"]),
  confidence: z.number().min(0).max(1).nullable(), at: z.number().int().nonnegative(),
});
export const graphRunStatusSchema = z.enum(["active", "quiescent", "blocked", "completed", "failed", "cancelled"]);
export const attemptOutcomeSchema = z.enum(["none", "succeeded", "failed", "cancelled", "lost", "superseded"]);
export const graphEventSchema = z.object({
  sequence: z.number().int().positive(), runId: z.string(), runRevision: z.number().int().nonnegative(),
  type: z.string(), objectId: z.string(), payload: jsonRecordSchema, createdAt: z.number().int().nonnegative(),
});
export const graphSnapshotSchema = z.object({
  run: z.object({ id: z.string(), workItemId: z.string(), primaryRunKey: z.string(), revisionId: z.string(),
    sourceSnapshotId: z.string(), status: graphRunStatusSchema, paused: z.boolean(), revision: z.number().int().nonnegative(),
    maxActiveAttempts: z.number().int().positive(), createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative() }),
  revision: graphRevisionInputSchema, sourceSnapshot: sourceSnapshotSchema,
  attempts: z.array(jsonRecordSchema), artifacts: z.array(jsonRecordSchema), verifications: z.array(jsonRecordSchema),
  verificationRequests: z.array(jsonRecordSchema), humanInputs: z.array(jsonRecordSchema),
  edgeEvaluations: z.array(jsonRecordSchema), reservations: z.array(jsonRecordSchema),
  joins: z.array(jsonRecordSchema), outbox: z.array(jsonRecordSchema),
  schedulerLease: jsonRecordSchema.nullable(), expansions: z.array(jsonRecordSchema),
  reductions: z.array(jsonRecordSchema), reconciliations: z.array(jsonRecordSchema),
  steeringEvents: z.array(jsonRecordSchema), invalidations: z.array(jsonRecordSchema),
  usage: z.array(jsonRecordSchema),
  events: z.array(graphEventSchema),
});

export type GraphRevisionInput = z.infer<typeof graphRevisionInputSchema>;
export type TaskNode = z.infer<typeof taskNodeSchema>;
export type TaskEdge = z.infer<typeof taskEdgeSchema>;
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;
export type AttemptEvent = z.infer<typeof attemptEventSchema>;
export type ArtifactInput = z.infer<typeof artifactInputSchema>;
export type VerificationInput = z.infer<typeof verificationInputSchema>;
export type GraphSnapshot = z.infer<typeof graphSnapshotSchema>;
