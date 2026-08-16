import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { WebSocketServer } from "ws";
import { createBus } from "./bus.ts";
import { SessionHost } from "./session-host.ts";
import { disablePersistence } from "./session-persist.ts";
import { hydrateLeaderTaskState } from "./session-task-state-persist.ts";
import { recoverDurableWorkflowState } from "./session-registry-recovery.ts";
import type { TaskRecord } from "./task-tools/types.ts";

function record(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "task-1",
    title: "Task",
    description: "",
    priority: "medium",
    executor: "minion",
    minionSessionKey: "minion-1",
    leaderSessionKey: "leader-1",
    status: "running",
    createdAt: 1,
    completedAt: null,
    result: null,
    ...over,
  };
}

describe("durable delegated workflow recovery", () => {
  beforeEach(() => {
    disablePersistence();
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads a legacy snapshot and derives stable attempt and wait cohort fields", () => {
    const running = record({ timeoutDeadlineAt: 5_000, timeoutMs: 4_000 });
    const completed = record({
      taskId: "done",
      minionSessionKey: "minion-done",
      status: "completed",
      completedAt: 900,
    });
    const hydrated = hydrateLeaderTaskState({} as Database.Database, {
      session_key: "leader-1",
      approval_json: null,
      task_state_json: JSON.stringify({
        tasks: [running, completed],
        pendingWait: {
          durationMs: 10_000,
          reason: "join",
          scheduledAt: 500,
          timerId: null,
          wakeOn: "all_terminal",
        },
      }),
    });

    expect(hydrated.tasks.get("task-1")).toMatchObject({
      attempt: 1,
      attemptGeneration: 1,
      timeoutDeadlineAt: 5_000,
    });
    expect(hydrated.tasks.get("task-1")?.attemptId).toContain("legacy:leader-1:task-1:1");
    expect(hydrated.pendingWait?.taskIds).toEqual(["done", "task-1"]);
  });

  it("reattaches a live child and restores its original absolute deadline", () => {
    const leader = new SessionHost("leader-1", "/tmp/work");
    leader.role = "leader";
    leader.taskState = {
      tasks: new Map([["task-1", record({
        attemptId: "attempt-1",
        attemptGeneration: 1,
        timeoutMs: 500,
        timeoutDeadlineAt: 1_500,
      })]]),
      pendingWait: null,
      approval: null,
    };
    const child = new SessionHost("minion-1", "/tmp/work");
    child.role = "minion";
    const sessions = new Map([[leader.id, leader], [child.id, child]]);
    const terminateSession = vi.fn();

    recoverDurableWorkflowState({
      sessions,
      getSession: (key) => sessions.get(key),
      deps: {
        bus: createBus({ clients: new Set() } as unknown as WebSocketServer),
        startChildSession: vi.fn(),
        forEachLeaderTaskState: () => {},
        terminateSession,
      },
      wakeLeader: vi.fn(),
    });

    expect(leader.taskState.tasks.get("task-1")?.status).toBe("running");
    vi.advanceTimersByTime(499);
    expect(leader.taskState.tasks.get("task-1")?.status).toBe("running");
    vi.advanceTimersByTime(1);
    expect(leader.taskState.tasks.get("task-1")?.status).toBe("failed");
    expect(terminateSession).toHaveBeenCalledWith("minion-1", "abort");
  });
});
