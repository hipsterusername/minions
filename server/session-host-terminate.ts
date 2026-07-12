import type { Bus } from "./bus.ts";
import type { SessionHost } from "./session-host.ts";
import type { TaskManagerState } from "./task-tools/types.ts";
import { applySessionEndedForMinion } from "./task-lifecycle.ts";
import { persistTaskState } from "./session-persist.ts";
import { getAgentTypeOrDefault } from "./agents/index.ts";
import { cancelQueuedWaitResume } from "./wait-resume.ts";
import { commitReviewLifecycle, finishRun } from "./session-review-lifecycle.ts";
import type { WorkItemRuntimeLifecycle } from "./session-host-types.ts";
import { notifyRuntimeTerminal } from "./session-host-identity.ts";

export type SessionTerminateReason = "stop" | "close" | "remove" | "abort";

export interface SessionTerminateDeps {
  bus: Bus;
  forEachLeaderTaskState?: (
    fn: (leaderKey: string, taskState: TaskManagerState) => void,
  ) => void;
  wakeWaitingLeaderIfAllChildrenTerminal?: (leaderKey: string) => void;
  /** Terminate another live session by key (used by leader child cleanup). */
  terminateSession?: (sessionKey: string, reason: SessionTerminateReason) => void;
  workItemLifecycle?: WorkItemRuntimeLifecycle;
  cleanupLiveEditRun?: (runKey: string) => void;
}

function hasTerminalReviewOutcome(host: SessionHost): boolean {
  const lifecycle = host.reviewLifecycle;
  return lifecycle.terminalReason !== null || [
    "completion_to_review",
    "error_to_review",
    "interrupted_to_review",
  ].includes(lifecycle.reviewState);
}

function hasOpenWaitEvidence(host: SessionHost, deps: SessionTerminateDeps | null): boolean {
  if (host.reviewLifecycle.reviewState === "decision_needed" || host.waitTimerId !== null
    || Boolean(host.taskState?.pendingWait)) return true;
  let blocked = false;
  deps?.forEachLeaderTaskState?.((_leaderKey, state) => {
    if ([...state.tasks.values()].some((task) =>
      task.minionSessionKey === host.id && task.status === "blocked")) blocked = true;
  });
  return blocked;
}

export async function terminateSessionHost(
  host: SessionHost,
  deps: SessionTerminateDeps | null,
  reason: SessionTerminateReason,
): Promise<void> {
  // Capture openness before teardown changes the runtime status. Termination
  // may stop an already-idle host, but it must only seal a genuinely live run.
  const shouldSealInterrupted = !hasTerminalReviewOutcome(host)
    && (host.status === "running" || (Boolean(host.workItemId)
      && !host.runtimeTerminalNotified && hasOpenWaitEvidence(host, deps)));
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
  // Abort paths deliberately leave claims to the harness stream finalizer.
  // Merely signalling abort is not proof that an in-flight mutation process
  // has stopped. Close paths release below only after close() acknowledges.
  host.status = "stopped";
  host.eventStream = null;
  host.runControl = null;
  if (reason !== "remove" && deps && shouldSealInterrupted) {
    commitReviewLifecycle(host, deps.bus, finishRun(host.reviewLifecycle, {
      reason: reason === "stop" ? "stop" : "abort",
      at: Date.now(),
    }));
    notifyRuntimeTerminal(host, deps.workItemLifecycle, {
      outcome: "interrupted", finalReportId: null, finalReport: null, at: Date.now(),
    });
  }
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
  if (closePromise !== undefined) {
    await closePromise;
    deps?.cleanupLiveEditRun?.(host.runKey);
  }
}
