/**
 * Unit tests for buildSessionContext.
 *
 * Covers the session-restart context builder, including the regression for
 * undefined taskPlan (nodes serialised before the field was added).
 */

import { describe, it, expect } from "vitest";
import { buildSessionContext } from "./LeaderNode.tsx";
import type { TaskPlanItem } from "./LeaderNode.tsx";
import type { DisplayMessage } from "../sdk-messages.ts";

// ── Fixture helpers ───────────────────────────────────────────────────────────

function msg(
  role: DisplayMessage["role"],
  content: string,
  id = "m-1",
): DisplayMessage {
  return { id, role, content, timestamp: 0 };
}

function task(
  overrides: Partial<TaskPlanItem> = {},
): TaskPlanItem {
  return {
    taskId: "t-1",
    title: "Do something",
    description: "Details",
    priority: "medium",
    status: "planned",
    executor: "leader",
    minionSessionKey: null,
    result: null,
    cost: 0,
    createdAt: 0,
    completedAt: null,
    sessionSummary: "",
    ...overrides,
  };
}

// ── buildSessionContext ───────────────────────────────────────────────────────

describe("buildSessionContext", () => {
  it("returns empty string when both messages and taskPlan are empty", () => {
    expect(buildSessionContext([], [])).toBe("");
  });

  it("returns empty string when messages have no meaningful content", () => {
    const messages = [msg("tool", ""), msg("system", "   ")];
    expect(buildSessionContext(messages, [])).toBe("");
  });

  // Regression: nodes serialised before taskPlan was added have undefined here.
  it("does not throw when taskPlan is undefined (legacy node data)", () => {
    const messages = [msg("user", "hello")];
    // Simulate legacy data by casting — the real bug was passing undefined
    const legacyTaskPlan = undefined as unknown as TaskPlanItem[];
    expect(() => buildSessionContext(messages, legacyTaskPlan)).not.toThrow();
  });

  it("returns empty string when taskPlan is undefined and messages are empty", () => {
    const legacyTaskPlan = undefined as unknown as TaskPlanItem[];
    expect(buildSessionContext([], legacyTaskPlan)).toBe("");
  });

  it("includes conversation entries from user and assistant messages", () => {
    const messages = [
      msg("user", "What is the plan?", "m-1"),
      msg("assistant", "Here is the plan.", "m-2"),
    ];
    const result = buildSessionContext(messages, []);
    expect(result).toContain("[user]: What is the plan?");
    expect(result).toContain("[assistant]: Here is the plan.");
    expect(result).toContain("<previous-session-context>");
  });

  it("excludes tool and thinking messages from conversation entries", () => {
    const messages = [
      msg("tool", "tool output"),
      msg("thinking", "internal thought"),
      msg("user", "visible message"),
    ];
    const result = buildSessionContext(messages, []);
    expect(result).not.toContain("tool output");
    expect(result).not.toContain("internal thought");
    expect(result).toContain("visible message");
  });

  it("includes task plan when tasks are present", () => {
    const plan = [
      task({ status: "completed", title: "Done task", result: "success" }),
      task({ taskId: "t-2", status: "planned", title: "Pending task" }),
    ];
    const result = buildSessionContext([], plan);
    expect(result).toContain("Done task");
    expect(result).toContain("Pending task");
    expect(result).toContain("<task-plan>");
  });

  it("includes session name when provided", () => {
    const result = buildSessionContext(
      [msg("user", "hi")],
      [],
      "My Test Session",
    );
    expect(result).toContain("My Test Session");
  });

  it("truncates messages longer than 2000 characters", () => {
    const long = "x".repeat(2100);
    const messages = [msg("user", long)];
    const result = buildSessionContext(messages, []);
    expect(result).toContain("…");
    // The truncated portion should not appear
    expect(result.length).toBeLessThan(long.length + 500);
  });
});
