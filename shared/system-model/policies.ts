import { z } from "zod/v4";

export const freshnessConsequenceSchema = z.enum([
  "verify_before_task",
  "required_agent_actions",
  "block_if_unverified",
]);

export const freshnessPolicySchema = z.object({
  policyClass: z.string(),
  consequence: freshnessConsequenceSchema,
  requiredActions: z.array(z.string()).default([]),
});

export const reviewGateSchema = z.object({
  id: z.string().regex(/^gate\.[a-z0-9_]+$/),
  name: z.string(),
  description: z.string().optional(),
  blocksMerge: z.boolean().default(false),
  requiredChecks: z.array(z.object({
    kind: z.enum(["freshness", "test", "manual_review", "constraint"]),
    target: z.string().min(1),
  })).optional(),
  requiredWhen: z.object({
    files: z.array(z.string()).default([]),
    capabilities: z.array(z.string()).default([]),
    flows: z.array(z.string()).default([]),
    risk: z.array(z.enum(["low", "medium", "high", "critical"])).default([]),
  }).default({ files: [], capabilities: [], flows: [], risk: [] }),
});

export const contextBudgetSchema = z.object({
  leaderPromptAddendum: z.number().int().positive().default(1200),
  minionContextPack: z.number().int().positive().default(2000),
  perObjectSummary: z.number().int().positive().default(250),
});

export const systemModelPoliciesSchema = z.object({
  freshness: z.array(freshnessPolicySchema).default([]),
  reviewGates: z.array(reviewGateSchema).default([]),
  contextBudgets: contextBudgetSchema.default({
    leaderPromptAddendum: 1200,
    minionContextPack: 2000,
    perObjectSummary: 250,
  }),
});

export type FreshnessPolicy = z.infer<typeof freshnessPolicySchema>;
export type ReviewGate = z.infer<typeof reviewGateSchema>;
export type ContextBudget = z.infer<typeof contextBudgetSchema>;
export type SystemModelPolicies = z.infer<typeof systemModelPoliciesSchema>;
