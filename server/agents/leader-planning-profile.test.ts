import { describe, expect, it } from "vitest";
import { resolveLeaderPlanningProfile } from "./leader-planning-profile.ts";

describe("Leader planning profile", () => {
  it("selects Task Graph for a canonical Leader when persisted mode is absent", () => {
    const profile = resolveLeaderPlanningProfile({ hasCanonicalIdentity: true });

    expect(profile).toMatchObject({
      backend: "task_graph",
      orchestrationMode: "auto",
      promptFeatureIds: ["task_graph_planning"],
      usesTaskGraph: true,
      includeSkillInventory: false,
    });
    expect(profile.taskToolNames).not.toContain("plan_task");
    expect(profile.planningToolNames).toContain("submit_graph_plan");
  });

  it("keeps noncanonical compatibility sessions on the legacy profile", () => {
    const profile = resolveLeaderPlanningProfile({ hasCanonicalIdentity: false });

    expect(profile).toMatchObject({
      backend: "legacy",
      orchestrationMode: "direct",
      promptFeatureIds: ["legacy_planning"],
      usesTaskGraph: false,
      includeSkillInventory: true,
    });
    expect(profile.taskToolNames).toContain("plan_task");
    expect(profile.planningToolNames).toEqual([]);
  });

  it("honors the explicit legacy debug mode for canonical Leaders", () => {
    const profile = resolveLeaderPlanningProfile({
      hasCanonicalIdentity: true,
      orchestrationMode: "direct",
    });

    expect(profile.backend).toBe("legacy");
    expect(profile.promptFeatureIds).toEqual(["legacy_planning"]);
    expect(profile.taskToolNames).toContain("assign_task");
    expect(profile.planningToolNames).toEqual([]);
  });
});
