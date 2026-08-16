import { z } from "zod/v4";
import { wsEnvelopeSchema } from "./ws-envelope.ts";

const idSchema = z.string().min(1);
const revisionSchema = z.number().int().nonnegative();
const optionalTextSchema = z.string().min(1).optional();

export const graphRunStatusViewSchema = z.enum([
  "draft", "running", "quiescent", "paused", "blocked", "completed", "failed", "cancelled",
]);
export const logicalStateViewSchema = z.enum([
  "pending", "succeeded", "failed", "exhausted", "cancelled", "invalidated",
]);
export const readinessStateViewSchema = z.enum(["not_ready", "ready", "claimed", "terminal"]);
export const attemptStateViewSchema = z.enum([
  "queued", "running", "backoff", "blocked", "succeeded", "failed", "cancelled", "superseded",
]);
export const verificationStateViewSchema = z.enum([
  "not_required", "pending", "passed", "failed", "waived", "stale",
]);
export const blockerCategoryViewSchema = z.enum([
  "dependency", "capacity", "input", "budget", "backoff", "verification", "policy", "none",
]);

export const taskAttemptViewSchema = z.object({
  id: idSchema,
  number: z.number().int().positive(),
  state: attemptStateViewSchema,
  executor: optionalTextSchema,
  sessionId: optionalTextSchema,
  startedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
  costUsd: z.number().nonnegative(),
  tokens: z.number().int().nonnegative(),
  summary: optionalTextSchema,
});

export const taskGraphNodeViewSchema = z.object({
  id: idSchema,
  title: idSchema,
  kind: z.enum(["task", "stage", "map", "reducer", "terminal"]),
  stageId: optionalTextSchema,
  groupId: optionalTextSchema,
  logicalState: logicalStateViewSchema,
  readiness: readinessStateViewSchema,
  currentAttempt: taskAttemptViewSchema.nullable(),
  attemptHistory: z.array(taskAttemptViewSchema),
  verification: z.object({
    state: verificationStateViewSchema,
    verifierAttemptId: optionalTextSchema,
    evidenceIds: z.array(idSchema),
    explanation: optionalTextSchema,
  }),
  blocker: z.object({ category: blockerCategoryViewSchema, explanation: optionalTextSchema }).nullable(),
  priority: z.number(),
  queueAgeMs: z.number().nonnegative().optional(),
  backoffUntil: z.iso.datetime().optional(),
  estimatedDurationMs: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative(),
  tokens: z.number().int().nonnegative(),
  criticalPath: z.boolean(),
  stale: z.boolean(),
  inputIds: z.array(idSchema),
  outputArtifactIds: z.array(idSchema),
  owner: optionalTextSchema,
  budgetReservedUsd: z.number().nonnegative().optional(),
  logs: z.array(z.string()).optional(),
});

export const taskGraphSnapshotViewSchema = z.object({
  graphRunId: idSchema,
  revision: revisionSchema,
  title: idSchema,
  status: graphRunStatusViewSchema,
  updatedAt: z.iso.datetime(),
  nodes: z.array(taskGraphNodeViewSchema).max(1_000),
  edges: z.array(z.object({
    id: idSchema, source: idSchema, target: idSchema,
    type: z.enum(["depends_on", "data", "verification", "expansion"]),
    state: z.enum(["ordinary", "selected", "critical", "failure"]),
  })).max(20_000),
  groups: z.array(z.object({
    id: idSchema, title: idSchema, kind: z.enum(["stage", "expansion", "subtree"]),
    nodeIds: z.array(idSchema), costUsd: z.number().nonnegative(), collapsed: z.boolean().optional(),
  })),
  evidence: z.array(z.object({
    id: idSchema, sourceSnapshot: idSchema, producerAttemptId: idSchema,
    artifactId: idSchema, verifierAttemptId: optionalTextSchema,
    consumerNodeIds: z.array(idSchema), status: verificationStateViewSchema,
  })),
  timeline: z.array(z.object({
    id: idSchema, at: z.iso.datetime(),
    type: z.enum(["claim", "dispatch", "progress", "retry", "steering", "invalidation", "waiver", "recovery"]),
    summary: idSchema, nodeId: optionalTextSchema, attemptId: optionalTextSchema,
  })),
  capacity: z.object({ running: z.number().int().nonnegative(), limit: z.number().int().positive() }),
  budget: z.object({
    spentUsd: z.number().nonnegative(), limitUsd: z.number().nonnegative().nullable(),
    tokens: z.number().int().nonnegative(),
  }),
  criticalPath: z.object({
    nodeIds: z.array(idSchema), observedMs: z.number().nonnegative(),
    estimatedRemainingMs: z.number().nonnegative(),
  }),
});

/** Safe metadata projection; immutable artifact bytes and server paths are never returned. */
export const taskGraphArtifactViewSchema=z.object({
  id:idSchema,graphRunId:idSchema,nodeId:idSchema,producerAttemptId:idSchema,
  sourceSnapshotId:idSchema,outputName:idSchema,contentHash:z.string().regex(/^sha256:[a-f0-9]{64}$/),
  schemaName:idSchema,schemaVersion:idSchema,byteSize:z.number().int().nonnegative(),
  classification:z.enum(["public","internal","sensitive","secret"]),retentionPolicy:idSchema,
  state:z.enum(["staged","committed","rejected"]),createdAt:z.iso.datetime(),
  committedAt:z.iso.datetime().nullable(),
});

const taskGraphEnvelopeBaseSchema = wsEnvelopeSchema.extend({
  workItemId: idSchema,
  timestamp: z.number().int().nonnegative(),
});

export const taskGraphSnapshotEnvelopeSchema = taskGraphEnvelopeBaseSchema.extend({
  type: z.literal("task_graph_snapshot"),
  runId: idSchema,
  revision: revisionSchema,
  cause: z.string().min(1),
  snapshot: taskGraphSnapshotViewSchema,
}).refine((value) => value.topic === `work-item:${value.workItemId}`, {
  message: "task graph snapshot topic does not match work item identity",
}).refine((value) => value.runId === value.snapshot.graphRunId
  && value.revision === value.snapshot.revision, {
  message: "task graph snapshot envelope revision does not match snapshot",
});

export const taskGraphChangedEnvelopeSchema = taskGraphEnvelopeBaseSchema.extend({
  type: z.literal("task_graph_changed"),
  runId: idSchema,
  revision: revisionSchema,
  cause: z.string().min(1),
  changes: z.object({
    status: graphRunStatusViewSchema,
    updatedAt: z.iso.datetime(),
    nodes: z.array(taskGraphNodeViewSchema).max(1_000),
    edges: taskGraphSnapshotViewSchema.shape.edges,
    evidence: taskGraphSnapshotViewSchema.shape.evidence,
    timeline: taskGraphSnapshotViewSchema.shape.timeline,
    capacity: taskGraphSnapshotViewSchema.shape.capacity,
    budget: taskGraphSnapshotViewSchema.shape.budget,
    criticalPath: taskGraphSnapshotViewSchema.shape.criticalPath,
  }),
}).refine((value) => value.topic === `work-item:${value.workItemId}`, {
  message: "task graph change topic does not match work item identity",
});

const taskGraphResponseBaseSchema=wsEnvelopeSchema.extend({
  type:z.literal("task_graph_response"),command:idSchema,requestId:idSchema.nullable(),
});
export const taskGraphResponseEnvelopeSchema=z.discriminatedUnion("success",[
  taskGraphResponseBaseSchema.extend({success:z.literal(true),result:z.unknown()}),
  taskGraphResponseBaseSchema.extend({success:z.literal(false),
    code:z.enum(["conflict","validation_failed","unavailable","internal"]),
    error:idSchema,latest:z.record(z.string(),z.unknown()).nullable(),correlationId:idSchema.optional(),
  }),
]);

export const getTaskGraphViewSnapshotCommandSchema = z.object({
  type: z.literal("get_task_graph_snapshot"),
  requestId: idSchema,
  workItemId: idSchema,
  runId: idSchema.optional(),
  primaryRunKey: idSchema.optional(),
}).refine(value=>!(value.runId && value.primaryRunKey),{
  message:"runId and primaryRunKey are mutually exclusive",
});

const graphControlFenceSchema = z.object({
  requestId: idSchema,
  workItemId: idSchema,
  runId: idSchema,
  expectedRunRevision: revisionSchema,
});
const nodeControlFenceSchema = graphControlFenceSchema.extend({
  nodeId: idSchema,
  currentAttemptId: idSchema.nullable(),
});

export const taskGraphViewControlCommandSchema = z.discriminatedUnion("type", [
  graphControlFenceSchema.extend({ type: z.literal("pause_task_graph_run") }),
  graphControlFenceSchema.extend({ type: z.literal("resume_task_graph_run") }),
  graphControlFenceSchema.extend({ type: z.literal("cancel_task_graph_run") }),
  nodeControlFenceSchema.extend({ type: z.literal("retry_task_node") }),
  nodeControlFenceSchema.extend({ type: z.literal("cancel_task_attempt"), currentAttemptId: idSchema }),
  nodeControlFenceSchema.extend({ type: z.literal("request_task_verification") }),
  nodeControlFenceSchema.extend({ type: z.literal("waive_task_verification"),actor:idSchema,reason:idSchema }),
  nodeControlFenceSchema.extend({ type: z.literal("provide_task_input"),actor:idSchema,input: z.string().trim().min(1) }),
]).superRefine((value,ctx)=>{
  if ((value.type==="retry_task_node" || value.type==="request_task_verification"
    || value.type==="waive_task_verification") && value.currentAttemptId===null) {
    ctx.addIssue({code:"custom",path:["currentAttemptId"],message:"current attempt identity is required"});
  }
});

export type GraphRunStatus = z.infer<typeof graphRunStatusViewSchema>;
export type LogicalState = z.infer<typeof logicalStateViewSchema>;
export type ReadinessState = z.infer<typeof readinessStateViewSchema>;
export type AttemptState = z.infer<typeof attemptStateViewSchema>;
export type VerificationState = z.infer<typeof verificationStateViewSchema>;
export type BlockerCategory = z.infer<typeof blockerCategoryViewSchema>;
export type TaskAttemptView = z.infer<typeof taskAttemptViewSchema>;
export type TaskGraphNodeView = z.infer<typeof taskGraphNodeViewSchema>;
export type TaskGraphSnapshotView = z.infer<typeof taskGraphSnapshotViewSchema>;
export type TaskGraphArtifactView = z.infer<typeof taskGraphArtifactViewSchema>;
export type TaskGraphSnapshotEnvelope = z.infer<typeof taskGraphSnapshotEnvelopeSchema>;
export type TaskGraphChangedEnvelope = z.infer<typeof taskGraphChangedEnvelopeSchema>;
export type TaskGraphResponseEnvelope = z.infer<typeof taskGraphResponseEnvelopeSchema>;
export type TaskGraphViewEnvelope = TaskGraphSnapshotEnvelope | TaskGraphChangedEnvelope;
export type GetTaskGraphViewSnapshotCommand = z.infer<typeof getTaskGraphViewSnapshotCommandSchema>;
export type TaskGraphViewControlCommand = z.infer<typeof taskGraphViewControlCommandSchema>;
