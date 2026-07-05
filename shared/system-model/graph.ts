import { z } from "zod/v4";
import { riskLevelSchema, systemModelObjectTypeSchema } from "./objects.ts";

export const systemGraphNodeSchema = z.object({
  id: z.string(),
  type: systemModelObjectTypeSchema,
  label: z.string(),
  summary: z.string().optional(),
  risk: riskLevelSchema.optional(),
  freshness: z.enum(["fresh", "stale", "unknown"]).default("unknown"),
});

export const systemGraphEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  relation: z.enum([
    "linked_flow",
    "capability",
    "constraint",
    "decision",
    "risk",
    "evidence",
  ]),
});

export const systemGraphSchema = z.object({
  nodes: z.array(systemGraphNodeSchema),
  edges: z.array(systemGraphEdgeSchema),
});

export type SystemGraphNode = z.infer<typeof systemGraphNodeSchema>;
export type SystemGraphEdge = z.infer<typeof systemGraphEdgeSchema>;
export type SystemGraph = z.infer<typeof systemGraphSchema>;
