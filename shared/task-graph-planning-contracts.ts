import { z } from "zod/v4";
import {
  budgetRequestSchema,
  dialecticNodeMetadataSchema,
  jsonRecordSchema,
  ownershipRequestSchema,
  retryPolicySchema,
  taskNodeSessionAffinitySchema,
} from "./task-graph-contracts.ts";
import {
  taskGraphIterationSchema,
  taskGraphPatternProvenanceSchema,
  taskGraphPatternRecommendationSchema,
  taskGraphPatternTemplateViewSchema,
  taskGraphProblemSignatureSchema,
} from "./task-graph-patterns.ts";
import { wsEnvelopeSchema } from "./ws-envelope.ts";

const idSchema = z.string().min(1);
const revisionSchema = z.number().int().nonnegative();
const stepKeySchema = z.string().trim().min(1).max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const leaderOrchestrationModeSchema = z.enum(["auto", "plan", "direct"]);

export const semanticGraphDependencySchema = z.object({
  stepKey: stepKeySchema,
  kind: z.enum(["control", "artifact", "verified_artifact", "human_gate"]).default("control")
    .describe("Use control for ordering only. Artifact kinds require a declared producer output and consumer input."),
  sourceOutput: z.string().min(1).nullable().default(null)
    .describe("Producer outputSchemas key for an artifact dependency; null for control dependencies."),
  targetInput: z.string().min(1).nullable().default(null)
    .describe("Consumer inputBindings key for an artifact dependency; null for control dependencies."),
  satisfactionPolicy: z.enum(["all_success", "all_terminal", "any_success", "quorum"])
    .default("all_success")
    .describe("Join behavior for all non-optional dependencies entering the consumer. For partial synthesis, use quorum artifact edges, or pair required all_terminal control edges with optional artifact edges so missing artifacts do not block the join."),
  quorum: z.number().int().positive().optional()
    .describe("Required distinct successful upstream steps when satisfactionPolicy is quorum."),
  optional: z.boolean().default(false),
  failurePolicy: z.enum(["block", "skip", "fail"]).default("block")
    .describe("Use skip on required all_terminal control edges when a consumer may synthesize surviving optional artifacts with explicit coverage warnings."),
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
  inputBindings: jsonRecordSchema.default({})
    .describe("Named artifact inputs accepted by this step. Every incoming artifact targetInput must name one of these keys."),
  outputSchemas: jsonRecordSchema.default({})
    .describe("Named artifacts produced by this step. Every outgoing artifact sourceOutput must name one of these keys."),
  executorClass: z.enum(["mechanical", "standard", "reasoning"]).default("standard"),
  allowedHarnesses: z.array(idSchema).min(1).optional(),
  model: z.string().trim().min(1).optional()
    .describe("Exact model override. Omit to use executorClass routing for the selected harness."),
  sessionAffinity: taskNodeSessionAffinitySchema.optional()
    .describe("Resume a stable provider thread across a totally ordered sequence of graph nodes."),
  reasoning: dialecticNodeMetadataSchema.optional()
    .describe("Structured reasoning-node metadata used by specialized graph authoring and moderation tools."),
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
  pattern: taskGraphPatternProvenanceSchema.nullable().optional()
    .describe("Optional reviewed authoring pattern. It records provenance but never controls runtime scheduling."),
  problemSignature: taskGraphProblemSignatureSchema.optional()
    .describe("Optional bounded problem classification used to recommend direct execution or a reviewed static pattern."),
  iteration: taskGraphIterationSchema.optional()
    .describe("Optional bounded-episode metadata. Successor revisions identify new evidence and an explicit stop condition."),
  steps: z.array(semanticGraphPlanStepSchema).min(1).max(1_000),
  terminalStepKeys: z.array(stepKeySchema).min(1).optional(),
  maxActiveAttempts: z.number().int().min(1).max(100).default(4),
  budgetLimits: z.object({
    tokenLimit: z.number().int().nonnegative().nullable(),
    costMicrosLimit: z.number().int().nonnegative().nullable(),
  }).optional(),
}).superRefine((plan, ctx) => {
  const keys = new Set<string>();
  const stepsByKey = new Map(plan.steps.map((step) => [step.key, step]));
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
    const artifact = dependency.kind === "artifact" || dependency.kind === "verified_artifact";
    if (artifact && (!dependency.sourceOutput || !dependency.targetInput)) ctx.addIssue({
      code: "custom", path: ["steps", index, "dependsOn", dependencyIndex],
      message: "artifact dependencies require sourceOutput and targetInput",
    });
    if (!artifact && (dependency.sourceOutput || dependency.targetInput)) ctx.addIssue({
      code: "custom", path: ["steps", index, "dependsOn", dependencyIndex],
      message: "control dependencies cannot declare artifact bindings; human-gate dependencies also require null bindings; use an artifact kind for mapped inputs",
    });
    if (dependency.kind === "human_gate"
      && dependency.satisfactionPolicy !== "all_success") ctx.addIssue({
      code: "custom", path: ["steps", index, "dependsOn", dependencyIndex, "satisfactionPolicy"],
      message: "human-gate dependencies use all_success; the recorded input is their satisfaction witness",
    });
    if (dependency.satisfactionPolicy === "quorum" && dependency.quorum == null) ctx.addIssue({
      code: "custom", path: ["steps", index, "dependsOn", dependencyIndex, "quorum"],
      message: "quorum is required when satisfactionPolicy is quorum",
    });
    if (dependency.satisfactionPolicy !== "quorum" && dependency.quorum != null) ctx.addIssue({
      code: "custom", path: ["steps", index, "dependsOn", dependencyIndex, "quorum"],
      message: "quorum is only allowed when satisfactionPolicy is quorum",
    });
    const source = stepsByKey.get(dependency.stepKey);
    if (artifact && source && dependency.sourceOutput
      && !(dependency.sourceOutput in source.outputSchemas)) ctx.addIssue({
      code: "custom", path: ["steps", index, "dependsOn", dependencyIndex, "sourceOutput"],
      message: `sourceOutput "${dependency.sourceOutput}" is not declared in step "${source.key}" outputSchemas`,
    });
    if (artifact && dependency.targetInput
      && !(dependency.targetInput in step.inputBindings)) ctx.addIssue({
      code: "custom", path: ["steps", index, "dependsOn", dependencyIndex, "targetInput"],
      message: `targetInput "${dependency.targetInput}" is not declared in step "${step.key}" inputBindings`,
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
  inputBindings: jsonRecordSchema,
  outputSchemas: jsonRecordSchema,
  outputExamples: jsonRecordSchema,
  executorClass: z.enum(["mechanical", "standard", "reasoning"]),
  allowedHarnesses:z.array(idSchema).min(1).nullable().optional(),
  model:z.string().min(1).nullable().optional(),
  sessionAffinity:taskNodeSessionAffinitySchema.nullable().optional(),
  reasoning:dialecticNodeMetadataSchema.nullable().optional(),
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
  pattern: taskGraphPatternProvenanceSchema.nullable().optional(),
  patternRecommendation: taskGraphPatternRecommendationSchema.optional(),
  patternTemplate: taskGraphPatternTemplateViewSchema.optional(),
  iteration: taskGraphIterationSchema.nullable().optional(),
  steps: z.array(taskGraphPlanStepViewSchema).max(1_000),
  materializedRevisionId: idSchema.nullable(),
  graphRunId: idSchema.nullable(),
  sourceSnapshotId: idSchema.nullable(),
  autoStartEligible: z.boolean(),
  canStart: z.boolean(),
  reviewRequirements: z.array(taskGraphPlanReviewRequirementSchema).default([]),
  topologyWarnings: z.array(z.string().min(1)).default([]),
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
