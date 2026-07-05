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

export const workPacketSchema = z.object({
  id: z.string(),
  leaderSessionKey: z.string(),
  createdAt: z.number(),
  userRequest: z.string(),
  normalizedGoal: z.string(),
  status: workPacketStatusSchema,
  scope: z.object({
    capabilities: z.array(z.string()),
    flows: z.array(z.string()),
    constraints: z.array(z.string()),
    decisions: z.array(z.string()),
    risks: z.array(z.string()),
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
  amendments: z.array(z.object({
    at: z.number(),
    reason: z.string(),
    delta: z.string(),
  })).default([]),
});

export type RequiredVerification = z.infer<typeof requiredVerificationSchema>;
export type ReviewGateRequirement = z.infer<typeof reviewGateRequirementSchema>;
export type WorkPacketStatus = z.infer<typeof workPacketStatusSchema>;
export type WorkPacket = z.infer<typeof workPacketSchema>;
