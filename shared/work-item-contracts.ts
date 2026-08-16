import { z } from "zod/v4";
import {
  changeModeSchema,
  outcomeSchema,
  workItemLifecycleSchema,
} from "./work-item-lifecycle.ts";
import { liveEditAwarenessSchema } from "./live-edit-coordination.ts";
import { worktreeLineageSnapshotSchema } from "./worktree-integration.ts";

export const workItemBindingSurfaceSchema = z.literal("canvas");
export const workItemWaitKindSchema = z.enum(["decision", "file_conflict", "other"]);

export const workItemSnapshotSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  projectPath: z.string().min(1),
  title: z.string().min(1),
  lifecycle: workItemLifecycleSchema,
  waitKind: workItemWaitKindSchema.nullable(),
  currentRunKey: z.string().min(1).nullable(),
  iteration: z.number().int().nonnegative(),
  lastTransitionAt: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const workItemRunSnapshotSchema = z.object({
  runKey: z.string().min(1),
  workItemId: z.string().min(1),
  runKind: z.enum(["primary", "child"]),
  parentRunKey: z.string().min(1).nullable(),
  taskId: z.string().min(1).nullable(),
  // Optional only for wire compatibility with snapshots persisted before
  // first-class child attempts; all current producers emit explicit nulls or values.
  attemptId: z.string().min(1).nullable().optional(),
  attemptNumber: z.number().int().positive().nullable().optional(),
  runNumber: z.number().int().positive().nullable(),
  previousRunKey: z.string().min(1).nullable(),
  providerSessionId: z.string().min(1).nullable(),
  outcome: outcomeSchema,
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().nullable(),
  finalReport: z.string().min(1).nullable(),
}).superRefine((run, ctx) => {
  if (run.runKind === "primary") {
    if (run.runNumber === null) ctx.addIssue({ code: "custom", message: "primary runs require runNumber" });
    if (run.parentRunKey !== null || run.taskId !== null
      || run.attemptId != null || run.attemptNumber != null) {
      ctx.addIssue({ code: "custom", message: "primary runs cannot have child attempt identity" });
    }
  } else {
    if (run.runNumber !== null) ctx.addIssue({ code: "custom", message: "child runs cannot have runNumber" });
    if (run.parentRunKey === null || run.taskId === null
      || run.attemptId == null || run.attemptNumber == null) {
      ctx.addIssue({ code: "custom", message: "child runs require parent, task, and attempt identity" });
    }
    if (run.previousRunKey !== null) ctx.addIssue({ code: "custom", message: "child runs cannot have previousRunKey" });
  }
  if (run.outcome === "none") {
    if (run.endedAt !== null || run.finalReport !== null) {
      ctx.addIssue({ code: "custom", message: "open runs cannot have terminal fields" });
    }
  } else {
    if (run.endedAt === null) ctx.addIssue({ code: "custom", message: "terminal runs require endedAt" });
  }
  if (run.endedAt !== null && run.endedAt < run.startedAt) {
    ctx.addIssue({ code: "custom", message: "endedAt cannot precede startedAt" });
  }
});

export const workItemBindingSnapshotSchema = z.object({
  workItemId: z.string().min(1),
  surface: workItemBindingSurfaceSchema,
  bindingId: z.string().min(1),
  attachedAt: z.number().int().nonnegative(),
  detachedAt: z.number().int().nonnegative().nullable(),
});

export const workItemDetailSnapshotSchema = z.object({
  workItem: workItemSnapshotSchema,
  bindings: z.array(workItemBindingSnapshotSchema),
  currentRun: workItemRunSnapshotSchema.nullable(),
  runs: z.array(workItemRunSnapshotSchema),
  nextCursor: z.string().nullable(),
  integration: worktreeLineageSnapshotSchema.nullable().optional(),
});

export const workItemServiceErrorCodeSchema = z.enum([
  "not_found", "conflict", "invalid_transition",
  "idempotency_mismatch", "validation_failed", "internal", "unavailable",
]);

export const workItemServiceErrorSchema = z.object({
  code: workItemServiceErrorCodeSchema,
  message: z.string().min(1),
  latest: workItemDetailSnapshotSchema.nullable(),
});

export const workItemListSnapshotSchema = z.object({
  projectId: z.string().min(1),
  items: z.array(workItemSnapshotSchema),
  nextCursor: z.string().nullable(),
  coordination: z.record(z.string(), liveEditAwarenessSchema).optional(),
});

export const workItemRunListSnapshotSchema = z.object({
  workItemId: z.string().min(1),
  runs: z.array(workItemRunSnapshotSchema),
  nextCursor: z.string().nullable(),
});

export const createWorkItemInputSchema = z.object({
  projectId: z.string().min(1),
  projectPath: z.string().min(1),
  title: z.string().min(1),
  changeMode: changeModeSchema,
});

export type WorkItemSnapshot = z.infer<typeof workItemSnapshotSchema>;
export type WorkItemRunSnapshot = z.infer<typeof workItemRunSnapshotSchema>;
export type WorkItemBindingSnapshot = z.infer<typeof workItemBindingSnapshotSchema>;
export type WorkItemDetailSnapshot = z.infer<typeof workItemDetailSnapshotSchema>;
export type WorkItemListSnapshot = z.infer<typeof workItemListSnapshotSchema>;
export type WorkItemRunListSnapshot = z.infer<typeof workItemRunListSnapshotSchema>;
export type WorkItemBindingSurface = z.infer<typeof workItemBindingSurfaceSchema>;
export type WorkItemWaitKind = z.infer<typeof workItemWaitKindSchema>;
export type WorkItemServiceErrorCode = z.infer<typeof workItemServiceErrorCodeSchema>;
export type WorkItemServiceErrorShape = z.infer<typeof workItemServiceErrorSchema>;
