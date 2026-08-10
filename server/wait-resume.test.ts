import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocketServer } from "ws";

import { createBus } from "./bus.ts";
import { SessionHost } from "./session-host.ts";
import { disablePersistence } from "./session-persist.ts";
import { pauseActiveRunForWait, requestWaitResume } from "./wait-resume.ts";

function waitingHost(): SessionHost {
  const host = new SessionHost("leader-1", "/tmp/work");
  host.status = "running";
  host.taskState = {
    tasks: new Map(),
    pendingWait: {
      durationMs: 30_000,
      reason: "waiting",
      scheduledAt: Date.now(),
      timerId: null,
    },
    approval: null,
  };
  return host;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("wait resume coordination", () => {
  it("interrupts the active run after a wait is recorded", async () => {
    vi.useFakeTimers();
    const host = waitingHost();
    const abort = vi.fn();
    const interrupt = vi.fn().mockResolvedValue(undefined);
    host.runControl = { abort, interrupt };

    pauseActiveRunForWait(host);

    expect(interrupt).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(interrupt).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
  });

  it("falls back to abort when interrupt is unavailable", async () => {
    vi.useFakeTimers();
    const host = waitingHost();
    const abort = vi.fn();
    host.runControl = { abort };

    pauseActiveRunForWait(host);

    await vi.runAllTimersAsync();
    expect(abort).toHaveBeenCalledOnce();
  });

  it("coalesces an elapsed wait resume instead of resuming immediately", async () => {
    disablePersistence();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const host = waitingHost();
    host.status = "idle";
    const startChildSession = vi.fn();

    const resumed = requestWaitResume(host, {
      bus: createBus({ clients: new Set() } as unknown as WebSocketServer),
      startChildSession,
      forEachLeaderTaskState: () => {},
    }, {
      completedReason: "Timer elapsed",
      opts: {
        sessionKey: host.id,
        prompt: "Continue.",
        cwd: host.cwd,
        resumeId: "sdk-1",
        role: host.role,
        harness: host.harnessName,
      },
    });

    expect(resumed).toBe(false);
    expect(host.taskState?.pendingWait).not.toBeNull();
    expect(startChildSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(startChildSession).toHaveBeenCalledOnce();
    expect(host.taskState?.pendingWait).toBeNull();
    expect(startChildSession).toHaveBeenCalledWith(expect.objectContaining({
      invocationKind: "resume_open_run",
      resumeId: "sdk-1",
    }));
  });
});
