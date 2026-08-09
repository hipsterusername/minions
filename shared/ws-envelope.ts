/**
 * WebSocket envelope — the typed wrapper every server → client message
 * flows through.
 *
 * The envelope adds a `topic` field that clients can subscribe to. Listeners
 * that switch on `type` alone keep working because `type` and
 * all payload fields are preserved at the top level — this is an additive
 * wrapper, not a nested one.
 *
 * ```jsonc
 * // Unscoped payload:
 * { "type": "task_plan_update", "leaderSessionKey": "leader-abc", "tasks": [...] }
 *
 * // Envelope (`topic` added, rest unchanged):
 * { "topic": "session:leader-abc", "type": "task_plan_update",
 *   "leaderSessionKey": "leader-abc", "tasks": [...] }
 * ```
 *
 * Topic grammar:
 *   - `session:<sessionKey>` — events scoped to a single session
 *   - `project:<projectId>`  — events scoped to a project (multi-session)
 *   - `global`               — events every client should see
 *
 * Adding a new topic shape means editing this file (and the client
 * subscribe matcher). Keep the grammar small on purpose.
 */

import { z } from "zod/v4";
import { normalizedEventSchema } from "./normalized-event.ts";
import {
  workItemBindingSnapshotSchema,
  workItemDetailSnapshotSchema,
  workItemListSnapshotSchema,
  workItemRunListSnapshotSchema,
  workItemServiceErrorCodeSchema,
  workItemRunSnapshotSchema,
  workItemSnapshotSchema,
} from "./work-item-contracts.ts";
import { worktreeIntegrationErrorCodeSchema, worktreeLineageSnapshotSchema } from "./worktree-integration.ts";
export { liveEditCoordinationEnvelopeSchema } from "./live-edit-coordination.ts";

// ── Topic ──────────────────────────────────────────────

export const sessionTopicSchema = z
  .string()
  .regex(/^session:.+$/, "session topics are `session:<sessionKey>`");

export const projectTopicSchema = z
  .string()
  .regex(/^project:.+$/, "project topics are `project:<projectId>`");

export const workItemTopicSchema = z
  .string()
  .regex(/^work-item:.+$/, "work-item topics are `work-item:<workItemId>`");
export const lineageTopicSchema = z.string().regex(/^lineage:.+$/,
  "lineage topics are `lineage:<lineageId>`");

export const globalTopicSchema = z.literal("global");

/**
 * Union of valid topics. We use a plain string union validated by regex
 * rather than template-literal types so the matchers are easy to swap
 * out for a different scheme later.
 */
export const topicSchema = z.union([
  sessionTopicSchema,
  projectTopicSchema,
  workItemTopicSchema,
  lineageTopicSchema,
  globalTopicSchema,
]);

export type Topic = z.infer<typeof topicSchema>;

// ── Envelope ───────────────────────────────────────────

/**
 * The envelope is intentionally additive: it asserts the presence of a
 * `topic` field and a `type` discriminator, but passes the rest of the
 * payload through unchanged.
 *
 * Every existing server broadcast must parse against this schema once the
 * bus wraps it; the contract test in `tests/contracts/ws-envelope.test.ts`
 * locks that in.
 */
export const wsEnvelopeSchema = z.looseObject({
  topic: topicSchema,
  type: z.string(),
});

/**
 * SessionHost's normalized-event wire envelope. `runKey` and `workItemId`
 * are optional at parse time so persisted payloads without them stay valid;
 * current SessionHost producers always include both (`workItemId` may be
 * null until durable work-item allocation lands).
 */
export const normalizedEventEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("sdk_event"),
  sessionKey: z.string().min(1),
  runKey: z.string().min(1).optional(),
  workItemId: z.string().min(1).nullable().optional(),
  event: normalizedEventSchema,
  timestamp: z.number().optional(),
});

export type NormalizedEventEnvelope = z.infer<
  typeof normalizedEventEnvelopeSchema
>;

export type WsEnvelope = z.infer<typeof wsEnvelopeSchema>;

export const sessionCompactedEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("session_compacted"),
  sessionKey: z.string(),
  oldSessionId: z.string().nullable(),
  newSessionId: z.string().nullable(),
  checkpointId: z.string().optional(),
  trigger: z.enum(["proactive", "context_recovery"]).optional(),
  contextTokensBefore: z.number().optional(),
  contextWindowTokens: z.number().optional(),
  ratioBefore: z.number().optional(),
  timestamp: z.number(),
});

export const sessionReviewLifecycleSchema = z.object({
  reviewState: z.enum(["none", "decision_needed", "completion_to_review", "error_to_review", "interrupted_to_review"]),
  reviewReason: z.string().nullable(),
  finalReport: z.string().nullable(),
  finalDashboardRevision: z.number().int().nonnegative().nullable(),
  dashboardRevision: z.number().int().nonnegative(),
  terminalReason: z.enum(["completed", "error", "stop", "abort"]).nullable(),
  terminalAt: z.number().nullable(),
  acknowledgedAt: z.number().nullable(),
  dismissedAt: z.number().nullable(),
  lifecycleRevision: z.number().int().nonnegative(),
});

export const sessionLifecycleChangedEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("session_lifecycle_changed"),
  sessionKey: z.string().min(1),
  lifecycle: sessionReviewLifecycleSchema,
  timestamp: z.number(),
});

function matchesWorkItemTopic(topic: string, workItemId: string): boolean {
  return !topic.startsWith("work-item:") || topic === `work-item:${workItemId}`;
}

function matchesItemDiscoveryTopic(
  topic: string,
  workItem: { id: string; projectId: string },
): boolean {
  return topic === `work-item:${workItem.id}` || topic === `project:${workItem.projectId}`;
}

export const workItemChangedEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("work_item_changed"),
  workItem: workItemSnapshotSchema,
  revision: z.number().int().nonnegative(),
  cause: z.string().min(1),
  timestamp: z.number().int().nonnegative(),
}).superRefine((envelope, ctx) => {
  if (!matchesItemDiscoveryTopic(envelope.topic, envelope.workItem)) {
    ctx.addIssue({ code: "custom", message: "topic does not match work item identity" });
  }
  if (envelope.revision !== envelope.workItem.lifecycle.lifecycleRevision) {
    ctx.addIssue({ code: "custom", message: "revision does not match work item lifecycle" });
  }
});

export const workItemCreatedEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("work_item_created"),
  workItem: workItemSnapshotSchema,
  timestamp: z.number().int().nonnegative(),
}).refine(
  (envelope) => matchesItemDiscoveryTopic(envelope.topic, envelope.workItem),
  { message: "topic does not match work item identity" },
);

export const workItemRunCreatedEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("work_item_run_created"),
  workItemId: z.string().min(1),
  run: workItemRunSnapshotSchema,
  timestamp: z.number().int().nonnegative(),
}).superRefine((envelope, ctx) => {
  if (envelope.workItemId !== envelope.run.workItemId
    || !matchesWorkItemTopic(envelope.topic, envelope.workItemId)) {
    ctx.addIssue({ code: "custom", message: "run event identity mismatch" });
  }
  if (envelope.run.endedAt !== null || envelope.run.outcome !== "none") {
    ctx.addIssue({ code: "custom", message: "created run must be open" });
  }
});

export const workItemRunSealedEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("work_item_run_sealed"),
  workItemId: z.string().min(1),
  run: workItemRunSnapshotSchema,
  timestamp: z.number().int().nonnegative(),
}).superRefine((envelope, ctx) => {
  if (envelope.workItemId !== envelope.run.workItemId
    || !matchesWorkItemTopic(envelope.topic, envelope.workItemId)) {
    ctx.addIssue({ code: "custom", message: "run event identity mismatch" });
  }
  if (envelope.run.endedAt === null || envelope.run.outcome === "none") {
    ctx.addIssue({ code: "custom", message: "sealed run must be terminal" });
  }
});

export const workItemBindingChangedEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("work_item_binding_changed"),
  workItemId: z.string().min(1),
  binding: workItemBindingSnapshotSchema,
  timestamp: z.number().int().nonnegative(),
}).refine(
  (envelope) => envelope.workItemId === envelope.binding.workItemId
    && matchesWorkItemTopic(envelope.topic, envelope.workItemId),
  { message: "binding event identity mismatch" },
);

const workItemResponseBaseSchema = wsEnvelopeSchema.extend({
  type: z.literal("work_item_response"),
  command: z.string().min(1),
  requestId: z.string().min(1).nullable(),
});

export const workItemResponseEnvelopeSchema = z.discriminatedUnion("success", [
  workItemResponseBaseSchema.extend({
  success: z.literal(true),
  result: z.union([
    workItemDetailSnapshotSchema,
    workItemListSnapshotSchema,
    workItemRunListSnapshotSchema,
    z.null(),
  ]),
  error: z.never().optional(),
  code: z.never().optional(),
  latest: z.never().optional(),
  }),
  workItemResponseBaseSchema.extend({
    success: z.literal(false),
    error: z.string().min(1),
    code: workItemServiceErrorCodeSchema,
    latest: workItemDetailSnapshotSchema.nullable(),
    correlationId: z.string().min(1).optional(),
    result: z.never().optional(),
  }),
]);

const worktreeIntegrationResponseBaseSchema = wsEnvelopeSchema.extend({
  type: z.literal("worktree_integration_response"), command: z.string().min(1),
  requestId: z.string().min(1).nullable(),
});
export const worktreeIntegrationResponseEnvelopeSchema = z.discriminatedUnion("success", [
  worktreeIntegrationResponseBaseSchema.extend({ success: z.literal(true),
    result: worktreeLineageSnapshotSchema.nullable() }),
  worktreeIntegrationResponseBaseSchema.extend({ success: z.literal(false),
    code: worktreeIntegrationErrorCodeSchema, error: z.string().min(1),
    latest: worktreeLineageSnapshotSchema.nullable().optional() }),
]);
export const worktreeIntegrationChangedEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("worktree_integration_changed"), operation: z.string().min(1),
  workItemId: z.string().min(1).nullable(), lineage: worktreeLineageSnapshotSchema,
  timestamp: z.number().int().nonnegative(),
}).refine((value) => value.topic === `lineage:${value.lineage.id}`
  || value.topic === `project:${value.lineage.projectId}`
  || (value.workItemId !== null && value.topic === `work-item:${value.workItemId}`),
  "integration event topic does not match lineage identity");

// ── Helpers ────────────────────────────────────────────

/** Build a session-scoped topic. */
export function sessionTopic(sessionKey: string): Topic {
  if (!sessionKey) throw new Error("sessionTopic: sessionKey is required");
  return `session:${sessionKey}`;
}

/** Build a project-scoped topic. */
export function projectTopic(projectId: string): Topic {
  if (!projectId) throw new Error("projectTopic: projectId is required");
  return `project:${projectId}`;
}

/** Build a durable work-item-scoped topic. */
export function workItemTopic(workItemId: string): Topic {
  if (!workItemId) throw new Error("workItemTopic: workItemId is required");
  return `work-item:${workItemId}`;
}

export function lineageTopic(lineageId: string): Topic {
  if (!lineageId) throw new Error("lineageTopic: lineageId is required");
  return `lineage:${lineageId}`;
}

/** The global topic constant. */
export const GLOBAL_TOPIC: Topic = "global";

/**
 * Extract the key from a `session:<key>` topic. Returns null for other
 * topic kinds.
 */
export function sessionKeyFromTopic(topic: string): string | null {
  if (!topic.startsWith("session:")) return null;
  return topic.slice("session:".length);
}

/**
 * Decide whether an envelope matches a subscription topic filter.
 *
 * Matching rules:
 *   - `"global"` subscription receives only global-topic envelopes.
 *   - `"session:<key>"` or `"project:<id>"` subscription receives only
 *     that exact topic.
 *   - The sentinel `"*"` filter receives *every* envelope for consumers that
 *     intentionally subscribe without topic filtering.
 */
export function topicMatches(filter: string, envelopeTopic: string): boolean {
  if (filter === "*") return true;
  return filter === envelopeTopic;
}
