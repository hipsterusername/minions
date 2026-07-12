import { z } from "zod/v4";

export const kanbanSubtaskSchema = z.object({
  id: z.string().min(1), title: z.string(), done: z.boolean(),
});

export const kanbanCardMetadataSchema = z.object({
  legacyCardId: z.string().min(1).optional(),
  description: z.string().default(""),
  subtasks: z.array(kanbanSubtaskSchema).default([]),
  context: z.string().default(""),
  priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  model: z.string().default(""), harness: z.string().optional(),
  permissionMode: z.string().default("auto"), worktreeIsolation: z.boolean().default(false),
  skillIds: z.array(z.string()).default([]),
  skillValues: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  linkedContextNodeIds: z.array(z.string()).default([]),
  leaderNodeId: z.string().nullable().optional(), agentSummary: z.string().optional(),
  agentCost: z.number().nonnegative().optional(),
  blockReason: z.enum(["session_lost", "error", "interrupted", "needs_input"]).optional(),
  blockDetail: z.string().optional(), autoSynced: z.boolean().optional(),
  composerState: z.enum(["creating", "error"]).optional(),
  composerSessionKey: z.string().optional(), composerError: z.string().optional(),
});

export const kanbanImportCardSchema = kanbanCardMetadataSchema.extend({
  id: z.string().min(1), title: z.string().min(1), columnId: z.string().min(1),
  rank: z.string().min(1), createdAt: z.number().int().nonnegative(),
  existingWorkItemId: z.string().min(1).optional(),
});

export type KanbanCardMetadata = z.infer<typeof kanbanCardMetadataSchema>;
export type KanbanImportCard = z.infer<typeof kanbanImportCardSchema>;
