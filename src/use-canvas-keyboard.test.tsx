/**
 * use-canvas-keyboard — focused tests for the Delete / Backspace path.
 *
 * Most keyboard concerns (undo, copy/paste, leader-cascade) are covered
 * indirectly through Canvas tests. This file pins down the new contract
 * introduced for edge selection:
 *   - When an edge is selected and no nodes are, Delete removes the edge.
 *   - When both an edge AND nodes are selected, Delete falls through to
 *     the node-delete path so existing behaviour is preserved.
 *   - When neither is selected, Delete is a no-op.
 */
import { describe, it, expect, vi } from "vitest";
import { render, renderHook, fireEvent } from "@testing-library/react";
import type { Dispatch, MutableRefObject } from "react";
import { useCanvasKeyboard } from "./use-canvas-keyboard.ts";
import type { CanvasNode, CanvasAction } from "./types.ts";
import type { GraphDocument } from "./graph.ts";
import type { GraphAction } from "./graph-runtime.ts";

function makeOpts(overrides: {
  selectedIds?: Set<string>;
  selectedEdgeId?: string | null;
  onDeleteSelectedEdge?: () => void;
  dispatch?: Dispatch<CanvasAction>;
  graphDispatch?: Dispatch<GraphAction>;
  graph?: GraphDocument;
  nodes?: CanvasNode[];
  onRemoveNode?: (node: CanvasNode) => void;
}) {
  // We need a stable spaceRef but renderHook makes new refs each render.
  // For these tests we manufacture one directly.
  const spaceRef = { current: false } as MutableRefObject<boolean>;
  return {
    selectedIds: overrides.selectedIds ?? new Set<string>(),
    setSelectedIds: vi.fn(),
    selectedEdgeId: overrides.selectedEdgeId ?? null,
    onDeleteSelectedEdge: overrides.onDeleteSelectedEdge,
    nodes: overrides.nodes ?? [],
    graph: overrides.graph ?? { edges: [] },
    dispatch: overrides.dispatch ?? (vi.fn() as unknown as Dispatch<CanvasAction>),
    onRemoveNode: overrides.onRemoveNode,
    graphDispatch:
      overrides.graphDispatch ?? (vi.fn() as unknown as Dispatch<GraphAction>),
    spaceRef,
    isInsideGroup: () => false,
    setPendingGroupDelete: vi.fn(),
  };
}

describe("useCanvasKeyboard — Delete with edge selection", () => {
  it.each(["Delete", "Backspace"])("%s deletes only the selected edge", (code) => {
    const onDeleteSelectedEdge = vi.fn();
    const dispatch = vi.fn() as unknown as Dispatch<CanvasAction>;
    const opts = makeOpts({
      selectedEdgeId: "edge-1",
      onDeleteSelectedEdge,
      dispatch,
    });
    renderHook(() => useCanvasKeyboard(opts));
    fireEvent.keyDown(window, { code });
    expect(onDeleteSelectedEdge).toHaveBeenCalledTimes(1);
    // Node delete path must not fire when an edge is the active selection.
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(["input", "textarea"] as const)("keeps selected canvas items while editing a %s", (tag) => {
    const onDeleteSelectedEdge = vi.fn();
    const opts = makeOpts({ selectedIds: new Set(["node-1"]), selectedEdgeId: "edge-1", onDeleteSelectedEdge });
    renderHook(() => useCanvasKeyboard(opts));
    const view = render(tag === "input" ? <input aria-label="Editor" /> : <textarea aria-label="Editor" />);
    const editor = view.getByRole("textbox");
    for (const code of ["Delete", "Backspace"]) fireEvent.keyDown(editor, { code });
    expect(onDeleteSelectedEdge).not.toHaveBeenCalled();
    expect(opts.dispatch).not.toHaveBeenCalled();
    expect(opts.graphDispatch).not.toHaveBeenCalled();
  });

  it("does nothing when no edge and no node are selected", () => {
    const onDeleteSelectedEdge = vi.fn();
    const dispatch = vi.fn() as unknown as Dispatch<CanvasAction>;
    const opts = makeOpts({ onDeleteSelectedEdge, dispatch });
    renderHook(() => useCanvasKeyboard(opts));
    fireEvent.keyDown(window, { code: "Delete" });
    expect(onDeleteSelectedEdge).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("ignores edge shortcut when a node is also selected — node path wins", () => {
    const onDeleteSelectedEdge = vi.fn();
    const dispatch = vi.fn() as unknown as Dispatch<CanvasAction>;
    const opts = makeOpts({
      selectedIds: new Set(["node-1"]),
      selectedEdgeId: "edge-1",
      onDeleteSelectedEdge,
      dispatch,
    });
    renderHook(() => useCanvasKeyboard(opts));
    fireEvent.keyDown(window, { code: "Delete" });
    // Edge handler is suppressed; node-delete dispatch runs.
    expect(onDeleteSelectedEdge).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({ type: "REMOVE_NODE", id: "node-1" });
  });

  it("invokes the surface detach hook before removing a leader node", () => {
    const calls: string[] = [];
    const node = { id: "leader-1", type: "leader", position: { x: 0, y: 0 },
      size: { width: 1, height: 1 }, data: { workItemId: "work-1" } };
    const opts = makeOpts({ selectedIds: new Set([node.id]), nodes: [node],
      onRemoveNode: () => calls.push("detach"),
      dispatch: ((action: CanvasAction) => calls.push(action.type)) as Dispatch<CanvasAction> });
    renderHook(() => useCanvasKeyboard(opts));
    fireEvent.keyDown(window, { code: "Delete" });
    expect(calls).toEqual(["detach", "REMOVE_NODE"]);
  });
});
