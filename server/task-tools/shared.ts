/**
 * Shared helpers for task management tools.
 */

import type { Bus } from "../bus.ts";
import type { TaskManagerState } from "./types.ts";
import { serverLogger } from "../logging.ts";

const log = serverLogger.child("task-tools");

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
  try {
    onStateChange?.(taskState);
  } catch (err) {
    log.warn("state_change_callback_failed", { error: err });
  }
}
