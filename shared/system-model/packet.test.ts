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
  });
});
