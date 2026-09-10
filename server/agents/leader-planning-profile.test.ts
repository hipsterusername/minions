import { describe, expect, it } from "vitest";
import { resolveLeaderPlanningProfile } from "./leader-planning-profile.ts";

describe("Leader planning profile", () => {
  it("adds Task Graph assistance without removing direct Leader tools", () => {
    const profile = resolveLeaderPlanningProfile({});

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
      "list_minion_context_blocks", "preview_minion_context",
      "initialize_graph_document", "upsert_graph_node", "remove_graph_node",
      "upsert_graph_edge", "remove_graph_edge", "get_graph_document", "submit_graph_document",
      "submit_graph_plan", "submit_dialectic_graph", "get_graph_plan", "start_graph_plan",
      "read_graph_artifact", "cancel_graph_run", "moderate_dialectic", "adjudicate_graph_node",
    ]);
  });

  it("keeps Graph enabled for canonical Leaders with a saved legacy override", () => {
    const profile = resolveLeaderPlanningProfile({
      orchestrationMode: "direct",
    });

    expect(profile.backend).toBe("task_graph");
    expect(profile.promptFeatureIds).toEqual(["task_graph_planning"]);
    expect(profile.taskToolNames).toContain("assign_task");
    expect(profile.planningToolNames).toContain("submit_graph_plan");
    expect(profile.orchestrationMode).toBe("auto");
  });
});
