import { describe, expect, it, vi } from "vitest";
import {
  isTerminalTaskStatus,
  reduceTaskLifecycle,
  scheduleTaskTimeout,
  type TaskLifecycleEvent,
} from "./task-lifecycle.ts";
import type { Bus } from "./bus.ts";
import type { TaskRecord, TaskStatus } from "./task-tools/types.ts";

const openStatuses: TaskStatus[] = ["planned", "starting", "running"];
const terminalStatuses: TaskStatus[] = [
  "completed",
  "failed",
  "ended_without_report",
  "cancelled",
  "orphaned",
];

function task(status: TaskStatus): TaskRecord {
  return {
    taskId: "t1",
    title: "Task",
    description: "",
    priority: "medium",
    executor: "leader",
    minionSessionKey: null,
    leaderSessionKey: "leader-1",
    status,
    createdAt: 1,
    completedAt: null,
    result: null,
  };
}

describe("task lifecycle reducer", () => {
  it("classifies terminal states", () => {
    for (const status of openStatuses) {
      expect(isTerminalTaskStatus(status)).toBe(false);
    }
    for (const status of terminalStatuses) {
      expect(isTerminalTaskStatus(status)).toBe(true);
    }
  });

  it("covers every lifecycle event from every open state", () => {
    const cases: Array<[TaskLifecycleEvent, TaskStatus]> = [
      [{ type: "assigned", minionSessionKey: "m1" }, "starting"],
      [{ type: "session_starting", minionSessionKey: "m1" }, "starting"],
      [{ type: "session_running" }, "running"],
      [{ type: "reported_step" }, "running"],
      [{ type: "reported_done", result: "done", timestamp: 10 }, "completed"],
      [{ type: "reported_fail", result: "fail", timestamp: 10 }, "failed"],
      [{ type: "leader_completed", result: "done", timestamp: 10 }, "completed"],
      [{ type: "session_ended", reason: "clean", timestamp: 10 }, "ended_without_report"],
      [{ type: "session_ended", reason: "error", timestamp: 10 }, "failed"],
      [{ type: "session_ended", reason: "stop", timestamp: 10 }, "cancelled"],
      [{ type: "session_ended", reason: "close", timestamp: 10 }, "cancelled"],
      [{ type: "session_ended", reason: "remove", timestamp: 10 }, "cancelled"],
      [{ type: "session_ended", reason: "abort", timestamp: 10 }, "cancelled"],
      [{ type: "rehydrated_orphan", timestamp: 10 }, "orphaned"],
      [{ type: "timeout", timestamp: 10 }, "failed"],
      [{ type: "parent_terminated", timestamp: 10 }, "cancelled"],
      [{ type: "discarded", timestamp: 10 }, "cancelled"],
    ];

    for (const status of openStatuses) {
      for (const [event, expected] of cases) {
        expect(reduceTaskLifecycle(task(status), event, 99).status).toBe(expected);
      }
    }
  });

  it("makes terminal states absorbing for late events", () => {
    const lateEvents: TaskLifecycleEvent[] = [
      { type: "session_running" },
      { type: "reported_done", result: "late" },
      { type: "reported_fail", result: "late" },
      { type: "session_ended", reason: "error" },
      { type: "discarded" },
    ];

    for (const status of terminalStatuses) {
      for (const event of lateEvents) {
        const original = task(status);
        expect(reduceTaskLifecycle(original, event)).toBe(original);
      }
    }
  });

  it("treats quiet clean session end as ended_without_report", () => {
    const next = reduceTaskLifecycle(task("running"), {
      type: "session_ended",
      reason: "clean",
      timestamp: 123,
    });

    expect(next.status).toBe("ended_without_report");
    expect(next.completedAt).toBe(123);
    expect(next.result).toContain("without a minion report");
  });

  it("fails a nonterminal task when its soft timeout fires", () => {
    vi.useFakeTimers();
    try {
      const state = { tasks: new Map([["t1", task("running")]]), pendingWait: null, approval: null };
      const bus = { emitToSession: vi.fn() } as unknown as Bus;
      const onStateChange = vi.fn();
      const onTimeout = vi.fn();

      scheduleTaskTimeout({
        bus,
        leaderSessionKey: "leader-1",
        taskState: state,
        taskId: "t1",
        timeoutMs: 100,
        onStateChange,
        onTimeout,
      });
      vi.advanceTimersByTime(100);

      expect(state.tasks.get("t1")?.status).toBe("failed");
      expect(state.tasks.get("t1")?.result).toContain("timed out");
      expect(onStateChange).toHaveBeenCalledWith(state);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
