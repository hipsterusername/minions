import { z } from "zod/v4";
import { riskLevelSchema } from "./objects.ts";

export const requiredVerificationSchema = z.object({
  kind: z.enum(["freshness", "test", "manual_review", "constraint"]),
  target: z.string(),
  reason: z.string(),
  status: z.enum(["passed", "failed", "not_run", "unknown"]).default("unknown"),
});

export const reviewGateRequirementSchema = z.object({
  gateId: z.string(),
  name: z.string(),
  status: z.enum(["not_required", "required_pending", "passed", "failed", "waived"]),
  reason: z.string(),
  waivedAt: z.number().optional(),
});

export const workPacketStatusSchema = z.enum([
  "draft",
  "active",
  "amended",
  "reconciled",
  "closed",
  "waived",
]);

export const workPacketEvidenceProvenanceSchema = z.enum([
  "leader_observed",
  "deterministic",
  "minion_reported",
  "human",
]);

export const workPacketEvidenceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "observation",
    "claim",
    "decision",
    "gap",
    "contradiction",
    "model_update",
  ]),
  summary: z.string().min(1),
  criterionIds: z.array(z.string()).default([]),
  objectIds: z.array(z.string()).default([]),
  evidenceRefs: z.array(z.string()).default([]),
  provenance: workPacketEvidenceProvenanceSchema,
  createdAt: z.number(),
});

export const criterionCoverageSchema = z.object({
  criterionId: z.string().min(1),
  criterion: z.string().min(1),
  status: z.enum([
    "open",
    "in_progress",
    "supported",
    "verified",
    "blocked",
    "waived",
  ]),
  objectIds: z.array(z.string()).default([]),
  evidenceRefs: z.array(z.string()).default([]),
  notes: z.string().optional(),
  provenance: workPacketEvidenceProvenanceSchema,
  updatedAt: z.number(),
});

export const workPacketSignalSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    "coverage_gap",
    "contradiction",
    "freshness",
    "review",
    "model_update",
    "open_question",
  ]),
  priority: riskLevelSchema,
  status: z.enum(["open", "addressed", "waived"]),
  summary: z.string().min(1),
  criterionIds: z.array(z.string()).default([]),
  objectIds: z.array(z.string()).default([]),
  evidenceRefs: z.array(z.string()).default([]),
  resolution: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const workPacketSchema = z.object({
  id: z.string(),
  leaderSessionKey: z.string(),
  createdAt: z.number(),
  userRequest: z.string(),
  normalizedGoal: z.string(),
  status: workPacketStatusSchema,
  // Persist inputs separately: derived context must not become selections on amendment.
  selection: z.object({
    objectIds: z.array(z.string()),
    taskFiles: z.array(z.string()),
    ownedPaths: z.array(z.string()),
    entryPoints: z.array(z.object({ capabilityId: z.string(), surfaceId: z.string() })),
  }).optional(),
  scope: z.object({
    capabilities: z.array(z.string()),
    flows: z.array(z.string()),
    constraints: z.array(z.string()),
    decisions: z.array(z.string()),
    risks: z.array(z.string()),
    surfaces: z.array(z.string()).default([]),
    entryPoints: z.array(z.object({
      capabilityId: z.string(),
      surfaceId: z.string(),
      files: z.array(z.string()).default([]),
      tests: z.array(z.string()).default([]),
      flows: z.array(z.string()).default([]),
    })).default([]),
    suggestedFiles: z.array(z.string()),
    suggestedTests: z.array(z.string()),
  }),
  nonGoals: z.array(z.string()),
  agentInstructions: z.array(z.string()),
  freshness: z.object({
    status: z.enum(["fresh", "partially_stale", "stale_blocked", "unknown"]),
    warnings: z.array(z.string()),
    requiredVerifications: z.array(requiredVerificationSchema),
  }),
  reviewGates: z.array(reviewGateRequirementSchema),
  riskLevel: riskLevelSchema,
  matchConfidence: z.enum(["high", "medium", "low"]),
  criterionCoverage: z.array(criterionCoverageSchema).default([]),
  evidenceLedger: z.array(workPacketEvidenceSchema).default([]),
  signals: z.array(workPacketSignalSchema).default([]),
  amendments: z.array(z.object({
    at: z.number(),
    reason: z.string(),
    delta: z.string(),
  })).default([]),
});

export type RequiredVerification = z.infer<typeof requiredVerificationSchema>;
export type ReviewGateRequirement = z.infer<typeof reviewGateRequirementSchema>;
export type WorkPacketStatus = z.infer<typeof workPacketStatusSchema>;
export type WorkPacketEvidence = z.infer<typeof workPacketEvidenceSchema>;
export type CriterionCoverage = z.infer<typeof criterionCoverageSchema>;
export type WorkPacketSignal = z.infer<typeof workPacketSignalSchema>;
type ParsedWorkPacket = z.infer<typeof workPacketSchema>;
type ParsedScope = ParsedWorkPacket["scope"];
/** Optional additions keep source compatibility while schema parsing fills defaults. */
export type WorkPacket = Omit<
  ParsedWorkPacket,
  "scope" | "criterionCoverage" | "evidenceLedger" | "signals"
> & {
  scope: Omit<ParsedScope, "surfaces" | "entryPoints"> & {
    surfaces?: ParsedScope["surfaces"];
    entryPoints?: ParsedScope["entryPoints"];
  };
  criterionCoverage?: ParsedWorkPacket["criterionCoverage"];
  evidenceLedger?: ParsedWorkPacket["evidenceLedger"];
  signals?: ParsedWorkPacket["signals"];
};
