import { useRef, useState } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCanvasNavigation } from "./use-canvas-navigation.ts";
import type { CanvasNode } from "./types.ts";

const initial = { x: 120, y: -40, scale: .6 };
const destination = { x: -500, y: 300, scale: 1 };
const nodes: CanvasNode[] = ["a", "b"].map(id => ({ id, type: "leader", position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, data: { taskName: id } }));
function mount() {
  const cancelCameraAnim = vi.fn();
  const clearEdgeSelection = vi.fn();
  return { ...renderHook(({ currentNodes, historyKey }) => {
    const [transform, setTransform] = useState(initial);
    const [selectedIds, setSelectedIds] = useState(new Set(["a"]));
    const containerRef = useRef<HTMLDivElement>(null);
    const navigation = useCanvasNavigation({ transform, setTransform, selectedIds, setSelectedIds, nodes: currentNodes, historyKey, containerRef, cancelCameraAnim, clearEdgeSelection });
    return { ...navigation, transform, setTransform, selectedIds };
  }, { initialProps: { currentNodes: nodes, historyKey: "global" } }), cancelCameraAnim, clearEdgeSelection };
}

describe("Canvas return navigation", () => {
  it("restores position, zoom and selection after a jump and subsequent manual pan", () => {
    const { result, cancelCameraAnim, clearEdgeSelection } = mount();
    act(() => result.current.navigateTo(destination, new Set(["b"])));
    act(() => result.current.setTransform({ x: 900, y: 600, scale: .2 }));
    act(() => result.current.goBack());
    expect(result.current.transform).toEqual(initial);
    expect([...result.current.selectedIds]).toEqual(["a"]);
    expect(result.current.canGoBack).toBe(false);
    expect(cancelCameraAnim).toHaveBeenCalledTimes(2);
    expect(clearEdgeSelection).toHaveBeenCalledTimes(2);
  });
  it("does not add duplicate destinations or ordinary panning to history", () => {
    const { result } = mount();
    act(() => result.current.setTransform(destination));
    expect(result.current.canGoBack).toBe(false);
    act(() => result.current.navigateTo(destination, new Set(["a"])));
    expect(result.current.canGoBack).toBe(false);
    act(() => result.current.navigateTo(initial, new Set(["b"])));
    act(() => result.current.navigateTo(initial, new Set(["b"])));
    act(() => result.current.goBack());
    expect(result.current.transform).toEqual(destination);
    expect(result.current.canGoBack).toBe(false);
  });
  it("restores a view even if its selected node has since been deleted", () => {
    const { result, rerender } = mount();
    act(() => result.current.navigateTo(destination, new Set(["b"])));
    rerender({ currentNodes: nodes.filter(node => node.id !== "a"), historyKey: "global" });
    act(() => result.current.goBack());
    expect(result.current.transform).toEqual(initial);
    expect(result.current.selectedIds.size).toBe(0);
  });
});

it("clears view history when switching workspace canvases", () => {
  const { result, rerender } = mount();
  act(() => result.current.navigateTo(destination, new Set(["b"])));
  expect(result.current.canGoBack).toBe(true);
  rerender({ currentNodes: [], historyKey: "release" });
  expect(result.current.canGoBack).toBe(false);
  act(() => result.current.goBack());
  expect(result.current.transform).toEqual(destination);
});
