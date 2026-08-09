/**
 * terminateSessionHost — role-specific teardown wiring.
 *
 * The leader's child-task sweep must run only from `onTerminate`, not from
 * per-turn completion. Otherwise pausing via wait_and_continue would abort
 * still-running minions.
 *
 * These tests pin the wiring end-to-end at the terminate entry point:
 *   - real SessionHost (no harness run needed — terminate is synchronous
 *     state teardown)
 *   - real bus over a fake WebSocketServer
 *   - persistence disabled via the production toggle
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocketServer } from "ws";

import { SessionHost } from "./session-host.ts";
import {
  terminateSessionHost,
  type SessionTerminateReason,
} from "./session-host-terminate.ts";
import { createBus } from "./bus.ts";
import { disablePersistence, closePersistDb } from "./session-persist.ts";
import type { TaskManagerState } from "./task-tools/types.ts";
import type { HarnessRunControl } from "./harness/types.ts";
import {
  beginRun,
  finishRun,
  initialSessionReviewLifecycle,
} from "./session-review-lifecycle.ts";
import "./agents/index.ts"; // registers agent types

beforeEach(() => disablePersistence());
afterEach(() => closePersistDb());

function makeLeaderFixture() {
  const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
  const host = new SessionHost("leader-1", "/tmp/project");
  host.role = "leader";

  const taskState: TaskManagerState = {
    tasks: new Map([
      [
        "running-child",
        {
          taskId: "running-child",
          title: "Running child",
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

  const terminations: Array<[string, SessionTerminateReason]> = [];
  const deps = {
    bus,
    terminateSession: (sessionKey: string, reason: SessionTerminateReason) =>
      terminations.push([sessionKey, reason]),
    forEachLeaderTaskState: (
      fn: (leaderKey: string, state: TaskManagerState) => void,
    ) => fn("leader-1", taskState),
  };

  return { host, deps, taskState, terminations };
}

describe("terminateSessionHost — leader child cleanup", () => {
  it("notifies stopped exactly once for a genuinely open bound run", async () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const host = new SessionHost("run-1", "/tmp");
    host.workItemId = "work-1";
    host.status = "running";
    const runTerminal = vi.fn();
    const lifecycle = {
      providerInitialized: vi.fn(), runStarted: vi.fn(), runWaiting: vi.fn(), runTerminal,
    };
    await terminateSessionHost(host, { bus, workItemLifecycle: lifecycle }, "stop");
    await terminateSessionHost(host, { bus, workItemLifecycle: lifecycle }, "abort");
    expect(runTerminal).toHaveBeenCalledOnce();
    expect(runTerminal).toHaveBeenCalledWith(expect.objectContaining({ outcome: "stopped" }));
  });

  it("cleans volatile live-edit claims after orderly close acknowledges", async () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const host = new SessionHost("cleanup-run", "/tmp"); host.status = "running";
    host.runControl = { abort: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    const cleanupLiveEditRun = vi.fn();
    await terminateSessionHost(host, { bus, cleanupLiveEditRun }, "close");
    expect(cleanupLiveEditRun).toHaveBeenCalledWith("cleanup-run");
  });

  it("does not release volatile claims merely because abort was signalled", async () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const host = new SessionHost("ordered-cleanup", "/tmp"); host.status = "running";
    const order: string[] = [];
    host.runControl = { abort: () => order.push("abort") } as never;
    await terminateSessionHost(host, { bus, cleanupLiveEditRun: () => order.push("cleanup") }, "abort");
    expect(order).toEqual(["abort"]);
  });

  it.each(["decision", "timer", "blocked"] as const)(
    "seals an idle bound run with open %s evidence as stopped on deliberate stop",
    async (kind) => {
      const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
      const host = new SessionHost(`idle-${kind}`, "/tmp");
      host.workItemId = "work-1"; host.status = "idle";
      if (kind === "decision") host.reviewLifecycle = {
        ...host.reviewLifecycle, reviewState: "decision_needed",
      };
      if (kind === "timer") host.taskState = { tasks: new Map(),
        pendingWait: { durationMs: 10, reason: "wait", scheduledAt: 1, timerId: null }, approval: null };
      const runTerminal = vi.fn();
      const taskState = { tasks: new Map(kind === "blocked" ? [["t", {
        taskId: "t", minionSessionKey: host.id, status: "blocked",
      } as never]] : []), pendingWait: null, approval: null };
      await terminateSessionHost(host, { bus,
        forEachLeaderTaskState: (fn) => fn("leader", taskState),
        workItemLifecycle: { providerInitialized: vi.fn(), runStarted: vi.fn(),
          runWaiting: vi.fn(), runTerminal } }, "stop");
      expect(runTerminal).toHaveBeenCalledWith(expect.objectContaining({ outcome: "stopped" }));
    },
  );

  it("aborts running minion children when the leader is removed", () => {
    const { host, deps, taskState, terminations } = makeLeaderFixture();

    terminateSessionHost(host, deps, "remove");

    expect(terminations).toEqual([["minion-1", "abort"]]);
    expect(taskState.tasks.get("running-child")?.status).toBe("cancelled");
    expect(host.status).toBe("stopped");
  });

  it("aborts running minion children when the leader is closed", () => {
    const { host, deps, terminations } = makeLeaderFixture();

    terminateSessionHost(host, deps, "close");

    expect(terminations).toEqual([["minion-1", "abort"]]);
  });

  it("leaves children running when the leader is merely stopped", () => {
    const { host, deps, taskState, terminations } = makeLeaderFixture();

    terminateSessionHost(host, deps, "stop");

    expect(terminations).toEqual([]);
    expect(taskState.tasks.get("running-child")?.status).toBe("running");
    expect(host.status).toBe("stopped");
  });

  it("leaves children running when the leader's run is aborted", () => {
    const { host, deps, taskState, terminations } = makeLeaderFixture();

    terminateSessionHost(host, deps, "abort");

    expect(terminations).toEqual([]);
    expect(taskState.tasks.get("running-child")?.status).toBe("running");
  });
});

// ── Bug-regression: terminate awaits close (Bug 4) ───────────────────────────

describe("terminateSessionHost — awaits harness close", () => {
  it("returns a promise that resolves only after the harness close() resolves", async () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const host = new SessionHost("host-close", "/tmp");
    const deps = { bus };

    let resolveClose!: () => void;
    let closeCalled = false;

    const fakeRunControl: HarnessRunControl = {
      abort: vi.fn(),
      close: () => {
        closeCalled = true;
        return new Promise<void>((r) => {
          resolveClose = r;
        });
      },
    };
    host.runControl = fakeRunControl;

    const terminatePromise = terminateSessionHost(host, deps, "close");

    // Synchronous teardown already happened (status is stopped).
    expect(host.status).toBe("stopped");
    expect(closeCalled).toBe(true);

    // Promise is still pending — waiting for close() to settle.
    let terminated = false;
    const done = terminatePromise.then(() => {
      terminated = true;
    });

    await Promise.resolve(); // flush microtasks
    expect(terminated).toBe(false);

    // Resolve the underlying close.
    resolveClose();
    await done;
    expect(terminated).toBe(true);
  });

  it("resolves immediately when there is no runControl to close", async () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const host = new SessionHost("host-no-ctrl", "/tmp");
    const deps = { bus };

    // runControl is null — nothing to await.
    await expect(terminateSessionHost(host, deps, "stop")).resolves.toBeUndefined();
    expect(host.status).toBe("stopped");
  });

  it("uses abort() instead of close() for stop/abort reasons even when close is available", async () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const host = new SessionHost("host-abort-ctrl", "/tmp");
    const deps = { bus };

    const abortFn = vi.fn();
    const closeFn = vi.fn().mockResolvedValue(undefined);
    host.runControl = { abort: abortFn, close: closeFn };

    await terminateSessionHost(host, deps, "stop");

    expect(abortFn).toHaveBeenCalledOnce();
    expect(closeFn).not.toHaveBeenCalled();
  });
});

describe("terminateSessionHost — terminal review immutability", () => {
  it.each(["stop", "close", "abort"] as const)(
    "preserves a completed outcome on %s",
    async (reason) => {
      const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
      const host = new SessionHost(`completed-${reason}`, "/tmp");
      host.reviewLifecycle = finishRun(beginRun(initialSessionReviewLifecycle()), {
        reason: "completed",
        report: "Finished successfully",
        at: 10,
      });
      const terminal = host.reviewLifecycle;

      await terminateSessionHost(host, { bus }, reason);

      expect(host.reviewLifecycle).toBe(terminal);
      expect(host.reviewLifecycle).toMatchObject({
        reviewState: "completion_to_review",
        terminalReason: "completed",
        finalReport: "Finished successfully",
      });
    },
  );

  it.each(["stop", "close", "abort"] as const)(
    "preserves an error outcome on %s",
    async (reason) => {
      const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
      const host = new SessionHost(`error-${reason}`, "/tmp");
      host.status = "error";
      host.reviewLifecycle = finishRun(beginRun(initialSessionReviewLifecycle()), {
        reason: "error",
        report: "Provider failed",
        at: 10,
      });
      const terminal = host.reviewLifecycle;

      await terminateSessionHost(host, { bus }, reason);

      expect(host.reviewLifecycle).toBe(terminal);
      expect(host.reviewLifecycle).toMatchObject({
        reviewState: "error_to_review",
        terminalReason: "error",
      });
    },
  );

  it("seals a genuinely open run as interrupted", async () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const host = new SessionHost("open-run", "/tmp");
    host.status = "running";
    host.reviewLifecycle = beginRun(initialSessionReviewLifecycle());

    await terminateSessionHost(host, { bus }, "stop");

    expect(host.reviewLifecycle).toMatchObject({
      reviewState: "interrupted_to_review",
      terminalReason: "stop",
    });
  });
});
