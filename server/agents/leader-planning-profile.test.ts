import { describe, expect, it } from "vitest";
import { resolveLeaderPlanningProfile } from "./leader-planning-profile.ts";

describe("Leader planning profile", () => {
  it("adds Task Graph assistance without removing direct Leader tools", () => {
    const profile = resolveLeaderPlanningProfile({ hasCanonicalIdentity: true });

    expect(profile).toMatchObject({
      backend: "task_graph",
      orchestrationMode: "auto",
      promptFeatureIds: ["task_graph_planning"],
      usesTaskGraph: true,
      includeSkillInventory: true,
    });
    expect(profile.taskToolNames).toContain("plan_task");
    expect(profile.taskToolNames).toContain("assign_task");
    expect(profile.taskToolNames).toContain("message_task");
    expect(profile.planningToolNames).toEqual([
      "initialize_graph_document", "upsert_graph_node", "remove_graph_node",
      "upsert_graph_edge", "remove_graph_edge", "get_graph_document", "submit_graph_document",
      "submit_graph_plan", "submit_dialectic_graph", "get_graph_plan", "start_graph_plan",
      "read_graph_artifact", "cancel_graph_run", "moderate_dialectic", "adjudicate_graph_node",
    ]);
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
