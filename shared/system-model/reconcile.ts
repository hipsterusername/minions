import { z } from "zod/v4";

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

export const gateStatusSchema = z.object({
  gateId: z.string(),
  status: z.enum(["not_required", "required_pending", "passed", "failed", "waived"]),
  reason: z.string(),
});

export const reconciliationReportSchema = z.object({
  id: z.string(),
  workPacketId: z.string(),
  createdAt: z.number(),
  affectedObjects: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  testsMissing: z.array(z.string()).default([]),
  outOfScopeFiles: z.array(z.string()).default([]),
  gates: z.array(gateStatusSchema).default([]),
  constraintChecks: z.array(constraintCheckSchema).default([]),
  provenance: z.enum(["deterministic", "minion_judged", "mixed"]).default("deterministic"),
});

export type ConstraintCheck = z.infer<typeof constraintCheckSchema>;
export type GateStatus = z.infer<typeof gateStatusSchema>;
export type ReconciliationReport = z.infer<typeof reconciliationReportSchema>;
