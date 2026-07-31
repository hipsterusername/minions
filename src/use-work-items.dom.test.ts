// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkItemSnapshot } from "../shared/work-item-contracts.ts";
import { initialWorkItemLifecycle } from "../shared/work-item-lifecycle.ts";
import { mergeCanonicalActivity, useWorkItems } from "./use-work-items.ts";
import type { ServerMessage, SocketSubscribe } from "./use-socket.ts";

function terminalItem(revision: number): WorkItemSnapshot {
  return {
    id: "work-1", projectId: "project-1", projectPath: "/repo", title: "Task",
    lifecycle: { ...initialWorkItemLifecycle(), runtimeState: "inactive",
      outcome: "completed", lifecycleRevision: revision },
    waitKind: null, currentRunKey: "run-1", iteration: 1,
    lastTransitionAt: revision, createdAt: 1, updatedAt: revision,
  };
}

function setup() {
  const send = vi.fn();
  const listeners: Array<(message: ServerMessage) => void> = [];
  const subscribe = ((_: string, listener: (message: ServerMessage) => void) => {
    listeners.push(listener);
    return () => {};
  }) as SocketSubscribe;
  const rendered = renderHook(() => useWorkItems({
    projectId: "project-1", connected: true, subscribe, send,
  }));
  const publish = (message: ServerMessage) => {
    for (const listener of listeners) listener(message);
  };
  act(() => publish({
    type: "work_item_response", command: "list_work_items", requestId: null,
    success: true, result: { projectId: "project-1",
      items: [terminalItem(3)], nextCursor: null },
  }));
  return { ...rendered, send, publish };
}

describe("useWorkItems lifecycle recovery", () => {
  it("loads every work-item page so archived rows cannot reappear as legacy sessions", () => {
    const send = vi.fn();
    let listener: ((message: ServerMessage) => void) | undefined;
    const subscribe = ((topic: string, next: (message: ServerMessage) => void) => {
      if (topic === "*") listener = next;
      return () => {};
    }) as SocketSubscribe;
    const { result } = renderHook(() => useWorkItems({
      projectId: "project-1", connected: true, subscribe, send,
    }));
    const firstRequest = send.mock.calls.find(([command]) =>
      (command as { type?: string }).type === "list_work_items")?.[0] as {
        requestId: string; limit: number; cursor?: string;
      };
    expect(firstRequest).toMatchObject({ limit: 100 });
    expect(firstRequest.cursor).toBeUndefined();

    act(() => listener?.({
      type: "work_item_response", command: "list_work_items",
      requestId: firstRequest.requestId, success: true,
      result: { projectId: "project-1", items: [terminalItem(3)],
        nextCursor: "page-2" },
    }));
    const secondRequest = send.mock.calls.at(-1)?.[0] as {
      requestId: string; limit: number; cursor?: string;
    };
    expect(secondRequest).toMatchObject({ limit: 100, cursor: "page-2" });
    expect(secondRequest.requestId).not.toBe(firstRequest.requestId);

    const archived = {
      ...terminalItem(4),
      id: "work-archived",
      title: "Archived task",
      currentRunKey: "run-archived",
      lifecycle: {
        ...terminalItem(4).lifecycle,
        resolution: "archived" as const,
      },
    };
    act(() => listener?.({
      type: "work_item_response", command: "list_work_items",
      requestId: secondRequest.requestId, success: true,
      result: { projectId: "project-1", items: [archived], nextCursor: null },
    }));

    expect(Object.keys(result.current.items).sort()).toEqual(["work-1", "work-archived"]);
    const activity = mergeCanonicalActivity([
      { sessionKey: "run-archived", sessionId: null, workItemId: "work-archived",
        status: "stopped", cwd: "/repo" },
    ], result.current.orderedItems);
    expect(activity).toHaveLength(2);
    expect(activity.find((row) => row.workItemId === "work-archived")
      ?.reviewLifecycle?.dismissedAt).not.toBeNull();
  });

  it("automatically retries an initiation conflict against the authoritative snapshot", () => {
    const { result, send, publish } = setup();
    act(() => result.current.start(result.current.items["work-1"]!, "Continue"));
    const first = send.mock.calls.at(-1)?.[0] as {
      requestId: string; expectedLifecycleRevision: number;
    };
    expect(first.expectedLifecycleRevision).toBe(3);

    act(() => publish({
      type: "work_item_response", command: "continue_work_item",
      requestId: first.requestId, success: false, error: "stale work-item lifecycle",
      code: "conflict",
      latest: { workItem: terminalItem(4), bindings: [], currentRun: null,
        runs: [], nextCursor: null },
    }));
    const retry = send.mock.calls.at(-1)?.[0] as {
      requestId: string; expectedLifecycleRevision: number; prompt: string;
    };
    expect(retry).toMatchObject({
      expectedLifecycleRevision: 4, prompt: "Continue",
    });
    expect(retry.requestId).not.toBe(first.requestId);
    expect(result.current.items["work-1"]?.lifecycle.lifecycleRevision).toBe(4);
  });

  it("does not retry a stale response after the project scope changes", () => {
    const send = vi.fn();
    let listener: ((message: ServerMessage) => void) | undefined;
    const subscribe = ((_: string, next: (message: ServerMessage) => void) => {
      listener = next;
      return () => {};
    }) as SocketSubscribe;
    const { result, rerender } = renderHook(
      ({ projectId }) => useWorkItems({
        projectId, connected: true, subscribe, send,
      }),
      { initialProps: { projectId: "project-1" as string | null } },
    );
    act(() => listener?.({
      type: "work_item_response", command: "list_work_items", requestId: null,
      success: true, result: { projectId: "project-1",
        items: [terminalItem(3)], nextCursor: null },
    }));
    act(() => result.current.start(result.current.items["work-1"]!, "Continue"));
    const first = send.mock.calls.at(-1)?.[0] as { requestId: string };

    rerender({ projectId: "project-2" });
    const countBeforeConflict = send.mock.calls.length;
    act(() => listener?.({
      type: "work_item_response", command: "continue_work_item",
      requestId: first.requestId, success: false, error: "stale work-item lifecycle",
      code: "conflict",
      latest: { workItem: terminalItem(4), bindings: [], currentRun: null,
        runs: [], nextCursor: null },
    }));
    expect(send).toHaveBeenCalledTimes(countBeforeConflict);
  });

  it("exposes and clears a non-conflict prompt failure", () => {
    const { result, send, publish } = setup();
    act(() => result.current.start(result.current.items["work-1"]!, "Keep my prompt"));
    const request = send.mock.calls.at(-1)?.[0] as { requestId: string };

    act(() => publish({
      type: "work_item_response", command: "continue_work_item",
      requestId: request.requestId, success: false, error: "Harness unavailable",
      code: "unavailable",
    }));

    expect(result.current.promptFailures["work-1"]).toEqual({
      prompt: "Keep my prompt",
      error: "Harness unavailable",
    });
    act(() => result.current.clearPromptFailure("work-1"));
    expect(result.current.promptFailures["work-1"]).toBeUndefined();
  });

  it("surfaces the prompt after three consecutive conflicts", () => {
    const { result, send, publish } = setup();
    act(() => result.current.start(result.current.items["work-1"]!, "Try three times"));

    for (const revision of [4, 5, 6]) {
      const request = send.mock.calls.at(-1)?.[0] as { requestId: string };
      act(() => publish({
        type: "work_item_response", command: "continue_work_item",
        requestId: request.requestId, success: false, error: "stale work-item lifecycle",
        code: "conflict",
        latest: { workItem: terminalItem(revision), bindings: [], currentRun: null,
          runs: [], nextCursor: null },
      }));
    }

    expect(send.mock.calls.filter(([command]) =>
      (command as { type?: string }).type === "continue_work_item")).toHaveLength(3);
    expect(result.current.promptFailures["work-1"]).toEqual({
      prompt: "Try three times",
      error: "stale work-item lifecycle",
    });
  });
});
