/**
 * Unit tests for canvas utility functions:
 * snapToGrid, snapPositionToGrid, findNonOverlappingPosition, pushNodesFromRect
 *
 * viewportCenter is skipped — it requires window.innerWidth/Height.
 */

import { describe, it, expect } from "vitest";
import {
  GRID_SNAP,
  snapToGrid,
  snapPositionToGrid,
  findNonOverlappingPosition,
  pushNodesFromRect,
} from "./canvas-utils.ts";
import { makeNode } from "../tests/fixtures/builders.ts";

describe("snapToGrid", () => {
  // Removed: arithmetic-identity tests (snaps 0→0, leaves multiples
  // unchanged, rounds 11→0). They restate the rounding rule. See
  // docs/testing-strategy.md §5 — keeping a single boundary case.
  it("rounds 12 up to 24 (halfway rounds toward +Infinity)", () => {
    expect(snapToGrid(12)).toBe(24);
  });
});

describe("snapPositionToGrid", () => {
  it("snaps both x and y axes to the nearest grid line", () => {
    expect(snapPositionToGrid({ x: 11, y: 11 })).toEqual({ x: 0, y: 0 });
  });

  it("snaps each axis independently", () => {
    // x=24 is already aligned; y=12 rounds up to 24
    expect(snapPositionToGrid({ x: 24, y: 12 })).toEqual({ x: 24, y: 24 });
  });
});

describe("findNonOverlappingPosition", () => {
  it("returns the snapped requested position when no existing nodes", () => {
    // snapToGrid(100) = 96  (Math.round(100/24)*24 = Math.round(4.167)*24 = 4*24 = 96)
    expect(findNonOverlappingPosition(100, 100, 200, 100, [])).toEqual({
      x: 96,
      y: 96,
    });
  });

  it("returns a position that does not overlap the existing node when there is a collision", () => {
    const blocker = makeNode("b", {
      position: { x: 0, y: 0 },
      size: { width: 200, height: 100 },
    });
    const pos = findNonOverlappingPosition(0, 0, 200, 100, [blocker]);
    // The algorithm uses a 16-px padding to detect overlaps, so the new
    // rectangle must clear the blocker by at least that margin.
    const overlaps =
      pos.x < blocker.position.x + blocker.size.width + 16 &&
      pos.x + 200 > blocker.position.x - 16 &&
      pos.y < blocker.position.y + blocker.size.height + 16 &&
      pos.y + 100 > blocker.position.y - 16;
    expect(overlaps).toBe(false);
  });

  it("returned position is always grid-aligned (multiple of 24)", () => {
    const blocker = makeNode("b", {
      position: { x: 0, y: 0 },
      size: { width: 200, height: 100 },
    });
    const pos = findNonOverlappingPosition(0, 0, 200, 100, [blocker]);
    expect(pos.x % GRID_SNAP).toBe(0);
    expect(pos.y % GRID_SNAP).toBe(0);
  });

  it("prefers moving right over moving down when the right slot is free", () => {
    const blocker = makeNode("b", {
      position: { x: 0, y: 0 },
      size: { width: 200, height: 100 },
    });
    // Right is tried first in the direction priority list; result has
    // x > 0 (shifted right) and y == 0 (not shifted down).
    const pos = findNonOverlappingPosition(0, 0, 200, 100, [blocker]);
    expect(pos.x).toBeGreaterThan(0);
    expect(pos.y).toBe(0);
  });
});

describe("pushNodesFromRect", () => {
  const rect = { x: 0, y: 0, width: 200, height: 100 };

  it("returns an empty array when no nodes overlap the rect", () => {
    const far = makeNode("far", {
      position: { x: 500, y: 500 },
      size: { width: 100, height: 100 },
    });
    expect(pushNodesFromRect(rect, [far], new Set())).toHaveLength(0);
  });

  it("returns a move for each node that overlaps the rect", () => {
    const inside = makeNode("inside", {
      position: { x: 50, y: 30 },
      size: { width: 80, height: 50 },
    });
    const moves = pushNodesFromRect(rect, [inside], new Set());
    expect(moves).toHaveLength(1);
    expect(moves[0]?.id).toBe("inside");
  });

  it("excluded ids are never moved even when they overlap the rect", () => {
    const inside = makeNode("inside", {
      position: { x: 50, y: 30 },
      size: { width: 80, height: 50 },
    });
    const moves = pushNodesFromRect(rect, [inside], new Set(["inside"]));
    expect(moves).toHaveLength(0);
  });

  it('direction "right": moves node past the rect\'s right edge; y is snapped from original', () => {
    // Node at y=48 (already grid-aligned) inside the rect
    const node = makeNode("n", {
      position: { x: 50, y: 48 },
      size: { width: 100, height: 50 },
    });
    const [move] = pushNodesFromRect(rect, [node], new Set(), "right");
    // x = snapToGrid(0 + 200 + 16) = snapToGrid(216) = 216
    expect(move?.position.x).toBe(216);
    // y snapped from original: snapToGrid(48) = 48
    expect(move?.position.y).toBe(48);
  });

  it('direction "down": moves node past the rect\'s bottom edge; x is snapped from original', () => {
    // Node at x=48 (already grid-aligned) inside the rect
    const node = makeNode("n", {
      position: { x: 48, y: 30 },
      size: { width: 100, height: 50 },
    });
    const [move] = pushNodesFromRect(rect, [node], new Set(), "down");
    // y = snapToGrid(0 + 100 + 16) = snapToGrid(116) = 120
    expect(move?.position.y).toBe(120);
    // x snapped from original: snapToGrid(48) = 48
    expect(move?.position.x).toBe(48);
  });
});
