/**
 * Shared helpers for task management tools.
 */

import type { Bus } from "../bus.ts";
import type { TaskManagerState } from "./types.ts";

/** Broadcast the plan + optionally notify the persistence layer (Phase 4.4). */
export function emitTaskPlanUpdate(
  bus: Bus,
  leaderSessionKey: string,
  taskState: TaskManagerState,
  onStateChange?: (state: TaskManagerState) => void,
): void {
  bus.emitToSession(leaderSessionKey, {
    type: "task_plan_update",
    leaderSessionKey,
    tasks: Array.from(taskState.tasks.values()),
  });
  try { onStateChange?.(taskState); }
  catch (err) { console.warn("[task-tools] onStateChange failed:", err); }
}
