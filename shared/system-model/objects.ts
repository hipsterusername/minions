import { z } from "zod/v4";

export const systemModelObjectTypeSchema = z.enum([
  "capability",
  "flow",
  "constraint",
  "decision",
  "risk",
]);

export const freshnessClassSchema = z.enum([
  "code_coupled",
  "policy",
  "informational",
]);

export const riskLevelSchema = z.enum(["low", "medium", "high", "critical"]);

export const capabilitySchema = z.object({
  id: z.string().regex(/^capability\.[a-z0-9_]+$/),
  type: z.literal("capability"),
  name: z.string(),
  summary: z.string(),
  linkedFlows: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  suggestedFiles: z.array(z.string()).default([]),
  suggestedTests: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  freshness: z.object({ class: freshnessClassSchema }).optional(),
  risk: riskLevelSchema.default("medium"),
});

export const flowSchema = z.object({
  id: z.string().regex(/^flow\.[a-z0-9_]+$/),
  type: z.literal("flow"),
  name: z.string(),
  summary: z.string(),
  capabilities: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  suggestedFiles: z.array(z.string()).default([]),
  suggestedTests: z.array(z.string()).default([]),
  steps: z.array(z.string()).default([]),
  freshness: z.object({ class: freshnessClassSchema }).optional(),
  risk: riskLevelSchema.default("medium"),
});

export const constraintSchema = z.object({
  id: z.string().regex(/^constraint\.[a-z0-9_]+$/),
  type: z.literal("constraint"),
  statement: z.string(),
  appliesTo: z.object({
    capabilities: z.array(z.string()).default([]),
    flows: z.array(z.string()).default([]),
    files: z.array(z.string()).default([]),
  }),
  severity: riskLevelSchema,
  agentInstruction: z.string().optional(),
  reviewGate: z.string().optional(),
  suggestedTests: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
});

export const decisionMetaSchema = z.object({
  id: z.string().regex(/^decision\.[a-z0-9_]+$/),
  type: z.literal("decision"),
  title: z.string(),
  status: z.enum(["proposed", "accepted", "deprecated", "superseded"]).default("accepted"),
  summary: z.string(),
  file: z.string().optional(),
  evidence: z.array(z.string()).default([]),
});

export const riskSchema = z.object({
  id: z.string().regex(/^risk\.[a-z0-9_]+$/),
  type: z.literal("risk"),
  summary: z.string(),
  severity: riskLevelSchema,
  appliesTo: z.object({
    capabilities: z.array(z.string()).default([]),
    flows: z.array(z.string()).default([]),
    files: z.array(z.string()).default([]),
  }).default({ capabilities: [], flows: [], files: [] }),
  mitigation: z.string().optional(),
});

export const systemModelObjectSchema = z.discriminatedUnion("type", [
  capabilitySchema,
  flowSchema,
  constraintSchema,
  decisionMetaSchema,
  riskSchema,
]);

export type SystemModelObjectType = z.infer<typeof systemModelObjectTypeSchema>;
export type FreshnessClass = z.infer<typeof freshnessClassSchema>;
export type RiskLevel = z.infer<typeof riskLevelSchema>;
export type Capability = z.infer<typeof capabilitySchema>;
export type Flow = z.infer<typeof flowSchema>;
export type Constraint = z.infer<typeof constraintSchema>;
export type DecisionMeta = z.infer<typeof decisionMetaSchema>;
export type Risk = z.infer<typeof riskSchema>;
export type SystemModelObject = z.infer<typeof systemModelObjectSchema>;
