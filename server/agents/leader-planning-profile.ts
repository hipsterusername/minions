import type { LeaderPromptFeatureId } from "../../shared/leader-prompt.ts";
import {
  LEGACY_LEADER_TASK_TOOL_NAMES,
  TASK_GRAPH_LEADER_TASK_TOOL_NAMES,
  TASK_GRAPH_PLANNING_TOOL_NAMES,
  planningBackendForOrchestrationMode,
  type LeaderPlanningBackend,
} from "../../shared/leader-planning.ts";
import type { LeaderOrchestrationMode } from "../../shared/task-graph-planning-contracts.ts";

export interface LeaderPlanningProfile {
  backend: LeaderPlanningBackend;
  orchestrationMode: LeaderOrchestrationMode;
  promptFeatureIds: readonly LeaderPromptFeatureId[];
  taskToolNames: readonly string[];
  planningToolNames: readonly string[];
  includeSkillInventory: boolean;
  usesTaskGraph: boolean;
}

const LEGACY_PROFILE: LeaderPlanningProfile = {
  backend: "legacy",
  orchestrationMode: "direct",
  promptFeatureIds: ["legacy_planning"],
  taskToolNames: LEGACY_LEADER_TASK_TOOL_NAMES,
  planningToolNames: [],
  includeSkillInventory: true,
  usesTaskGraph: false,
};

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
  hasCanonicalIdentity: boolean;
}): LeaderPlanningProfile {
  const orchestrationMode = input.orchestrationMode
    ?? (input.hasCanonicalIdentity ? "auto" : "direct");
  const backend = planningBackendForOrchestrationMode(orchestrationMode);
  if (backend === "legacy") return LEGACY_PROFILE;
  if (orchestrationMode === "auto") return TASK_GRAPH_AUTO_PROFILE;
  return { ...TASK_GRAPH_AUTO_PROFILE, orchestrationMode: "plan" };
}
