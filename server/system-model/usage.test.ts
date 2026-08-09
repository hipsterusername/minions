import { describe, expect, it } from "vitest";
import { loadSystemModel } from "./load.ts";
import { copyValidFixture, copyValidFixtureWithSurfaces } from "./load.test.ts";
import { recordSystemModelUsage, saveWorkPacket } from "./store.ts";
import { orphanedObjects, staleObjects, unusedInLastNPackets } from "./usage.ts";
import type { WorkPacket } from "../../shared/system-model/index.ts";

describe("system-model usage queries", () => {
  it("finds objects unused in the last N packets", async () => {
    const project = copyValidFixture();
    const { model } = loadSystemModel(project);
    saveWorkPacket(project, packet("wp-old", {
      capabilities: ["capability.workspace_management"],
      flows: [],
      constraints: [],
      decisions: [],
      risks: [],
    }), "old", 1);
    saveWorkPacket(project, packet("wp-new", {
      capabilities: [],
      flows: ["flow.approve_changes"],
      constraints: ["constraint.bus_only"],
      decisions: ["decision.bus_architecture"],
      risks: ["risk.merge_bypass"],
    }), "new", 2);

    const unused = await unusedInLastNPackets({ projectPath: project, model: model!, n: 1 });

    expect(unused.map((item) => item.id)).toEqual(["capability.workspace_management", "domain.workspace"]);
    expect(unused[0]?.reason).toBe("No packet usage in last 1 Work Packets and no query usage since 2");
  });

  it("treats query usage as a live signal when no packets exist", async () => {
    const project = copyValidFixture();
    const { model } = loadSystemModel(project);
    recordSystemModelUsage(project, [{
      objectId: "capability.workspace_management",
      source: "query",
      sessionKey: "leader-1",
      usedAt: 10,
    }]);

    const unused = await unusedInLastNPackets({ projectPath: project, model: model!, n: 30 });

    expect(unused.map((item) => item.id)).not.toContain("capability.workspace_management");
    expect(unused[0]?.reason).toBe("No Work Packets and no query usage recorded");
  });

  it("counts query usage since the oldest recent packet", async () => {
    const project = copyValidFixture();
    const { model } = loadSystemModel(project);
    saveWorkPacket(project, packet("wp-window", {
      capabilities: [],
      flows: [],
      constraints: [],
      decisions: [],
      risks: [],
    }), "window", 20);
    recordSystemModelUsage(project, [
      {
        objectId: "capability.workspace_management",
        source: "query",
        sessionKey: "leader-1",
        usedAt: 3,
      },
      {
        objectId: "flow.approve_changes",
        source: "query",
        sessionKey: "leader-1",
        usedAt: 1,
      },
    ]);

    const unused = await unusedInLastNPackets({ projectPath: project, model: model!, n: 1 });

    expect(unused.map((item) => item.id)).not.toContain("capability.workspace_management");
    expect(unused.map((item) => item.id)).toContain("flow.approve_changes");
  });

  it("reports stale code-coupled objects via freshness.ts", async () => {
    const project = copyValidFixture();
    const { model } = loadSystemModel(project);

    const stale = await staleObjects({
      model: model!,
      cwd: project,
      headSha: "head",
      mode: "advisory",
      timestampFn: async ({ objectFile }) => ({
        modelTouchedAt: objectFile.includes("workspace_management") ? 10 : 20,
        codeTouchedAt: objectFile.includes("workspace_management") ? 30 : 5,
      }),
    });

    expect(stale).toEqual([
      expect.objectContaining({
        id: "capability.workspace_management",
        status: "stale",
        modelTouchedAt: 10,
        codeTouchedAt: 30,
      }),
    ]);
  });

  it("finds graph objects with no inbound links", () => {
    const project = copyValidFixture();
    const { model } = loadSystemModel(project);

    const orphaned = orphanedObjects(model!);

    expect(orphaned.map((item) => item.id)).toEqual([]);
  });

  it("does not classify entry-point surfaces as orphaned", () => {
    const project = copyValidFixtureWithSurfaces();
    const { model } = loadSystemModel(project);
    expect(orphanedObjects(model!).map((item) => item.id)).not.toContain("surface.mobile");
  });
});

function packet(id: string, scope: Pick<WorkPacket["scope"], "capabilities" | "flows" | "constraints" | "decisions" | "risks">): WorkPacket {
  return {
    id,
    leaderSessionKey: "leader-1",
    createdAt: id === "wp-old" ? 1 : 2,
    userRequest: "request",
    normalizedGoal: "request",
    status: "draft",
    scope: {
      ...scope,
      suggestedFiles: [],
      suggestedTests: [],
    },
    nonGoals: [],
    agentInstructions: [],
    freshness: { status: "fresh", warnings: [], requiredVerifications: [] },
    reviewGates: [],
    riskLevel: "low",
    matchConfidence: "high",
    amendments: [],
  };
}
