import { z } from "zod/v4";
import {
  budgetRequestSchema,
  jsonRecordSchema,
  ownershipRequestSchema,
  retryPolicySchema,
} from "./task-graph-contracts.ts";
import { wsEnvelopeSchema } from "./ws-envelope.ts";

const idSchema = z.string().min(1);
const revisionSchema = z.number().int().nonnegative();
const stepKeySchema = z.string().trim().min(1).max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const leaderOrchestrationModeSchema = z.enum(["auto", "plan", "direct"]);

export const semanticGraphDependencySchema = z.object({
  stepKey: stepKeySchema,
  kind: z.enum(["control", "artifact", "verified_artifact"]).default("control"),
  sourceOutput: z.string().min(1).nullable().default(null),
  targetInput: z.string().min(1).nullable().default(null),
  optional: z.boolean().default(false),
  failurePolicy: z.enum(["block", "skip", "fail"]).default("block"),
});

export const semanticGraphPlanStepSchema = z.object({
  key: stepKeySchema,
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
  constraints: z.array(z.string().trim().min(1)).default([]),
  dependsOn: z.array(semanticGraphDependencySchema).default([]),
  contextSelectors: z.array(z.string().trim().min(1)).default([])
    .describe("Task-scoped source selectors. Prefix connected-canvas selectors with canvas:; use repo: for repository paths or symbols."),
  inputBindings: jsonRecordSchema.default({}),
  outputSchemas: jsonRecordSchema.default({}),
  executorClass: z.enum(["mechanical", "standard", "reasoning"]).default("standard"),
  allowedHarnesses: z.array(idSchema).min(1).optional(),
  allowedTools: z.array(z.string()).optional().describe(
    "Exact harness built-in or fully qualified MCP tool identifiers (for example Read or mcp__server__tool). Omit this field to inherit the selected harness policy, including harness-native shell/filesystem access that has no allowlist identifier.",
  ),
  ownershipRequest: z.array(ownershipRequestSchema).default([]),
  budgetRequest: budgetRequestSchema.default({}),
  timeoutMs: z.number().int().positive().max(604_800_000).default(1_800_000),
  retryPolicy: retryPolicySchema.default({
    maxAttempts: 2,
    backoffMs: 1_000,
    retryableOutcomes: ["failed", "lost"],
    jitterMs: 0,
  }),
  completionMode: z.enum(["task", "verification"]).optional()
    .describe("Use verification only when this step's own completion is a structured pass/fail/inconclusive verdict; verificationRequired separately requests independent verification of this step's produced artifacts."),
  verificationRequired: z.boolean().default(false),
  failurePolicy: z.enum([
    "fail_graph", "block_for_decision", "continue_optional", "satisfy_all_terminal_only",
  ]).optional().describe("Defaults to block_for_decision for verification-mode steps and fail_graph for ordinary task steps."),
  risk: z.enum(["low", "medium", "high"]).default("low"),
  requiresApproval: z.boolean().default(false),
});

export const semanticTaskGraphPlanSchema = z.object({
  objective: z.string().trim().min(1),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
  nonGoals: z.array(z.string().trim().min(1)).default([]),
  constraints: z.array(z.string().trim().min(1)).default([]),
  assumptions: z.array(z.string().trim().min(1)).default([]),
  questions: z.array(z.string().trim().min(1)).max(1).default([]),
  workPacketId: idSchema.nullable().optional(),
  steps: z.array(semanticGraphPlanStepSchema).min(1).max(1_000),
  terminalStepKeys: z.array(stepKeySchema).min(1).optional(),
  maxActiveAttempts: z.number().int().min(1).max(100).default(4),
  budgetLimits: z.object({
    tokenLimit: z.number().int().nonnegative().nullable(),
    costMicrosLimit: z.number().int().nonnegative().nullable(),
  }).optional(),
}).superRefine((plan, ctx) => {
  const keys = new Set<string>();
  plan.steps.forEach((step, index) => {
    if (keys.has(step.key)) ctx.addIssue({
      code: "custom", path: ["steps", index, "key"], message: `duplicate step key: ${step.key}`,
    });
    keys.add(step.key);
  });
  plan.steps.forEach((step, index) => step.dependsOn.forEach((dependency, dependencyIndex) => {
    if (!keys.has(dependency.stepKey)) ctx.addIssue({
      code: "custom", path: ["steps", index, "dependsOn", dependencyIndex, "stepKey"],
      message: `unknown dependency step: ${dependency.stepKey}`,
    });
    if (dependency.stepKey === step.key) ctx.addIssue({
      code: "custom", path: ["steps", index, "dependsOn", dependencyIndex, "stepKey"],
      message: "a step cannot depend on itself",
    });
    const artifact = dependency.kind !== "control";
    if (artifact && (!dependency.sourceOutput || !dependency.targetInput)) ctx.addIssue({
      code: "custom", path: ["steps", index, "dependsOn", dependencyIndex],
      message: "artifact dependencies require sourceOutput and targetInput",
    });
  }));
  plan.terminalStepKeys?.forEach((key, index) => {
    if (!keys.has(key)) ctx.addIssue({
      code: "custom", path: ["terminalStepKeys", index], message: `unknown terminal step: ${key}`,
    });
  });
});

export const taskGraphPlanStateSchema = z.enum([
  "needs_input", "ready", "stale", "starting", "running", "completed", "failed",
  "cancelled", "rejected", "superseded",
]);

export const taskGraphPlanStepViewSchema = z.object({
  key: stepKeySchema,
  nodeId: idSchema.nullable(),
  title: z.string().min(1),
  objective: z.string().min(1),
  acceptanceCriteria: z.array(z.string()),
  dependsOn: z.array(stepKeySchema),
  contextSelectors: z.array(z.string()),
  executorClass: z.enum(["mechanical", "standard", "reasoning"]),
  risk: z.enum(["low", "medium", "high"]),
  requiresApproval: z.boolean(),
});

export const taskGraphPlanReviewRequirementSchema = z.object({
  gateId: idSchema,
  name: z.string().min(1),
  reason: z.string().min(1),
});

export const taskGraphPlanSnapshotViewSchema = z.object({
  proposalId: idSchema,
  workItemId: idSchema,
  primaryRunKey: idSchema,
  /** Monotonic projection revision; advances for state changes as well as successor plans. */
  revision: revisionSchema,
  proposalRevision: revisionSchema,
  baseProposalRevision: revisionSchema.nullable(),
  state: taskGraphPlanStateSchema,
  mode: leaderOrchestrationModeSchema.exclude(["direct"]),
  objective: z.string().min(1),
  acceptanceCriteria: z.array(z.string()),
  assumptions: z.array(z.string()),
  questions: z.array(z.string()),
  workPacketId: idSchema.nullable(),
  steps: z.array(taskGraphPlanStepViewSchema).max(1_000),
  materializedRevisionId: idSchema.nullable(),
  graphRunId: idSchema.nullable(),
  sourceSnapshotId: idSchema.nullable(),
  autoStartEligible: z.boolean(),
  canStart: z.boolean(),
  reviewRequirements: z.array(taskGraphPlanReviewRequirementSchema).default([]),
  error: z.string().nullable(),
  updatedAt: z.number().int().nonnegative(),
});

export const taskGraphPlanHistoryEntrySchema = z.object({
  proposalId: idSchema,
  proposalRevision: revisionSchema,
  baseProposalRevision: revisionSchema.nullable(),
  state: taskGraphPlanStateSchema,
  objective: z.string().min(1),
  materializedRevisionId: idSchema.nullable(),
  graphRunId: idSchema.nullable(),
  updatedAt: z.number().int().nonnegative(),
});

const planEnvelopeBase = wsEnvelopeSchema.extend({
  workItemId: idSchema,
  revision: revisionSchema,
  timestamp: z.number().int().nonnegative(),
});
export const taskGraphPlanSnapshotEnvelopeSchema = planEnvelopeBase.extend({
  type: z.literal("task_graph_plan_snapshot"),
  snapshot: taskGraphPlanSnapshotViewSchema.nullable(),
}).superRefine((value, ctx) => {
  if (value.topic !== `work-item:${value.workItemId}`) ctx.addIssue({
    code: "custom", message: "task graph plan snapshot topic does not match WorkItem",
  });
  if (value.snapshot && (value.snapshot.workItemId !== value.workItemId
    || value.snapshot.revision !== value.revision)) ctx.addIssue({
    code: "custom", message: "task graph plan snapshot identity mismatch",
  });
});
export const taskGraphPlanChangedEnvelopeSchema = planEnvelopeBase.extend({
  type: z.literal("task_graph_plan_changed"),
  cause: z.string().min(1),
  snapshot: taskGraphPlanSnapshotViewSchema,
}).superRefine((value, ctx) => {
  if (value.topic !== `work-item:${value.workItemId}`
    || value.snapshot.workItemId !== value.workItemId
    || value.snapshot.revision !== value.revision) ctx.addIssue({
      code: "custom", message: "task graph plan change identity mismatch",
    });
});

const planCommandBase = { requestId: idSchema, workItemId: idSchema };
export const taskGraphPlanControlCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("get_task_graph_plan"), ...planCommandBase }),
  z.object({ type: z.literal("approve_task_graph_plan"), ...planCommandBase,
    proposalId: idSchema, expectedProposalRevision: revisionSchema }),
  z.object({ type: z.literal("reject_task_graph_plan"), ...planCommandBase,
    proposalId: idSchema, expectedProposalRevision: revisionSchema }),
]);

export type LeaderOrchestrationMode = z.infer<typeof leaderOrchestrationModeSchema>;
export type SemanticTaskGraphPlan = z.infer<typeof semanticTaskGraphPlanSchema>;
export type TaskGraphPlanReviewRequirement = z.infer<
  typeof taskGraphPlanReviewRequirementSchema
>;
export type TaskGraphPlanSnapshotView = z.infer<typeof taskGraphPlanSnapshotViewSchema>;
export type TaskGraphPlanHistoryEntry = z.infer<typeof taskGraphPlanHistoryEntrySchema>;
export type TaskGraphPlanState = z.infer<typeof taskGraphPlanStateSchema>;
export type TaskGraphPlanControlCommand = z.infer<typeof taskGraphPlanControlCommandSchema>;
export type TaskGraphPlanEnvelope = z.infer<typeof taskGraphPlanSnapshotEnvelopeSchema>
  | z.infer<typeof taskGraphPlanChangedEnvelopeSchema>;
