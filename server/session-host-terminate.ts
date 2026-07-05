import type { Bus } from "./bus.ts";
import type { SessionHost } from "./session-host.ts";
import type { TaskManagerState } from "./task-tools/types.ts";
import { applySessionEndedForMinion } from "./task-lifecycle.ts";
import { persistTaskState } from "./session-persist.ts";
import { getAgentTypeOrDefault } from "./agents/index.ts";
import { cancelQueuedWaitResume } from "./wait-resume.ts";

export type SessionTerminateReason = "stop" | "close" | "remove" | "abort";

export interface SessionTerminateDeps {
  bus: Bus;
  forEachLeaderTaskState?: (
    fn: (leaderKey: string, taskState: TaskManagerState) => void,
  ) => void;
  wakeWaitingLeaderIfAllChildrenTerminal?: (leaderKey: string) => void;
  /** Terminate another live session by key (used by leader child cleanup). */
  terminateSession?: (sessionKey: string, reason: SessionTerminateReason) => void;
}

export async function terminateSessionHost(
  host: SessionHost,
  deps: SessionTerminateDeps | null,
  reason: SessionTerminateReason,
): Promise<void> {
  const hadWaitTimer = host.waitTimerId !== null;
  host.clearWaitTimer();
  cancelQueuedWaitResume(host);
  if (host.taskState?.pendingWait) {
    host.taskState.pendingWait = null;
    persistTaskState(host.id, host.taskState);
  }
  if (hadWaitTimer && deps) {
    deps.bus.emitToSession(host.id, {
      type: "wait_state",
      sessionKey: host.id,
      action: "cancelled",
      reason: `Session ${reason}`,
      timestamp: Date.now(),
    });
  }

  // Capture the close promise BEFORE nulling runControl so we can await it
  // after the synchronous teardown is complete.
  let closePromise: Promise<void> | undefined;
  if ((reason === "close" || reason === "remove") && host.runControl?.close) {
    closePromise = host.runControl.close();
  } else {
    host.runControl?.abort();
  }
  host.abortController.abort();
  host.status = "stopped";
  host.eventStream = null;
  host.runControl = null;
  host.persist();

  const event = {
    type: "session_status",
    sessionKey: host.id,
    status: "stopped",
    timestamp: Date.now(),
  };
  host.bufferEvent(event);
  deps?.bus.emitToSession(host.id, event);

  if (host.role === "minion" && deps) {
    applySessionEndedForMinion({
      bus: deps.bus,
      minionSessionKey: host.id,
      reason,
      forEachLeaderTaskState: deps.forEachLeaderTaskState,
      onAfterLifecycle: deps.wakeWaitingLeaderIfAllChildrenTerminal,
    });
  }

  // Role-specific session teardown (e.g. a leader aborting its still-running
  // minions on close/remove). This is the ONLY place agent types observe
  // session termination — run completion (`onComplete` on a `done` event)
  // must never be used for teardown of children.
  if (deps) {
    getAgentTypeOrDefault(host.role).onTerminate?.(
      {
        sessionKey: host.id,
        cwd: host.cwd,
        bus: deps.bus,
        worktreeInfo: host.worktree ?? null,
        worktreeIsolation: host.worktreeIsolation,
        ...(deps.terminateSession
          ? { terminateSession: deps.terminateSession }
          : {}),
        ...(deps.forEachLeaderTaskState
          ? { forEachLeaderTaskState: deps.forEachLeaderTaskState }
          : {}),
        ...(deps.wakeWaitingLeaderIfAllChildrenTerminal
          ? {
              wakeWaitingLeaderIfAllChildrenTerminal:
                deps.wakeWaitingLeaderIfAllChildrenTerminal,
            }
          : {}),
      },
      reason,
    );
  }

  // Await orderly harness shutdown (close releases SDK resources such as
  // stdio handles or HTTP connections). All synchronous teardown above has
  // already completed at this point, so awaiting here is safe.
  if (closePromise !== undefined) await closePromise;
}
