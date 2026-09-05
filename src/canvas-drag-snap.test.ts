import { describe, expect, it } from "vitest";
import { resolveDragSnap } from "./canvas-drag-snap.ts";
import type { CanvasNode } from "./types.ts";

const obstacle: CanvasNode = { id: "anchor", type: "note", data: {},
  position: { x: 200, y: 100 }, size: { width: 200, height: 200 } };
const box = { x: 420, y: 108, width: 100, height: 100 };

describe("magnetic drag alignment", () => {
  it.each([100, 200])("aligns a nearby top/bottom edge at y=%i", y => {
    expect(resolveDragSnap({ ...box, y: y + 8 }, [obstacle], 1)?.position).toEqual({ x: 420, y });
  });

  it("holds alignment beyond capture range, then releases and reacquires", () => {
    const snapped = resolveDragSnap(box, [obstacle], 1);
    expect(snapped?.position.y).toBe(100);
    expect(resolveDragSnap({ ...box, y: 120 }, [obstacle], 1)).toBeNull();
    expect(resolveDragSnap({ ...box, y: 120 }, [obstacle], 1, snapped)?.position.y).toBe(100);
    expect(resolveDragSnap({ ...box, y: 125 }, [obstacle], 1, snapped)).toBeNull();
    expect(resolveDragSnap(box, [obstacle], 1)?.position.y).toBe(100);
  });

  it.each([.25, .5, 1, 2])("uses screen pixels at zoom %s", scale => {
    const start = { ...box, y: 100 + 10 / scale };
    const held = resolveDragSnap(start, [obstacle], scale);
    expect(held?.position.y).toBe(100);
    expect(resolveDragSnap({ ...start, y: 100 + 23 / scale }, [obstacle], scale, held)?.position.y).toBe(100);
    // Use a single tall target to keep the next alignment out of release range.
    expect(resolveDragSnap({ ...start, x: 400 + 73 / scale }, [obstacle], scale, held)).toBeNull();
  });

  it.each([-16, 316])("offers left, center, right and free-X stack positions at y=%i", y => {
    for (const x of [200, 250, 300]) {
      expect(resolveDragSnap({ ...box, x: x + 5, y: y + 4 }, [obstacle], 1)?.position).toEqual({ x, y });
    }
    expect(resolveDragSnap({ ...box, x: 275, y: y + 4 }, [obstacle], 1)?.position).toEqual({ x: 275, y });
  });

  it("clears all obstacles with gutters, including partial blockers", () => {
    const blocker = { ...obstacle, id: "partial", position: { x: 100, y: -100 }, size: { width: 150, height: 100 } };
    const result = resolveDragSnap({ ...box, x: 258, y: -12 }, [obstacle, blocker], 1);
    expect(result?.position).toEqual({ x: 266, y: -16 });
    expect(resolveDragSnap({ ...box, x: 200, y: -12 }, [obstacle, blocker], 1)).toBeNull();
    expect(resolveDragSnap({ ...box, x: 258, y: -12 }, [blocker, obstacle], 1)).toEqual(result);
  });

  it("acquires a new horizontal alignment while sliding along a held shelf", () => {
    const freeX = resolveDragSnap({ ...box, x: 275, y: 320 }, [obstacle], 1);
    expect(freeX?.position).toEqual({ x: 275, y: 316 });
    const centered = resolveDragSnap({ ...box, x: 256, y: 320 }, [obstacle], 1, freeX);
    expect(centered?.position).toEqual({ x: 250, y: 316 });
    expect(resolveDragSnap({ ...box, x: 271, y: 320 }, [obstacle], 1, centered)?.position).toEqual({ x: 250, y: 316 });
    expect(resolveDragSnap({ ...box, x: 277, y: 320 }, [obstacle], 1, centered)?.position).toEqual({ x: 277, y: 316 });
  });

  it("ignores distant nodes and releases when a target disappears or becomes blocked", () => {
    const snapped = resolveDragSnap(box, [obstacle], 1);
    expect(resolveDragSnap({ ...box, x: 800 }, [obstacle], 1, snapped)).toBeNull();
    expect(resolveDragSnap(box, [], 1, snapped)).toBeNull();
    expect(resolveDragSnap(box, [obstacle, { ...obstacle, id: "block", position: { x: 425, y: 105 } }], 1, snapped)).toBeNull();
  });
});
