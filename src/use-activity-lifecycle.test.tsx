import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MobileSessionInfo } from "./mobile/mobile-selectors.ts";
import { useActivityLifecycle } from "./use-activity-lifecycle.ts";
import type { SocketSubscribe } from "./use-socket.ts";

function session(overrides: Partial<MobileSessionInfo> = {}): MobileSessionInfo {
  return {
    sessionKey: "session-1",
    sessionId: null,
    status: "idle",
    cwd: "/tmp/project",
    taskName: "Lifecycle task",
    ...overrides,
  };
}

function subscription() {
  let handler: ((message: unknown) => void) | null = null;
  const cleanup = vi.fn(() => { handler = null; });
  const socketSubscribe = Object.assign(
    vi.fn((_topic: string, next: (message: unknown) => void) => {
      handler = next;
      return cleanup;
    }),
    { supportsTopics: true as const },
  ) as unknown as SocketSubscribe;
  return {
    socketSubscribe,
    cleanup,
    emit(message: unknown) {
      act(() => handler?.(message));
    },
  };
}

function commandAt(socketSend: ReturnType<typeof vi.fn>, index = 0) {
  return socketSend.mock.calls[index]![0] as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useActivityLifecycle", () => {
  it("keeps a failed dismissal attached and surfaces its correlated error", () => {
    const socketSend = vi.fn();
    const onDetachFromCanvas = vi.fn();
    const { socketSubscribe, emit } = subscription();
    const target = session();
    const { result } = renderHook(() => useActivityLifecycle({
      socketSend, socketSubscribe, onDetachFromCanvas,
    }));

    act(() => result.current.sendLifecycle("dismiss", target));
    const command = commandAt(socketSend);
    expect(command).toEqual(expect.objectContaining({
      type: "dismiss_session",
      sessionKey: "session-1",
      requestId: expect.any(String),
    }));
    expect(result.current.pendingKeys).toEqual(new Set(["session:session-1"]));

    emit({ type: "control_response", command: "dismiss_session",
      requestId: command["requestId"], success: false, error: "Revision conflict" });

    expect(result.current.pendingKeys.size).toBe(0);
    expect(result.current.actionError).toBe("Lifecycle task: Dismiss failed: Revision conflict");
    expect(onDetachFromCanvas).not.toHaveBeenCalled();
  });

  it("detaches only after a success matching both request and command", () => {
    const socketSend = vi.fn();
    const onDetachFromCanvas = vi.fn();
    const { socketSubscribe, emit } = subscription();
    const target = session({ workItemId: "work-1", canonicalWorkItem: true });
    const { result } = renderHook(() => useActivityLifecycle({
      socketSend, socketSubscribe, onDetachFromCanvas,
    }));

    act(() => result.current.sendLifecycle("dismiss", target));
    const command = commandAt(socketSend);
    emit({ type: "work_item_response", command: "archive_work_item",
      requestId: "another-request", success: true });
    emit({ type: "work_item_response", command: "review_work_item",
      requestId: command["requestId"], success: true });
    expect(result.current.pendingKeys).toEqual(new Set(["work-item:work-1"]));
    expect(onDetachFromCanvas).not.toHaveBeenCalled();

    emit({ type: "work_item_response", command: "archive_work_item",
      requestId: command["requestId"], success: true });
    expect(result.current.pendingKeys.size).toBe(0);
    expect(onDetachFromCanvas).toHaveBeenCalledWith({
      sessionKey: "session-1",
      workItemId: "work-1",
    });
  });

  it("preserves a bulk failure when another activity succeeds", () => {
    const socketSend = vi.fn();
    const onDetachFromCanvas = vi.fn();
    const { socketSubscribe, emit } = subscription();
    const first = session({ sessionKey: "first", taskName: "First task" });
    const second = session({ sessionKey: "second", taskName: "Second task" });
    const { result } = renderHook(() => useActivityLifecycle({
      socketSend, socketSubscribe, onDetachFromCanvas,
    }));

    act(() => {
      result.current.sendLifecycle("dismiss", first);
      result.current.sendLifecycle("dismiss", second);
    });
    const firstCommand = commandAt(socketSend, 0);
    const secondCommand = commandAt(socketSend, 1);
    emit({ type: "control_response", command: "dismiss_session",
      requestId: firstCommand["requestId"], success: false, error: "First rejected" });
    emit({ type: "control_response", command: "dismiss_session",
      requestId: secondCommand["requestId"], success: true });

    expect(result.current.actionError).toBe("First task: Dismiss failed: First rejected");
    expect(result.current.pendingKeys.size).toBe(0);
    expect(onDetachFromCanvas).toHaveBeenCalledTimes(1);
    expect(onDetachFromCanvas).toHaveBeenCalledWith({ sessionKey: "second" });
  });

  it("prevents duplicate actions for one activity until its reply", () => {
    const socketSend = vi.fn();
    const { socketSubscribe, emit } = subscription();
    const target = session();
    const { result } = renderHook(() => useActivityLifecycle({ socketSend, socketSubscribe }));

    act(() => {
      result.current.sendLifecycle("acknowledge", target);
      result.current.sendLifecycle("dismiss", target);
    });
    expect(socketSend).toHaveBeenCalledTimes(1);

    const first = commandAt(socketSend);
    emit({ type: "control_response", command: first["type"],
      requestId: first["requestId"], success: true });
    act(() => result.current.sendLifecycle("dismiss", target));
    expect(socketSend).toHaveBeenCalledTimes(2);
  });

  it("times out after 15 seconds and permits a retry", () => {
    vi.useFakeTimers();
    const socketSend = vi.fn();
    const { socketSubscribe } = subscription();
    const target = session();
    const { result } = renderHook(() => useActivityLifecycle({ socketSend, socketSubscribe }));

    act(() => result.current.sendLifecycle("dismiss", target));
    act(() => vi.advanceTimersByTime(14_999));
    expect(result.current.pendingKeys.size).toBe(1);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.pendingKeys.size).toBe(0);
    expect(result.current.actionError).toMatch(/server has not confirmed/i);

    act(() => result.current.sendLifecycle("dismiss", target));
    expect(socketSend).toHaveBeenCalledTimes(2);
    expect(result.current.pendingKeys.size).toBe(1);
    expect(result.current.actionError).toBeNull();
  });

  it("accepts a late dismissal success after timeout and clears its timeout error", () => {
    vi.useFakeTimers();
    const socketSend = vi.fn();
    const onDetachFromCanvas = vi.fn();
    const { socketSubscribe, emit } = subscription();
    const { result } = renderHook(() => useActivityLifecycle({
      socketSend, socketSubscribe, onDetachFromCanvas,
    }));

    act(() => result.current.sendLifecycle("dismiss", session()));
    const command = commandAt(socketSend);
    act(() => vi.advanceTimersByTime(15_000));
    expect(result.current.pendingKeys.size).toBe(0);
    expect(result.current.actionError).toMatch(/server has not confirmed/i);
    expect(onDetachFromCanvas).not.toHaveBeenCalled();

    emit({ type: "control_response", command: "dismiss_session",
      requestId: command["requestId"], success: true });

    expect(result.current.actionError).toBeNull();
    expect(onDetachFromCanvas).toHaveBeenCalledWith({ sessionKey: "session-1" });
  });

  it("ignores a timed-out dismissal reply after a newer restore supersedes it", () => {
    vi.useFakeTimers();
    const socketSend = vi.fn();
    const onDetachFromCanvas = vi.fn();
    const { socketSubscribe, emit } = subscription();
    const target = session({
      reviewLifecycle: {
        reviewState: "completion_to_review",
        reviewReason: null,
        finalReport: null,
        finalDashboardRevision: null,
        dashboardRevision: 0,
        terminalReason: "completed",
        terminalAt: 1,
        acknowledgedAt: null,
        dismissedAt: 2,
        lifecycleRevision: 3,
      },
    });
    const { result } = renderHook(() => useActivityLifecycle({
      socketSend, socketSubscribe, onDetachFromCanvas,
    }));

    act(() => result.current.sendLifecycle("dismiss", target));
    const dismissal = commandAt(socketSend);
    act(() => vi.advanceTimersByTime(15_000));
    act(() => result.current.sendLifecycle("reopen", target));
    const restore = commandAt(socketSend, 1);

    emit({ type: "control_response", command: "dismiss_session",
      requestId: dismissal["requestId"], success: true });
    expect(onDetachFromCanvas).not.toHaveBeenCalled();
    expect(result.current.pendingKeys).toEqual(new Set(["session:session-1"]));

    emit({ type: "control_response", command: "reopen_session",
      requestId: restore["requestId"], success: true });
    expect(result.current.pendingKeys.size).toBe(0);
    expect(result.current.actionError).toBeNull();
    expect(onDetachFromCanvas).not.toHaveBeenCalled();
  });

  it("never detaches when the sender throws or is unavailable", () => {
    const onDetachFromCanvas = vi.fn();
    const throwingSend = vi.fn(() => { throw new Error("socket closed"); });
    const first = renderHook(() => useActivityLifecycle({
      socketSend: throwingSend, onDetachFromCanvas,
    }));
    act(() => first.result.current.sendLifecycle("dismiss", session()));
    expect(first.result.current.pendingKeys.size).toBe(0);
    expect(first.result.current.actionError).toMatch(/could not be sent/i);
    first.unmount();

    const second = renderHook(() => useActivityLifecycle({ onDetachFromCanvas }));
    act(() => second.result.current.sendLifecycle("dismiss", session()));
    expect(second.result.current.pendingKeys.size).toBe(0);
    expect(second.result.current.actionError).toMatch(/actions are unavailable/i);
    expect(onDetachFromCanvas).not.toHaveBeenCalled();
  });

  it("unsubscribes and clears pending timeouts on cleanup", () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const socketSend = vi.fn();
    const { socketSubscribe, cleanup } = subscription();
    const { result, unmount } = renderHook(() => useActivityLifecycle({ socketSend, socketSubscribe }));
    act(() => result.current.sendLifecycle("dismiss", session()));

    unmount();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(15_000));
    expect(socketSend).toHaveBeenCalledTimes(1);
  });
});

describe("confirmed Canvas detach revision", () => {
  it.each(["work_item_response", "control_response"])(
    "forwards the fresh work-item snapshot from %s to Canvas detach",
    (type) => {
      const socketSend = vi.fn();
      const onDetachFromCanvas = vi.fn();
      const { socketSubscribe, emit } = subscription();
      const target = session({ workItemId: "work-1", canonicalWorkItem: type === "work_item_response" });
      const { result } = renderHook(() => useActivityLifecycle({
        socketSend, socketSubscribe, onDetachFromCanvas,
      }));
      act(() => result.current.sendLifecycle("dismiss", target));
      const command = commandAt(socketSend);
      const workItem = { id: "work-1", currentRunKey: "session-1",
        lifecycle: { lifecycleRevision: 8, resolution: "archived" } };
      emit({ type, command: command["type"], requestId: command["requestId"], success: true,
        ...(type === "work_item_response" ? { result: { workItem } } : { workItem }) });
      expect(onDetachFromCanvas).toHaveBeenCalledExactlyOnceWith(
        { sessionKey: "session-1", workItemId: "work-1" }, workItem,
      );
    },
  );
});

describe("queued lifecycle retries", () => {
  it("reuses a canonical dismissal request and detaches once when both sends complete", () => {
    vi.useFakeTimers();
    const socketSend = vi.fn();
    const onDetachFromCanvas = vi.fn();
    const { socketSubscribe, emit } = subscription();
    const target = session({ canonicalWorkItem: true, workItemId: "work-1" });
    const { result } = renderHook(() => useActivityLifecycle({
      socketSend, socketSubscribe, onDetachFromCanvas,
    }));
    act(() => result.current.sendLifecycle("dismiss", target));
    const original = commandAt(socketSend);
    act(() => vi.advanceTimersByTime(15_000));
    act(() => result.current.sendLifecycle("dismiss", target));
    expect(commandAt(socketSend, 1)).toEqual(original);
    const response = { type: "work_item_response", command: "archive_work_item",
      requestId: original["requestId"], success: true };
    emit(response);
    emit(response);
    expect(result.current.pendingKeys.size).toBe(0);
    expect(result.current.actionError).toBeNull();
    expect(onDetachFromCanvas).toHaveBeenCalledExactlyOnceWith({
      sessionKey: "session-1", workItemId: "work-1",
    });
  });
});

describe("dismissal receipts", () => {
  it("uses the confirmed canonical revision and run for an immediate restore", () => {
    const socketSend = vi.fn();
    const { socketSubscribe, emit } = subscription();
    const { result } = renderHook(() => useActivityLifecycle({ socketSend, socketSubscribe }));
    act(() => result.current.sendLifecycle("dismiss", session({ canonicalWorkItem: true, workItemId: "work-1" })));
    const command = commandAt(socketSend);
    expect(result.current.dismissedReceipts).toEqual([]);
    emit({ type: "work_item_response", command: "archive_work_item", requestId: command["requestId"], success: true,
      result: { workItem: { id: "work-1", currentRunKey: "confirmed-run", lifecycle: { lifecycleRevision: 12, resolution: "archived" } } } });
    act(() => result.current.sendLifecycle("reopen", result.current.dismissedReceipts[0]!));
    expect(commandAt(socketSend, 1)).toMatchObject({ type: "restore_work_item", workItemId: "work-1", expectedCurrentRunKey: "confirmed-run", expectedLifecycleRevision: 12 });
    expect(result.current.dismissedReceipts).toHaveLength(1);
    const restore = commandAt(socketSend, 1);
    emit({ type: "work_item_response", command: "restore_work_item", requestId: restore["requestId"], success: true });
    expect(result.current.dismissedReceipts).toEqual([]);
  });
});
