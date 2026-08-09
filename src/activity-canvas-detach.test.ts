import { describe, expect, it, vi } from "vitest";

import { detachSessionCanvasNodes } from "./activity-canvas-detach.ts";
import type { WorkItemSnapshot } from "../shared/work-item-contracts.ts";
import type { CanvasNode } from "./types.ts";
import type { LeaderData } from "./nodes/leader/types.ts";

function node(
  id: string,
  sessionKey: string,
  overrides: Partial<LeaderData> = {},
): CanvasNode {
  return {
    id,
    type: "leader",
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    data: {
      sessionKey,
      workItemId: "work-1",
      workItemSnapshot: {
        id: "work-1",
        currentRunKey: sessionKey,
        lifecycle: { lifecycleRevision: 4 },
      },
      ...overrides,
    } as LeaderData,
  };
}

describe("detachSessionCanvasNodes", () => {
  it("detaches the durable binding and removes matching nodes and edges", () => {
    const send = vi.fn();
    const dispatch = vi.fn();
    const graphDispatch = vi.fn();
    const matching = node("leader-1", "run-1");
    const unrelated = node("leader-2", "run-2", { workItemId: "work-2" });

    detachSessionCanvasNodes([matching, unrelated], { sessionKey: "run-1" }, {
      send,
      dispatch,
      graphDispatch,
    });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "detach_work_item_surface",
      workItemId: "work-1",
      surface: "canvas",
      bindingId: "leader-1",
      expectedLifecycleRevision: 4,
      expectedCurrentRunKey: "run-1",
    }));
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "REMOVE_NODE",
      id: "leader-1",
    });
    expect(graphDispatch).toHaveBeenCalledExactlyOnceWith({
      type: "REMOVE_EDGES_FOR_NODE",
      nodeId: "leader-1",
    });
  });

  it("matches a canonical item after its Activity session key becomes synthetic", () => {
    const send = vi.fn();
    const dispatch = vi.fn();
    const graphDispatch = vi.fn();
    const matching = node("leader-1", "last-real-run");
    const matchingData = matching.data as LeaderData;
    matching.data = {
      ...matchingData,
      currentRunKey: null,
      workItemSnapshot: {
        ...matchingData.workItemSnapshot!,
        currentRunKey: null,
        lifecycle: {
          ...matchingData.workItemSnapshot!.lifecycle,
          lifecycleRevision: 5,
        },
      },
    };
    const unrelated = node("leader-2", "another-run", { workItemId: "work-2" });

    detachSessionCanvasNodes(
      [matching, unrelated],
      { sessionKey: "work-item:work-1", workItemId: "work-1" },
      { send, dispatch, graphDispatch },
    );

    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "REMOVE_NODE",
      id: "leader-1",
    });
    expect(graphDispatch).toHaveBeenCalledExactlyOnceWith({
      type: "REMOVE_EDGES_FOR_NODE",
      nodeId: "leader-1",
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "detach_work_item_surface",
      workItemId: "work-1",
      bindingId: "leader-1",
      expectedCurrentRunKey: null,
    }));
  });

  it("uses fresh canonical state when a persisted node has not rehydrated", () => {
    const send = vi.fn();
    const dispatch = vi.fn();
    const graphDispatch = vi.fn();
    const persisted = node("leader-1", "completed-run", {
      workItemSnapshot: null,
    });
    const workItem = {
      id: "work-1",
      currentRunKey: "completed-run",
      lifecycle: { lifecycleRevision: 7 },
    } as WorkItemSnapshot;

    detachSessionCanvasNodes(
      [persisted],
      { sessionKey: "completed-run", workItemId: "work-1" },
      { send, dispatch, graphDispatch, workItem },
    );

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "detach_work_item_surface",
      workItemId: "work-1",
      bindingId: "leader-1",
      expectedLifecycleRevision: 7,
      expectedCurrentRunKey: "completed-run",
    }));
    expect(dispatch).toHaveBeenCalledWith({ type: "REMOVE_NODE", id: "leader-1" });
  });
});
