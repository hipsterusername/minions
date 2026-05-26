import { beforeEach, describe, expect, it } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus } from "../bus.ts";
import { disablePersistence } from "../session-persist.ts";
import type { TaskManagerState } from "../task-tools.ts";
import { getAgentType } from "./registry.ts";
import "./minion.ts";

beforeEach(() => disablePersistence());

function parentTaskState(): TaskManagerState {
  return {
    tasks: new Map([
      [
        "t1",
        {
          taskId: "t1",
          title: "T1",
          description: "",
          priority: "medium",
          executor: "minion",
          minionSessionKey: "minion-1",
          leaderSessionKey: "leader-1",
          status: "running",
          createdAt: Date.now(),
          completedAt: null,
          result: null,
        },
      ],
    ]),
    pendingWait: null,
    approval: null,
  };
}

describe("minion task lifecycle", () => {
  it("marks a clean minion completion without report_done as ended_without_report", async () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const taskState = parentTaskState();
    const minion = getAgentType("minion");
    const ctx = {
      sessionKey: "minion-1",
      cwd: "/tmp/project",
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
      forEachLeaderTaskState: (
        fn: (leaderKey: string, state: TaskManagerState) => void,
      ) => fn("leader-1", taskState),
    };

    await minion.onComplete?.(ctx, { is_error: false, result: "quiet" });

    expect(taskState.tasks.get("t1")?.status).toBe("ended_without_report");
  });
});
