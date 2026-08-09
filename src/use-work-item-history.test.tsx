import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkItemRunSnapshot } from "../shared/work-item-contracts.ts";
import { buildUnifiedWorkItemMessages } from "./WorkItemTranscript.tsx";
import { emptySessionStreamState } from "./session-stream.ts";
import { useWorkItemHistory } from "./use-work-item-history.ts";
import type { SocketSubscribe } from "./use-socket.ts";
import { previousPrimaryRuns } from "./work-item-run-history.ts";

function run(runKey: string, startedAt: number, runNumber: number): WorkItemRunSnapshot {
  return {
    runKey, workItemId: "work-1", runKind: "primary", parentRunKey: null,
    taskId: null, runNumber, previousRunKey: runNumber > 1 ? `run-${runNumber - 1}` : null,
    providerSessionId: null, outcome: runNumber === 2 ? "none" : "completed",
    startedAt, endedAt: runNumber === 2 ? null : startedAt + 1,
    finalReport: runNumber === 2 ? null : "First complete",
  };
}

function socketHarness() {
  const listeners: Array<(message: unknown) => void> = [];
  const subscribe = Object.assign(
    ((_topic: string, listener: (message: unknown) => void) => {
      listeners.push(listener);
      return () => undefined;
    }) as SocketSubscribe,
    { supportsTopics: true as const },
  );
  return {
    subscribe,
    emit(message: unknown) {
      act(() => listeners.forEach((listener) => listener(message)));
    },
  };
}

describe("useWorkItemHistory", () => {
  it("loads every run page and syncs each ledger-linked transcript", () => {
    const socket = socketHarness();
    const send = vi.fn();
    const loadRuns = vi.fn();
    const runs = [run("run-2", 20, 2), run("run-1", 10, 1)];
    const { result, rerender } = renderHook(
      ({ cursor }) => useWorkItemHistory({
        workItemId: "work-1", runs, runNextCursor: cursor,
        onLoadRuns: loadRuns, socketSend: send, socketSubscribe: socket.subscribe,
      }),
      { initialProps: { cursor: "page-2" as string | null } },
    );

    expect(loadRuns).toHaveBeenCalledWith("page-2");
    expect(send.mock.calls.map(([command]) => command)).toEqual([
      { type: "sync_session", sessionKey: "run-1" },
      { type: "sync_session", sessionKey: "run-2" },
    ]);

    socket.emit({
      type: "sync_response", sessionKey: "run-1", found: true, status: "completed",
      events: [{
        type: "sdk_event", sessionKey: "run-1", timestamp: 11,
        event: { kind: "text", role: "assistant", text: "First iteration output" },
      }],
    });
    expect(result.current.streams["run-1"]?.messages[0]?.content)
      .toBe("First iteration output");

    rerender({ cursor: null });
    expect(result.current.orderedRuns.map((entry) => entry.runKey)).toEqual(["run-1", "run-2"]);
  });

  it("requests the first ledger page for a selected work item", () => {
    const loadRuns = vi.fn();
    renderHook(() => useWorkItemHistory({
      workItemId: "work-1", runs: [], runNextCursor: undefined, onLoadRuns: loadRuns,
    }));
    expect(loadRuns).toHaveBeenCalledWith(undefined);
  });

  it("requests the first ledger page when a live current run arrived before history", () => {
    const loadRuns = vi.fn();
    renderHook(() => useWorkItemHistory({
      workItemId: "work-1", runs: [run("run-2", 20, 2)], runNextCursor: undefined,
      onLoadRuns: loadRuns,
    }));

    expect(loadRuns).toHaveBeenCalledWith(undefined);
  });

  it("re-syncs known runs after a socket reconnect", () => {
    const first = socketHarness();
    const second = socketHarness();
    const send = vi.fn();
    const runs = [run("run-1", 10, 1)];
    const { rerender } = renderHook(
      ({ subscribe }) => useWorkItemHistory({
        workItemId: "work-1", runs, runNextCursor: null,
        socketSend: send, socketSubscribe: subscribe,
      }),
      { initialProps: { subscribe: first.subscribe } },
    );
    expect(send).toHaveBeenCalledTimes(1);
    rerender({ subscribe: second.subscribe });
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("buildUnifiedWorkItemMessages", () => {
  it("adds ordered iteration boundaries and preserves the live current transcript", () => {
    const first = emptySessionStreamState("run-1");
    first.messages = [{ id: "old", role: "assistant", content: "Earlier work", timestamp: 11 }];
    const messages = buildUnifiedWorkItemMessages({
      runs: [run("run-1", 10, 1), run("run-2", 20, 2)],
      streams: { "run-1": first },
      currentRunKey: "run-2",
      currentMessages: [{ id: "current", role: "assistant", content: "Current work", timestamp: 21 }],
    });
    expect(messages.map((message) => message.content)).toEqual([
      "Iteration 1 · completed", "Earlier work", "Iteration 2 · Active now", "Current work",
    ]);
  });

  it("selects every previous primary iteration newest-first without child runs", () => {
    const child: WorkItemRunSnapshot = {
      ...run("child-1", 15, 1),
      runKind: "child",
      parentRunKey: "run-1",
      taskId: "delegated-task",
      runNumber: null,
      previousRunKey: null,
    };
    const selected = previousPrimaryRuns([
      run("run-1", 10, 1),
      child,
      run("run-3", 30, 3),
      run("run-2", 20, 2),
    ], "run-3");

    expect(selected.map((entry) => entry.runKey)).toEqual(["run-2", "run-1"]);
  });
});
