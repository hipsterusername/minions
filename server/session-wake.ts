/**
 * Wake-worthiness + digest helpers for leader resurrection.
 *
 * Extracted from session-registry.ts to keep that file under its 400-line
 * architectural budget. A leader waiting on its children (or idle) should be
 * woken not only when every child reaches a terminal status, but also when a
 * child enters the non-terminal `blocked` state — a blocked minion ended its
 * turn awaiting a leader decision, so the leader must be roused to answer it.
 */

import type { TaskRecord } from "./task-tools.ts";
import { isTerminalTaskStatus } from "./task-lifecycle.ts";

/**
 * A status that should rouse a waiting/idle leader: any terminal status, plus
 * `blocked` (the minion is paused awaiting the leader's input).
 */
export function isWakeWorthyStatus(status: TaskRecord["status"]): boolean {
  return status === "blocked" || isTerminalTaskStatus(status);
}

/**
 * One digest line per task; restricted to wake-worthy tasks. Terminal tasks are
 * further gated by `sinceMs` (so a stale completed task doesn't re-surface);
 * blocked tasks are always included and render their pending question.
 */
export function buildTaskDigest(tasks: TaskRecord[], sinceMs?: number): string {
  return tasks
    .filter((t) => {
      if (t.status === "blocked") return true;
      return (
        isTerminalTaskStatus(t.status) &&
        (sinceMs == null || (t.completedAt != null && t.completedAt >= sinceMs))
      );
    })
    .map((t) =>
      t.status === "blocked"
        ? `${t.taskId} — blocked — ${(t.lastStep ?? "").slice(0, 200)}`
        : `${t.taskId} — ${t.status} — ${(t.result ?? "").slice(0, 200)}`,
    )
    .join("\n");
}
