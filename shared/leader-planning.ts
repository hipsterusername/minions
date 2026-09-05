import type { LeaderOrchestrationMode } from "./task-graph-planning-contracts.ts";

export const LEADER_PLANNING_BACKENDS = ["task_graph", "legacy"] as const;
export type LeaderPlanningBackend = (typeof LEADER_PLANNING_BACKENDS)[number];

/** Graph assistance is enabled for every new canonical Leader by default. */
export const DEFAULT_LEADER_PLANNING_BACKEND: LeaderPlanningBackend = "task_graph";

/** Tool partitions shared by prompt previews and authoritative server profiles. */
export const LEGACY_LEADER_TASK_TOOL_NAMES = [
  "plan_task", "assign_task", "complete_task", "cancel_task", "message_task",
  "get_task_status", "set_task_name", "wait_and_continue", "checkpoint_session",
  "load_skill", "load_subskill", "load_skill_attachment", "update_project_context",
] as const;

/**
 * Enabling graph assistance must not remove the Leader's direct planning,
 * delegation, steering, or waiting capabilities.
 */
export const TASK_GRAPH_LEADER_TASK_TOOL_NAMES = [
  ...LEGACY_LEADER_TASK_TOOL_NAMES,
] as const;

export const TASK_GRAPH_PLANNING_TOOL_NAMES = [
  "initialize_graph_document", "upsert_graph_node", "remove_graph_node",
  "upsert_graph_edge", "remove_graph_edge", "get_graph_document", "submit_graph_document",
  "submit_graph_plan", "submit_dialectic_graph", "get_graph_plan", "start_graph_plan",
  "read_graph_artifact", "cancel_graph_run", "moderate_dialectic", "adjudicate_graph_node",
] as const;

export const LEADER_RENDER_TOOL_NAMES = [
  "render_set", "render_patch", "render_append", "render_remove", "publish_html",
] as const;

export function normalizeLeaderPlanningBackend(value: unknown): LeaderPlanningBackend {
  return value === "legacy" ? "legacy" : DEFAULT_LEADER_PLANNING_BACKEND;
}

export function defaultOrchestrationModeForBackend(
  backend: LeaderPlanningBackend,
): LeaderOrchestrationMode {
  return backend === "legacy" ? "direct" : "auto";
}

export function planningBackendForOrchestrationMode(
  mode: LeaderOrchestrationMode,
): LeaderPlanningBackend {
  return mode === "direct" ? "legacy" : "task_graph";
}
