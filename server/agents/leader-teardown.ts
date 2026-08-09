/**
 * Leader teardown — child-session cleanup when a leader SESSION goes away.
 *
 * When the leader session is being torn down (closed or removed), its
 * children have lost their orchestrator: abort any still-running minion
 * sessions and mark their tasks `parent_terminated`.
 *
 * Deliberately gated to `close`/`remove` and NOT wired to run completion
 * (`onComplete`): a leader ending a turn while minions work in parallel is
 * the designed workflow (assign_task → wait_and_continue → auto-resume via
 * `wakeWaitingLeaderIfAllChildrenTerminal`). Sweeping children on every
 * `done` event aborted all running minions the moment the leader paused —
 * see the regression test "does not cancel running child tasks when a
 * leader run completes" in leader.test.ts.
 */

import type { AgentTypeContext } from "./types.ts";
import type { SessionTerminateReason } from "../session-host-terminate.ts";
import { applyLifecycleEvent, isTerminalTaskStatus } from "../task-lifecycle.ts";
import { persistTaskState } from "../session-persist.ts";

export function cancelChildrenOnLeaderTeardown(
  ctx: AgentTypeContext,
  reason: SessionTerminateReason,
): void {
  if (reason !== "close" && reason !== "remove") return;
  ctx.forEachLeaderTaskState?.((leaderKey, taskState) => {
    if (leaderKey !== ctx.sessionKey) return;
    for (const task of Array.from(taskState.tasks.values())) {
      if (isTerminalTaskStatus(task.status)) continue;
      if (task.minionSessionKey) {
        ctx.terminateSession?.(task.minionSessionKey, "abort");
      }
      applyLifecycleEvent({
        bus: ctx.bus,
        leaderSessionKey: leaderKey,
        taskState,
        taskId: task.taskId,
        event: { type: "parent_terminated" },
        onStateChange: (state) => persistTaskState(leaderKey, state),
      });
    }
  });
}
