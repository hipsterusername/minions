/**
 * terminateSessionHost — role-specific teardown wiring.
 *
 * Regression (2026-06): the leader's child-task sweep used to run from
 * `onComplete` (fired on every `done` event, i.e. every leader turn). That
 * aborted all running minions the moment the leader paused via
 * wait_and_continue. The sweep now runs from `onTerminate`, invoked ONLY by
 * `terminateSessionHost`, and only acts on close/remove.
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
