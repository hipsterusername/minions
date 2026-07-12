import { describe, expect, it, beforeEach } from "vitest";
import {
  consumeCheckpointHandoff,
  createCheckpointSessionToolDef,
  isCheckpointRequested,
  resetCheckpointSessionStateForTest,
  validateCheckpointBoundary,
} from "./checkpoint-session.ts";
import type { TaskToolContext } from "./types.ts";

function ctx(overrides: Partial<TaskToolContext> = {}): TaskToolContext {
  return {
    leaderSessionKey: "leader-1",
    bus: { emitToSession() {}, emitToProject() {}, emitGlobal() {}, emit() {}, subscribe: () => () => {} } as never,
    startMinionSession() {},
    cwd: "/repo",
    projectPath: "/repo",
    minionSystemPrompt: "minion",
    taskState: { tasks: new Map(), pendingWait: null, approval: null },
    scheduleWaitContinue() {},
    ...overrides,
  };
}

describe("checkpoint_session tool", () => {
  beforeEach(() => resetCheckpointSessionStateForTest());

  it("defers when approval is pending", async () => {
    const tool = createCheckpointSessionToolDef(ctx({
      taskState: {
        tasks: new Map(),
        pendingWait: null,
        approval: { requested: true, requestedAt: 1, summary: "review", diff: null },
      },
    }));

    const result = await tool.handler({});
    expect(result.content[0]!.text).toContain("deferred: approval is pending");
    expect(isCheckpointRequested("leader-1")).toBe(false);
  });

  it("marks a safe checkpoint request and is idempotent", async () => {
    const tool = createCheckpointSessionToolDef(ctx());

    const first = await tool.handler({});
    const second = await tool.handler({});

    expect(first.content[0]!.text).toContain("structured handoff");
    expect(second.content[0]!.text).toContain("already requested");
    expect(consumeCheckpointHandoff("leader-1")).toBe("");
  });

  it("detects pending forms when render components are supplied", () => {
    const boundary = validateCheckpointBoundary({
      taskState: { tasks: new Map(), pendingWait: null, approval: null },
      renderComponents: [{ id: "form-1", type: "form", fields: [] }],
    });

    expect(boundary).toEqual({ safe: false, reason: "form input is pending" });
  });

  it("wires live render state into tool boundary validation", async () => {
    const tool = createCheckpointSessionToolDef(ctx({
      getRenderComponents: () => [{ id: "form-1", type: "form", fields: [] }],
    }));
    const result = await tool.handler({});
    expect(result.content[0]!.text).toContain("deferred: form input is pending");
    expect(isCheckpointRequested("leader-1")).toBe(false);
  });
});
