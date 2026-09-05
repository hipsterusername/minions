import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useTopologyCamera } from "./use-topology-camera.ts";

function viewport(width: number, height: number) {
  const element = document.createElement("div");
  const size = { width, height };
  Object.defineProperties(element, {
    clientWidth: { get: () => size.width },
    clientHeight: { get: () => size.height },
  });
  return { element, size, ref: { current: element } };
}

describe("graph camera navigation", () => {
  it("keeps the viewed point stable while zooming and resizing the viewport", () => {
    const { element, size, ref } = viewport(1_000, 600);
    const { result } = renderHook(() => useTopologyCamera(ref, { width: 3_000, height: 900 }));
    element.scrollLeft = 600;
    element.scrollTop = 100;
    const point = () => ({
      x: (element.scrollLeft + size.width / 2 - result.current.camera.offsetX) / result.current.camera.scale,
      y: (element.scrollTop + size.height / 2 - result.current.camera.offsetY) / result.current.camera.scale,
    });
    const before = point();
    act(() => result.current.zoomBy(0.2));
    expect(point().x).toBeCloseTo(before.x);
    expect(point().y).toBeCloseTo(before.y);

    act(() => { size.width = 700; size.height = 400; window.dispatchEvent(new Event("resize")); });
    expect(point().x).toBeCloseTo(before.x);
    expect(point().y).toBeCloseTo(before.y);
  });

  it("fits after panning and follows later viewport and graph size changes", () => {
    const { element, size, ref } = viewport(1_200, 700);
    const { result, rerender } = renderHook(({ width }) => useTopologyCamera(ref, { width, height: 500 }), { initialProps: { width: 5_000 } });
    element.scrollLeft = 800;
    element.scrollTop = 100;
    act(() => result.current.setZoom("fit"));
    expect(element.scrollLeft).toBe(0);
    expect(element.scrollTop).toBe(0);
    expect(result.current.camera.stageWidth).toBe(size.width);

    act(() => { size.width = 390; size.height = 300; window.dispatchEvent(new Event("resize")); });
    rerender({ width: 10_000 });
    expect(result.current.camera.stageWidth).toBe(390);
    expect(result.current.camera.stageHeight).toBe(300);
    act(() => result.current.setZoom(1));
    expect(result.current.camera.scale).toBe(1);
    expect(result.current.camera.stageWidth).toBeGreaterThan(size.width);
  });
});
