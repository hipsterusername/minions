import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBus } from "./bus.ts";
import { SessionHost } from "./session-host.ts";
import { processNormalizedEvent } from "./session-host-run.ts";
import { disablePersistence } from "./session-persist.ts";
import { initialSessionReviewLifecycle, requestDecision } from "./session-review-lifecycle.ts";
import type { AgentType, AgentTypeContext } from "./agents/types.ts";
import type { WorkItemRuntimeLifecycle } from "./session-host-types.ts";

function fixture() {
  const bus = createBus({ clients: new Set() } as never);
  const host = new SessionHost("run-1", "/repo");
  host.workItemId = "work-1";
  host.seedRunLineage({ runKind: "primary" });
  host.status = "running";
  const hooks: WorkItemRuntimeLifecycle = {
    providerInitialized: vi.fn(), runStarted: vi.fn(), runWaiting: vi.fn(), runTerminal: vi.fn(),
  };
  const agent: AgentType = {
    id: "default", wantsWorktree: false, buildSystemPrompt: () => undefined,
    getToolGroups: () => ({ toolGroups: {}, mcpToolNames: [] }),
  };
  const ctx = {
    sessionKey: host.id, workItemId: host.workItemId, runKey: host.runKey, taskId: null,
    cwd: host.cwd, bus, worktreeInfo: null, worktreeIsolation: false,
  } as AgentTypeContext;
  return { bus, host, hooks, agent, ctx };
}

beforeEach(() => disablePersistence());

describe("work-item runtime lifecycle disposition", () => {
  it("reports provider init and normal durable completion", () => {
    const f = fixture();
    f.ctx.cleanupLiveEditRun = vi.fn();
    processNormalizedEvent(f.host, f.bus, f.agent, f.ctx, { kind: "init", sessionId: "provider-1", model: "m" }, f.hooks);
    processNormalizedEvent(f.host, f.bus, f.agent, f.ctx, { kind: "done", reason: "completed", result: "Done" }, f.hooks);
    expect(f.hooks.providerInitialized).toHaveBeenCalledWith(expect.objectContaining({ providerSessionId: "provider-1" }));
    expect(f.hooks.runStarted).toHaveBeenCalledOnce();
    expect(f.hooks.runTerminal).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "completed", finalReportId: "run-1:final-report", finalReport: "Done",
    }));
    expect(f.ctx.cleanupLiveEditRun).toHaveBeenCalledWith("run-1");
  });

  it("emits idempotent ensure-working signals for provider continuation init", () => {
    const f = fixture();
    processNormalizedEvent(f.host, f.bus, f.agent, f.ctx, { kind: "init", sessionId: "provider-1", model: "m" }, f.hooks);
    processNormalizedEvent(f.host, f.bus, f.agent, f.ctx, { kind: "init", sessionId: "provider-2", model: "m" }, f.hooks);
    expect(f.hooks.runStarted).toHaveBeenCalledTimes(2);
    expect(f.hooks.providerInitialized).toHaveBeenLastCalledWith(
      expect.objectContaining({ providerSessionId: "provider-2" }),
    );
  });

  it("keeps decision and timer waits open without overwriting legacy review", () => {
    const decision = fixture();
    decision.host.reviewLifecycle = requestDecision(initialSessionReviewLifecycle(), "Choose");
    processNormalizedEvent(decision.host, decision.bus, decision.agent, decision.ctx, { kind: "done", reason: "stop" }, decision.hooks);
    expect(decision.hooks.runTerminal).not.toHaveBeenCalled();
    expect(decision.host.reviewLifecycle.reviewState).toBe("decision_needed");

    const timer = fixture();
    timer.host.taskState = { tasks: new Map(), pendingWait: { durationMs: 5, reason: "wait", scheduledAt: 1, timerId: null }, approval: null };
    processNormalizedEvent(timer.host, timer.bus, timer.agent, timer.ctx, { kind: "done", reason: "stop" }, timer.hooks);
    expect(timer.hooks.runTerminal).not.toHaveBeenCalled();
    expect(timer.host.reviewLifecycle.terminalAt).toBeNull();
  });

  it("keeps blocked children and synchronous report nudges open", () => {
    const blocked = fixture();
    blocked.ctx.forEachLeaderTaskState = (fn) => fn("leader", {
      tasks: new Map([["t", { taskId: "t", minionSessionKey: "run-1", status: "blocked" } as never]]),
      pendingWait: null, approval: null,
    });
    processNormalizedEvent(blocked.host, blocked.bus, blocked.agent, blocked.ctx, { kind: "done", reason: "stop" }, blocked.hooks);
    expect(blocked.hooks.runWaiting).toHaveBeenCalledWith(expect.objectContaining({ waitKind: "blocked" }));

    const nudge = fixture();
    nudge.agent.onComplete = () => { nudge.host.status = "running"; };
    processNormalizedEvent(nudge.host, nudge.bus, nudge.agent, nudge.ctx, { kind: "done", reason: "stop" }, nudge.hooks);
    expect(nudge.hooks.runWaiting).toHaveBeenCalledWith(expect.objectContaining({ waitKind: "continuation" }));
    expect(nudge.hooks.runTerminal).not.toHaveBeenCalled();
  });

  it("seals terminal errors", () => {
    const f = fixture();
    processNormalizedEvent(f.host, f.bus, f.agent, f.ctx, { kind: "done", reason: "error", error: "boom" }, f.hooks);
    expect(f.hooks.runTerminal).toHaveBeenCalledWith(expect.objectContaining({ outcome: "error", finalReportId: null }));
  });

  it("treats a harness stop with a durable result as completed", () => {
    const f = fixture();
    processNormalizedEvent(f.host, f.bus, f.agent, f.ctx,
      { kind: "done", reason: "stop", result: " Durable report " }, f.hooks);
    expect(f.hooks.runTerminal).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "completed", finalReport: "Durable report",
    }));
    expect(f.host.reviewLifecycle).toMatchObject({
      reviewState: "completion_to_review", terminalReason: "completed",
      finalReport: "Durable report",
    });
  });

  it("retries terminal notification after a hook throws", () => {
    const f = fixture();
    const terminal = vi.mocked(f.hooks.runTerminal);
    terminal.mockImplementationOnce(() => { throw new Error("transient"); });
    expect(() => processNormalizedEvent(f.host, f.bus, f.agent, f.ctx,
      { kind: "done", reason: "completed", result: "Done" }, f.hooks)).toThrow("transient");
    expect(f.host.runtimeTerminalNotified).toBe(false);
    processNormalizedEvent(f.host, f.bus, f.agent, f.ctx,
      { kind: "done", reason: "completed", result: "Done" }, f.hooks);
    expect(terminal).toHaveBeenCalledTimes(2);
    expect(f.host.runtimeTerminalNotified).toBe(true);
  });

  it("prefers a child's durable parent task report and identity", () => {
    const f = fixture();
    f.host.runKind = "child"; f.host.parentRunKey = "leader"; f.host.taskId = "t";
    f.ctx.forEachLeaderTaskState = (fn) => fn("leader", {
      tasks: new Map([["t", { taskId: "t", minionSessionKey: "run-1",
        status: "completed", result: "Reported done" } as never]]),
      pendingWait: null, approval: null,
    });
    processNormalizedEvent(f.host, f.bus, f.agent, f.ctx,
      { kind: "done", reason: "stop", result: "provider summary" }, f.hooks);
    expect(f.hooks.runTerminal).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "completed", finalReport: "Reported done",
      finalReportId: "task:leader:t:report",
    }));
  });

  it("seals a child that ends with a provider final response but no durable report as completed", () => {
    const f = fixture();
    f.host.runKind = "child"; f.host.parentRunKey = "leader"; f.host.taskId = "t";
    // The leader task is still running — the minion never called report_done —
    // yet the agent produced a final response. This must seal as completed with
    // a real final-report id so the seal reducer does not downgrade it to
    // interrupted.
    f.ctx.forEachLeaderTaskState = (fn) => fn("leader", {
      tasks: new Map([["t", { taskId: "t", minionSessionKey: "run-1",
        status: "running", result: null } as never]]),
      pendingWait: null, approval: null,
    });
    processNormalizedEvent(f.host, f.bus, f.agent, f.ctx,
      { kind: "done", reason: "completed", result: "Final answer" }, f.hooks);
    expect(f.hooks.runTerminal).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "completed", finalReport: "Final answer",
      finalReportId: "run-1:final-report",
    }));
  });
});
