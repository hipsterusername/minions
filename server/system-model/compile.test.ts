import { describe, expect, it } from "vitest";
import type { FreshnessTimestampFn } from "./freshness.ts";
import { compileWorkPacket, CONTEXT_PACK_PREAMBLE } from "./compile.ts";
import { loadSystemModel } from "./load.ts";
import { copyValidFixtureWithSurfaces } from "./load.test.ts";

const freshTimestamps: FreshnessTimestampFn = async () => ({ modelTouchedAt: 20, codeTouchedAt: 10 });

describe("compileWorkPacket", () => {
  it("expands linked scope, derives packet-required, and renders safety preamble", async () => {
    const model = loadSystemModel("tests/fixtures/system-model/valid").model!;
    const result = await compileWorkPacket({
      model,
      cwd: "/repo",
      headSha: "abc",
      mode: "advisory",
      userRequest: "approve workspace change",
      normalizedGoal: "Approve workspace change",
      matchedCandidates: [{ id: "capability.workspace_management", type: "capability", score: 5, reasons: [] }],
      matchConfidence: "medium",
      taskFiles: ["server/session-host.ts"],
      timestampFn: freshTimestamps,
      now: 100,
      packetId: "packet.1",
      leaderSessionKey: "leader.1",
      objectFiles: {
        "capability.workspace_management": "capabilities/workspace.yaml",
        "flow.approve_changes": "flows/approve.yaml",
      },
    });

    expect(result.packet.scope).toMatchObject({
      capabilities: ["capability.workspace_management"],
      flows: ["flow.approve_changes"],
      constraints: ["constraint.bus_only"],
      decisions: ["decision.bus_architecture"],
      risks: ["risk.merge_bypass"],
    });
    expect(result.packetRequired).toBe(true);
    expect(result.packet.reviewGates[0]).toMatchObject({ gateId: "gate.review", status: "required_pending" });
    expect(result.contextPack.startsWith(CONTEXT_PACK_PREAMBLE)).toBe(true);
    expect(result.contextPack).toContain("Constraint constraint.bus_only");
  });

  it("emits an omission marker when context budget cuts objects", async () => {
    const model = loadSystemModel("tests/fixtures/system-model/valid").model!;
    model.policies.contextBudgets = { minionContextPack: 45, perObjectSummary: 20, leaderPromptAddendum: 1200 };

    const result = await compileWorkPacket({
      model,
      cwd: "/repo",
      headSha: "abc",
      mode: "advisory",
      userRequest: "approve workspace change",
      normalizedGoal: "Approve workspace change",
      matchedCandidates: [{ id: "capability.workspace_management", type: "capability", score: 5, reasons: [] }],
      matchConfidence: "low",
      timestampFn: freshTimestamps,
      now: 100,
    });

    expect(result.contextPack).toContain("[");
    expect(result.contextPack).toContain("objects omitted by context budget");
    expect(result.contextPack).toContain("use query_system_model");
    expect(result.contextPack).toMatch(/constraint\.bus_only|additional-context/);
    expect(result.contextPack).toContain("inspect repo; ask only if required");
  });

  it("routes open signals and acceptance coverage ahead of general model context", async () => {
    const model = loadSystemModel("tests/fixtures/system-model/valid").model!;
    const result = await compileWorkPacket({
      model,
      cwd: "/repo",
      headSha: "abc",
      mode: "advisory",
      userRequest: "approve workspace change",
      normalizedGoal: "Approve workspace change",
      matchedCandidates: [{ id: "capability.workspace_management", type: "capability", score: 5, reasons: [] }],
      matchConfidence: "high",
      acceptanceCriteria: ["Focused tests demonstrate the behavior"],
      timestampFn: freshTimestamps,
      now: 100,
    });

    expect(result.contextPack).toContain("Open high signal signal.coverage_gap.criterion-1");
    expect(result.contextPack).toContain("Criterion criterion-1 [open]");
    expect(result.contextPack.indexOf("Open high signal")).toBeLessThan(
      result.contextPack.indexOf("Capability capability.workspace_management"),
    );
  });

  it("appends amendments without dropping prior packet identity", async () => {
    const model = loadSystemModel("tests/fixtures/system-model/valid").model!;
    const first = await compileWorkPacket({
      model,
      cwd: "/repo",
      headSha: "abc",
      mode: "advisory",
      userRequest: "approve workspace change",
      normalizedGoal: "Approve workspace change",
      matchedCandidates: [{ id: "flow.approve_changes", type: "flow", score: 6, reasons: [] }],
      matchConfidence: "high",
      timestampFn: freshTimestamps,
      now: 100,
      packetId: "packet.1",
      leaderSessionKey: "leader.1",
    });
    const amended = await compileWorkPacket({
      model,
      cwd: "/repo",
      headSha: "def",
      mode: "advisory",
      userRequest: "approve workspace change",
      normalizedGoal: "Approve workspace change",
      matchedCandidates: [{ id: "capability.workspace_management", type: "capability", score: 6, reasons: [] }],
      matchConfidence: "high",
      timestampFn: freshTimestamps,
      now: 200,
      existingPacket: first.packet,
      amendment: { reason: "scope changed", delta: "include workspace capability" },
    });

    expect(amended.packet.id).toBe("packet.1");
    expect(amended.packet.status).toBe("amended");
    expect(amended.packet.amendments).toEqual([{ at: 200, reason: "scope changed", delta: "include workspace capability" }]);
  });

  it("keeps surface closure to one hop while preserving capability entry-point provenance", async () => {
    const model = loadSystemModel(copyValidFixtureWithSurfaces()).model!;
    const result = await compileWorkPacket({
      model,
      cwd: "/repo",
      headSha: "abc",
      mode: "advisory",
      userRequest: "update mobile approval",
      normalizedGoal: "Update mobile approval",
      matchedCandidates: [{ id: "surface.mobile", type: "surface", score: 8, reasons: [] }],
      matchConfidence: "high",
      timestampFn: async () => ({ modelTouchedAt: 10, codeTouchedAt: 20 }),
      now: 100,
    });

    expect(result.packet.scope.capabilities).toEqual(["capability.workspace_management"]);
    expect(result.packet.scope.flows).toEqual([]);
    expect(result.packet.scope.surfaces).toEqual(["surface.mobile"]);
    expect(result.packet.scope.entryPoints).toEqual([
      {
        capabilityId: "capability.workspace_management",
        surfaceId: "surface.canvas",
        files: ["src/Canvas.tsx"],
        tests: ["src/Canvas.test.tsx"],
        flows: ["flow.approve_changes"],
      },
      {
        capabilityId: "capability.workspace_management",
        surfaceId: "surface.mobile",
        files: ["src/mobile/**"],
        tests: ["src/mobile/app.test.ts"],
        flows: ["flow.approve_changes"],
      },
    ]);
    expect(result.contextPack).toContain("Entry point surface.mobile for capability.workspace_management");
    expect(result.contextPack).toContain("Freshness instruction: inspect current code");
    expect(result.packet.agentInstructions).toEqual(["inspect current code"]);
  });
});
