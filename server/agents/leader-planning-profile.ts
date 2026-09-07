import type { LeaderPromptFeatureId } from "../../shared/leader-prompt.ts";
import {
  TASK_GRAPH_LEADER_TASK_TOOL_NAMES,
  TASK_GRAPH_PLANNING_TOOL_NAMES,
  normalizeLeaderOrchestrationMode,
} from "../../shared/leader-planning.ts";
import type { LeaderOrchestrationMode } from "../../shared/task-graph-planning-contracts.ts";

export interface LeaderPlanningProfile {
  backend: "task_graph";
  orchestrationMode: Exclude<LeaderOrchestrationMode, "direct">;
  promptFeatureIds: readonly LeaderPromptFeatureId[];
  taskToolNames: readonly string[];
  planningToolNames: readonly string[];
  includeSkillInventory: boolean;
  usesTaskGraph: true;
}

const TASK_GRAPH_AUTO_PROFILE: LeaderPlanningProfile = {
  backend: "task_graph",
  orchestrationMode: "auto",
  promptFeatureIds: ["task_graph_planning"],
  taskToolNames: TASK_GRAPH_LEADER_TASK_TOOL_NAMES,
  planningToolNames: TASK_GRAPH_PLANNING_TOOL_NAMES,
  includeSkillInventory: true,
  usesTaskGraph: true,
};

export function resolveLeaderPlanningProfile(input: {
  orchestrationMode?: LeaderOrchestrationMode | undefined;
}): LeaderPlanningProfile {
  const orchestrationMode = normalizeLeaderOrchestrationMode(input.orchestrationMode);
  if (orchestrationMode === "auto") return TASK_GRAPH_AUTO_PROFILE;
  return { ...TASK_GRAPH_AUTO_PROFILE, orchestrationMode: "plan" };
}
