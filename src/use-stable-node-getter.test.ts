// @vitest-environment jsdom
/**
 * Unit tests for useStableNodeGetter.
 *
 * Covers:
 *   1. The getter closure keeps a stable identity per nodeId across renders.
 *   2. Different nodeIds get distinct closures.
 *   3. The closure always calls the latest `compute` (ref indirection).
 */
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useStableNodeGetter } from "./use-stable-node-getter.ts";

describe("useStableNodeGetter", () => {
  it("returns a stable closure per nodeId across re-renders", () => {
    const { result, rerender } = renderHook(
      ({ compute }) => useStableNodeGetter(compute),
      { initialProps: { compute: (id: string) => id.length } },
    );
    const first = result.current("node-a");
    rerender({ compute: (id: string) => id.length });
    const second = result.current("node-a");
    expect(second).toBe(first);
    expect(result.current("node-b")).not.toBe(first);
  });

  it("always calls the latest compute through the returned closure", () => {
    const { result, rerender } = renderHook(
      ({ compute }) => useStableNodeGetter(compute),
      { initialProps: { compute: (_id: string) => 1 } },
    );
    const closure = result.current("node-a");
    expect(closure()).toBe(1);
    rerender({ compute: (_id: string) => 2 });
    // Same closure identity, but reflects the updated compute.
    expect(result.current("node-a")).toBe(closure);
    expect(closure()).toBe(2);
  });
});
