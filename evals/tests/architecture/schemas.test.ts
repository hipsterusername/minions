import { describe, expect, it } from "vitest";
import { ExperimentPlanSchema, TaskDefinitionSchema, UsageSchema } from "../../schemas/index.js";
import { taskManifest } from "../support/fixtures.js";

describe("versioned evaluation schemas", () => {
  it("accepts a complete task manifest and rejects unknown schema versions", () => {
    expect(TaskDefinitionSchema.parse(taskManifest).id).toBe("pagination-simple");
    expect(() => TaskDefinitionSchema.parse({ ...taskManifest, schemaVersion: 2 })).toThrow(/Invalid input/);
  });
  it("rejects inconsistent token totals and accepts transparent accounting", () => {
    const base = { schemaVersion: 1, sourceId: "turn-1", participantId: "participant-1", turnId: "turn-1", observationKind: "delta", inputTokensTotal: 10, inputTokensUncached: 8, cacheReadTokens: 2, cacheWriteTokens: null, outputTokensTotal: 5, reasoningTokens: 3, totalTokens: 15, reportedCostUSD: null, estimatedCostUSD: null, coverage: "complete", coverageReasons: [] };
    expect(UsageSchema.parse(base).totalTokens).toBe(15);
    expect(() => UsageSchema.parse({ ...base, totalTokens: 14 })).toThrow(/totalTokens/);
  });
  it("requires a locked plan to pin implementation provenance", () => {
    const plan = { schemaVersion: 1, experimentId: "pilot", taskRevisions: { "pagination-simple": "r1" }, adapterConfigs: [], repetitions: 1, schedulingSeed: "seed", limits: { aggregateTokenCap: 100, storageBytes: 1024 }, provenance: { evaluatorRevision: "r1", implementationDigest: "a".repeat(64), createdAt: "2026-01-01T00:00:00.000Z" } };
    expect(ExperimentPlanSchema.parse(plan).experimentId).toBe("pilot");
  });
});
