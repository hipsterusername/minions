import { describe, expect, it } from "vitest";
import { workPacketSchema } from "./packet.ts";

describe("workPacketSchema", () => {
  it("validates packet lifecycle data", () => {
    const packet = workPacketSchema.parse({
      id: "wp_1",
      leaderSessionKey: "leader-1",
      createdAt: 1,
      userRequest: "change it",
      normalizedGoal: "Change it",
      status: "draft",
      scope: {
        capabilities: [],
        flows: [],
        constraints: [],
        decisions: [],
        risks: [],
        suggestedFiles: [],
        suggestedTests: [],
      },
      nonGoals: [],
      agentInstructions: [],
      freshness: { status: "unknown", warnings: [], requiredVerifications: [] },
      reviewGates: [],
      riskLevel: "low",
      matchConfidence: "high",
    });
    expect(packet.amendments).toEqual([]);
    expect(packet.scope.surfaces).toEqual([]);
    expect(packet.scope.entryPoints).toEqual([]);
    expect(packet.criterionCoverage).toEqual([]);
    expect(packet.evidenceLedger).toEqual([]);
    expect(packet.signals).toEqual([]);
  });

  it("validates provenance-bearing evidence, coverage, and signals", () => {
    const packet = workPacketSchema.parse({
      id: "wp_stateful",
      leaderSessionKey: "leader-1",
      createdAt: 1,
      userRequest: "change it",
      normalizedGoal: "Change it",
      status: "active",
      scope: {
        capabilities: [], flows: [], constraints: [], decisions: [], risks: [],
        suggestedFiles: [], suggestedTests: [],
      },
      nonGoals: [],
      agentInstructions: [],
      freshness: { status: "fresh", warnings: [], requiredVerifications: [] },
      reviewGates: [],
      riskLevel: "medium",
      matchConfidence: "medium",
      criterionCoverage: [{
        criterionId: "criterion-1",
        criterion: "Tests demonstrate the change",
        status: "verified",
        evidenceRefs: ["server/example.test.ts"],
        provenance: "leader_observed",
        updatedAt: 2,
      }],
      evidenceLedger: [{
        id: "evidence-1",
        kind: "observation",
        summary: "Focused tests passed",
        criterionIds: ["criterion-1"],
        evidenceRefs: ["server/example.test.ts"],
        provenance: "leader_observed",
        createdAt: 2,
      }],
      signals: [{
        id: "signal-1",
        type: "coverage_gap",
        priority: "high",
        status: "addressed",
        summary: "Criterion needs verification",
        criterionIds: ["criterion-1"],
        resolution: "Focused tests passed",
        createdAt: 1,
        updatedAt: 2,
      }],
    });

    expect(packet.criterionCoverage[0]?.objectIds).toEqual([]);
    expect(packet.evidenceLedger[0]?.objectIds).toEqual([]);
    expect(packet.signals[0]?.evidenceRefs).toEqual([]);
  });
});
