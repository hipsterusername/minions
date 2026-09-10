import type { LeaderOrchestrationMode } from "./task-graph-planning-contracts.ts";

/** Legacy supports standalone task-tool consumers; Leaders always use task_graph. */
export type LeaderPlanningBackend = "task_graph" | "legacy";

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
  "list_minion_context_blocks", "preview_minion_context",
  "initialize_graph_document", "upsert_graph_node", "remove_graph_node",
  "upsert_graph_edge", "remove_graph_edge", "get_graph_document", "submit_graph_document",
  "submit_graph_plan", "submit_dialectic_graph", "get_graph_plan", "start_graph_plan",
  "read_graph_artifact", "cancel_graph_run", "moderate_dialectic", "adjudicate_graph_node",
] as const;

export const LEADER_RENDER_TOOL_NAMES = [
  "render_set", "render_patch", "render_append", "render_remove", "publish_html",
] as const;

/** Persisted direct-mode overrides migrate to Graph; plan review remains explicit. */
export function normalizeLeaderOrchestrationMode(
  value: unknown,
): Exclude<LeaderOrchestrationMode, "direct"> {
  return value === "plan" ? "plan" : "auto";
}
