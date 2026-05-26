import type { Bus } from "./bus.ts";
import type { SessionHost } from "./session-host.ts";
import type { TaskManagerState } from "./task-tools/types.ts";
import { applySessionEndedForMinion } from "./task-lifecycle.ts";
import { persistTaskState } from "./session-persist.ts";

export type SessionTerminateReason = "stop" | "close" | "remove" | "abort";

export interface SessionTerminateDeps {
  bus: Bus;
  forEachLeaderTaskState?: (
    fn: (leaderKey: string, taskState: TaskManagerState) => void,
  ) => void;
  wakeWaitingLeaderIfAllChildrenTerminal?: (leaderKey: string) => void;
}

export function terminateSessionHost(
  host: SessionHost,
  deps: SessionTerminateDeps | null,
  reason: SessionTerminateReason,
): void {
  const hadWaitTimer = host.waitTimerId !== null;
  host.clearWaitTimer();
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

  if ((reason === "close" || reason === "remove") && host.runControl?.close)
    void host.runControl.close();
  else host.runControl?.abort();
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
}
