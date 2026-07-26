import { z } from "zod/v4";

export const systemModelObjectTypeSchema = z.enum([
  "domain",
  "capability",
  "flow",
  "constraint",
  "decision",
  "risk",
  "surface",
]);

export const freshnessClassSchema = z.enum([
  "code_coupled",
  "policy",
  "informational",
]);

export const riskLevelSchema = z.enum(["low", "medium", "high", "critical"]);

export const entryPointSchema = z.object({
  surface: z.string(),
  summary: z.string().optional(),
  files: z.array(z.string()).default([]),
  tests: z.array(z.string()).default([]),
  flows: z.array(z.string()).default([]),
});

export const domainSchema = z.object({
  id: z.string().regex(/^domain\.[a-z0-9_]+$/),
  type: z.literal("domain"),
  name: z.string(),
  summary: z.string(),
  keywords: z.array(z.string()),
}).strict();

export const bridgeSchema = z.object({
  to: z.string().regex(/^(capability|flow|constraint|risk)\.[a-z0-9_]+$/),
  reason: z.string().trim().min(1, "Bridge reason must be non-empty"),
}).strict();

export const capabilitySchema = z.object({
  id: z.string().regex(/^capability\.[a-z0-9_]+$/),
  type: z.literal("capability"),
  domain: z.string().regex(/^domain\.[a-z0-9_]+$/),
  name: z.string(),
  summary: z.string(),
  dependsOn: z.array(z.string()).default([]),
  bridges: z.array(bridgeSchema).default([]),
  constraints: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  suggestedFiles: z.array(z.string()).default([]),
  suggestedTests: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  entryPoints: z.array(entryPointSchema).default([]),
  freshness: z.object({ class: freshnessClassSchema }).optional(),
  risk: riskLevelSchema.default("medium"),
}).strict();

export const flowSchema = z.object({
  id: z.string().regex(/^flow\.[a-z0-9_]+$/),
  type: z.literal("flow"),
  domain: z.string().regex(/^domain\.[a-z0-9_]+$/),
  name: z.string(),
  summary: z.string(),
  primaryCapability: z.string().regex(/^capability\.[a-z0-9_]+$/),
  bridges: z.array(bridgeSchema).default([]),
  constraints: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  suggestedFiles: z.array(z.string()).default([]),
  suggestedTests: z.array(z.string()).default([]),
  steps: z.array(z.string()).default([]),
  freshness: z.object({ class: freshnessClassSchema }).optional(),
  risk: riskLevelSchema.default("medium"),
}).strict();

export const constraintSchema = z.object({
  id: z.string().regex(/^constraint\.[a-z0-9_]+$/),
  type: z.literal("constraint"),
  domain: z.string().regex(/^domain\.[a-z0-9_]+$/),
  scope: z.enum(["global", "domain", "targeted"]),
  guards: z.array(z.string().regex(/^(capability|flow)\.[a-z0-9_]+$/)).default([]),
  statement: z.string(),
  appliesTo: z.object({
    capabilities: z.array(z.string()).default([]),
    flows: z.array(z.string()).default([]),
    surfaces: z.array(z.string()).default([]),
    files: z.array(z.string()).default([]),
  }),
  severity: riskLevelSchema,
  agentInstruction: z.string().optional(),
  reviewGate: z.string().optional(),
  suggestedTests: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
}).strict();

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
  domain: z.string().regex(/^domain\.[a-z0-9_]+$/),
  summary: z.string(),
  severity: riskLevelSchema,
  appliesTo: z.object({
    capabilities: z.array(z.string()).default([]),
    flows: z.array(z.string()).default([]),
    surfaces: z.array(z.string()).default([]),
    files: z.array(z.string()).default([]),
  }).default({ capabilities: [], flows: [], surfaces: [], files: [] }),
  mitigation: z.string().optional(),
}).strict();

export const surfaceSchema = z.object({
  id: z.string().regex(/^surface\.[a-z0-9_]+$/),
  type: z.literal("surface"),
  name: z.string(),
  summary: z.string(),
  keywords: z.array(z.string()).default([]),
  suggestedFiles: z.array(z.string()).default([]),
  suggestedTests: z.array(z.string()).default([]),
});

export const systemModelObjectSchema = z.discriminatedUnion("type", [
  domainSchema,
  capabilitySchema,
  flowSchema,
  constraintSchema,
  decisionMetaSchema,
  riskSchema,
  surfaceSchema,
]);

export type SystemModelObjectType = z.infer<typeof systemModelObjectTypeSchema>;
export type FreshnessClass = z.infer<typeof freshnessClassSchema>;
export type RiskLevel = z.infer<typeof riskLevelSchema>;
export type Domain = z.infer<typeof domainSchema>;
export type Bridge = z.infer<typeof bridgeSchema>;
export type Capability = z.infer<typeof capabilitySchema>;
export type Flow = z.infer<typeof flowSchema>;
export type Constraint = z.infer<typeof constraintSchema>;
export type DecisionMeta = z.infer<typeof decisionMetaSchema>;
export type Risk = z.infer<typeof riskSchema>;
export type Surface = z.infer<typeof surfaceSchema>;
export type EntryPoint = z.infer<typeof entryPointSchema>;
export type SystemModelObject = z.infer<typeof systemModelObjectSchema>;
