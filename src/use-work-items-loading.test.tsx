import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkItems } from "./use-work-items.ts";
import type { ServerMessage, SocketSubscribe } from "./use-socket.ts";
import type { WorkItemSnapshot } from "../shared/work-item-contracts.ts";
import { initialWorkItemLifecycle } from "../shared/work-item-lifecycle.ts";

function item(id: string, revision = 1): WorkItemSnapshot {
  return { id, projectId: "p1", projectPath: "/repo", title: id,
    lifecycle: { ...initialWorkItemLifecycle(), lifecycleRevision: revision },
    waitKind: null, currentRunKey: null, iteration: 0,
    lastTransitionAt: revision, createdAt: 1, updatedAt: revision };
}
function setup() {
  vi.useFakeTimers();
  let receive: (message: ServerMessage) => void = () => {};
  const subscribe = ((_topic: unknown, listener: typeof receive) => {
    receive = listener;
    return () => {};
  }) as SocketSubscribe;
  const send = vi.fn();
  const hook = renderHook(({ projectId, connected }) => useWorkItems({ projectId, connected, subscribe, send }), {
    initialProps: { projectId: "p1", connected: true },
  });
  const latest = () => send.mock.calls.at(-1)![0] as { requestId: string; projectId: string };
  const page = (items: WorkItemSnapshot[], nextCursor: string | null = null, request = latest()) => {
    act(() => receive({ type: "work_item_response", command: "list_work_items", success: true,
      requestId: request.requestId, result: { projectId: request.projectId, items, nextCursor } } as ServerMessage));
  };
  return { ...hook, send, latest, page, emit: (message: ServerMessage) => act(() => receive(message)) };
}
afterEach(() => vi.useRealTimers());

describe("progressive activity loading", () => {
  it("publishes the first small page before requesting the next batch and settles only after the last page", () => {
    const h = setup();
    expect(h.result.current.loading).toBe(true);
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
    h.page([item("recent")], "older");
    expect(h.result.current.orderedItems.map((i) => i.id)).toEqual(["recent"]);
    expect(h.result.current.loading).toBe(true);
    expect(h.send).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(0));
    expect(h.send).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 100, cursor: "older" }));
    h.page([item("older")]);
    expect(h.result.current.orderedItems).toHaveLength(2);
    expect(h.result.current.loading).toBe(false);
  });

  it("distinguishes confirmed empty from a pending initial response", () => {
    const h = setup();
    expect(h.result.current.loading).toBe(true);
    h.page([]);
    expect(h.result.current.loading).toBe(false);
    expect(h.result.current.loadError).toBeNull();
  });

  it("retains rows through reconnect pagination and preserves newer live revisions", () => {
    const h = setup();
    h.page([item("a"), item("b"), item("removed")]);
    h.rerender({ projectId: "p1", connected: false });
    expect(h.result.current.orderedItems).toHaveLength(3);
    h.rerender({ projectId: "p1", connected: true });
    h.emit({ type: "work_item_changed", workItem: item("a", 5) } as ServerMessage);
    h.page([item("a", 2)], "older");
    expect(h.result.current.items["a"]?.lifecycle.lifecycleRevision).toBe(5);
    expect(h.result.current.orderedItems).toHaveLength(3);
    h.emit({ type: "work_item_created", workItem: item("live") } as ServerMessage);
    act(() => vi.advanceTimersByTime(0));
    h.page([item("b")]);
    expect(h.result.current.orderedItems.map((i) => i.id).sort()).toEqual(["a", "b", "live"]);
  });

  it("ignores stale responses and hides prior project rows during a project switch", () => {
    const h = setup();
    const stale = h.latest();
    h.page([item("a")]);
    h.rerender({ projectId: "p2", connected: true });
    expect(h.result.current.orderedItems).toEqual([]);
    expect(h.result.current.loading).toBe(true);
    h.page([item("late")], null, stale);
    expect(h.result.current.loading).toBe(true);
    expect(h.result.current.orderedItems).toEqual([]);
    h.page([]);
    expect(h.result.current.loading).toBe(false);
  });

  it("keeps partial results on failure, retries, and rejects the expired response", () => {
    const h = setup();
    h.page([item("a")], "older");
    act(() => vi.advanceTimersByTime(0));
    h.emit({ type: "work_item_response", command: "list_work_items", success: false,
      requestId: h.latest().requestId, error: "Unavailable" } as ServerMessage);
    expect(h.result.current.loadError).toBe("Unavailable");
    expect(h.result.current.orderedItems).toHaveLength(1);
    act(() => h.result.current.retryLoad());
    const expired = h.latest();
    act(() => vi.advanceTimersByTime(30_000));
    expect(h.result.current.loadError).toMatch(/longer than expected/);
    act(() => h.result.current.retryLoad());
    h.page([], null, expired);
    expect(h.result.current.loading).toBe(true);
    h.page([item("a")]);
    expect(h.result.current.loadError).toBeNull();
  });

  it("preserves live work received before the first list snapshot", () => {
    const h = setup();
    h.emit({ type: "work_item_created", workItem: item("live", 5) } as ServerMessage);
    h.page([item("live", 2), item("recent")]);
    expect(h.result.current.items["live"]?.lifecycle.lifecycleRevision).toBe(5);
    expect(h.result.current.orderedItems).toHaveLength(2);
  });

  it("cancels scheduled pages when unmounted", () => {
    const h = setup();
    h.page([item("a")], "older");
    h.unmount();
    act(() => vi.runAllTimers());
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});
