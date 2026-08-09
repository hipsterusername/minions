import { z } from "zod/v4";
import { reviewGateRequirementSchema } from "./packet.ts";

export const constraintCheckSchema = z.object({
  constraintId: z.string(),
  status: z.enum([
    "appears_satisfied",
    "possibly_violated",
    "violated",
    "not_checked",
  ]),
  evidence: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

export const constraintVerdictSchema = constraintCheckSchema.extend({
  provenance: z.literal("minion_judged"),
  reviewedAt: z.number(),
});

export const deterministicReconciliationSchema = z.object({
  provenance: z.literal("deterministic"),
  changedFiles: z.array(z.string()).default([]),
  affectedCapabilities: z.array(z.string()).default([]),
  affectedFlows: z.array(z.string()).default([]),
  affectedEntryPoints: z.array(z.object({
    capabilityId: z.string(),
    surfaceId: z.string(),
  })).default([]),
  siblingSurfaces: z.array(z.object({
    capabilityId: z.string(),
    surfaceIds: z.array(z.string()),
  })).default([]),
  constraintsInScope: z.array(z.string()).default([]),
  testsMissing: z.array(z.string()).default([]),
  outOfScopeFiles: z.array(z.string()).default([]),
  gateRequirements: z.array(reviewGateRequirementSchema).default([]),
  diffSummary: z.string().default("No changed files"),
});

export const reconciliationProvenanceSchema = z.object({
  deterministic: z.literal("deterministic"),
  constraintVerdicts: z.literal("minion_judged").optional(),
});

export const reconciliationReportSchema = z.object({
  id: z.string(),
  workPacketId: z.string(),
  createdAt: z.number(),
  deterministic: deterministicReconciliationSchema,
  constraintVerdicts: z.array(constraintVerdictSchema).default([]),
  provenance: reconciliationProvenanceSchema.default({ deterministic: "deterministic" }),
  agentSummary: z.string().optional(),
  reviewerTaskDescription: z.string().optional(),
  // Compatibility summary fields for compact consumers and gate lookups.
  affectedObjects: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  testsMissing: z.array(z.string()).default([]),
  outOfScopeFiles: z.array(z.string()).default([]),
  gates: z.array(reviewGateRequirementSchema).default([]),
  constraintChecks: z.array(constraintCheckSchema).default([]),
});

export type ConstraintCheck = z.infer<typeof constraintCheckSchema>;
export type ConstraintVerdict = z.infer<typeof constraintVerdictSchema>;
export type DeterministicReconciliation = z.infer<typeof deterministicReconciliationSchema>;
export type ReconciliationReport = z.infer<typeof reconciliationReportSchema>;
