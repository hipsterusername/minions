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
  it("keeps distinct per-node closures stable while calling the latest compute", () => {
    const { result, rerender } = renderHook(
      ({ compute }) => useStableNodeGetter(compute),
      { initialProps: { compute: (id: string) => `before:${id}` } },
    );
    const a = result.current("node-a");
    const b = result.current("node-b");
    expect(b).not.toBe(a);
    expect(a()).toBe("before:node-a");
    expect(b()).toBe("before:node-b");
    rerender({ compute: (id: string) => `after:${id}` });
    expect(result.current("node-a")).toBe(a);
    expect(result.current("node-b")).toBe(b);
    expect(a()).toBe("after:node-a");
    expect(b()).toBe("after:node-b");
  });
});
