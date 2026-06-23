/**
 * session-wake — wake-worthiness predicate + leader digest builder.
 *
 * A blocked child must count as wake-worthy (the leader has to answer it) even
 * though it is not terminal, and the digest must surface its pending question.
 */
import { describe, expect, it } from "vitest";
import { buildTaskDigest, isWakeWorthyStatus } from "./session-wake.ts";
import type { TaskRecord, TaskStatus } from "./task-tools/types.ts";

function task(status: TaskStatus, over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "t1",
    title: "Task",
    description: "",
    priority: "medium",
    executor: "minion",
    minionSessionKey: "m-1",
    leaderSessionKey: "leader-1",
    status,
    createdAt: 1,
    completedAt: null,
    result: null,
    ...over,
  };
}

describe("isWakeWorthyStatus", () => {
  it("treats every terminal status as wake-worthy", () => {
    for (const s of [
      "completed",
      "failed",
      "ended_without_report",
      "cancelled",
      "orphaned",
    ] as TaskStatus[]) {
      expect(isWakeWorthyStatus(s)).toBe(true);
    }
  });

  it("treats blocked as wake-worthy even though it is non-terminal", () => {
    expect(isWakeWorthyStatus("blocked")).toBe(true);
  });

  it("does not treat in-flight statuses as wake-worthy", () => {
    for (const s of ["planned", "starting", "running"] as TaskStatus[]) {
      expect(isWakeWorthyStatus(s)).toBe(false);
    }
  });
});

describe("buildTaskDigest", () => {
  it("renders a blocked task's pending question and includes it regardless of sinceMs", () => {
    const tasks = [
      task("blocked", { taskId: "b1", lastStep: "Which DB driver?" }),
    ];
    const digest = buildTaskDigest(tasks, 10_000);
    expect(digest).toBe("b1 — blocked — Which DB driver?");
  });

  it("renders terminal tasks with their result and gates them by sinceMs", () => {
    const tasks = [
      task("completed", { taskId: "c1", result: "done", completedAt: 5_000 }),
      task("completed", { taskId: "c2", result: "later", completedAt: 20_000 }),
    ];
    const digest = buildTaskDigest(tasks, 10_000);
    // c1 completed before the window → excluded; c2 after → included.
    expect(digest).toBe("c2 — completed — later");
  });

  it("combines blocked and terminal tasks", () => {
    const tasks = [
      task("blocked", { taskId: "b1", lastStep: "stuck" }),
      task("failed", { taskId: "f1", result: "boom", completedAt: 50 }),
    ];
    const digest = buildTaskDigest(tasks);
    expect(digest).toBe("b1 — blocked — stuck\nf1 — failed — boom");
  });
});
