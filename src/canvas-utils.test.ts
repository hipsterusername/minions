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
  placeAboveTopNode,
  pushNodesFromRect,
  resolveTidyDrop,
  shouldRelocateOnDrop,
  centerTransformOnRect,
  focusTransformOnRects,
  didReposition,
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

describe("centerTransformOnRect", () => {
  it("centers a rect's midpoint in the viewport at scale 1", () => {
    const t = centerTransformOnRect(
      { x: 100, y: 100, width: 200, height: 100 },
      { width: 1000, height: 600 },
      1,
    );
    // rect center = (200, 150); viewport center = (500, 300)
    // x = 500 - 200*1 = 300 ; y = 300 - 150*1 = 150
    expect(t).toEqual({ x: 300, y: 150, scale: 1 });
  });

  it("preserves (never mutates) the given zoom scale", () => {
    const t = centerTransformOnRect(
      { x: 0, y: 0, width: 400, height: 400 },
      { width: 800, height: 800 },
      0.5,
    );
    // rect center = (200, 200); x = 400 - 200*0.5 = 300
    expect(t.scale).toBe(0.5);
    expect(t).toEqual({ x: 300, y: 300, scale: 0.5 });
  });
});

describe("focusTransformOnRects", () => {
  it("zooms below the comfort floor when needed to keep the target visible", () => {
    const t = focusTransformOnRects(
      [{ x: 100, y: 200, width: 1000, height: 800 }],
      { width: 400, height: 300 },
      { padding: 50, maxScale: 1 },
    );

    expect(t?.scale).toBe(1 / 3);
    expect(t).toEqual({ x: 0, y: -50, scale: 1 / 3 });
  });

  it("centers the union of multiple targets without zooming past the maximum", () => {
    expect(focusTransformOnRects(
      [
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 300, y: 100, width: 100, height: 100 },
      ],
      { width: 1000, height: 600 },
      { padding: 50, maxScale: 1 },
    )).toEqual({ x: 300, y: 200, scale: 1 });
  });
});

describe("didReposition", () => {
  it("is false when either endpoint is missing", () => {
    expect(didReposition(null, { x: 5, y: 5 })).toBe(false);
    expect(didReposition({ x: 5, y: 5 }, undefined)).toBe(false);
  });

  it("ignores sub-threshold nudges (click jitter)", () => {
    expect(didReposition({ x: 0, y: 0 }, { x: 1, y: 1 })).toBe(false);
  });

  it("is true once the move exceeds the threshold", () => {
    expect(didReposition({ x: 0, y: 0 }, { x: 40, y: 0 })).toBe(true);
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

describe("placeAboveTopNode", () => {
  const size = { width: 320, height: 200 };
  const fallback = { x: 1000, y: 1000 };

  it("returns the fallback position when the canvas is empty", () => {
    expect(placeAboveTopNode([], size, 48, fallback)).toEqual(fallback);
  });

  it("stacks above the top-most (smallest Y) card, aligned to its X", () => {
    const nodes = [
      makeNode("a", { position: { x: 100, y: 500 } }),
      makeNode("top", { position: { x: 300, y: 200 } }),
      makeNode("c", { position: { x: 700, y: 900 } }),
    ];
    // top card at y=200; new node height 200 + gap 48 → y = 200 - 200 - 48
    expect(placeAboveTopNode(nodes, size, 48, fallback)).toEqual({
      x: 300,
      y: -48,
    });
  });

  it("uses the first card among ties on Y", () => {
    const nodes = [
      makeNode("first", { position: { x: 10, y: 100 } }),
      makeNode("second", { position: { x: 999, y: 100 } }),
    ];
    expect(placeAboveTopNode(nodes, size, 48, fallback).x).toBe(10);
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

describe("shouldRelocateOnDrop", () => {
  it("relocates a plain leader/minion drop", () => {
    expect(shouldRelocateOnDrop(makeNode("L1", { type: "leader" }), false)).toBe(true);
    expect(shouldRelocateOnDrop(makeNode("m", { type: "minion" }), false)).toBe(true);
  });

  it("skips context-group frames", () => {
    expect(
      shouldRelocateOnDrop(makeNode("g", { type: "context-group" }), false),
    ).toBe(false);
  });

  it("skips multi-select drags", () => {
    expect(shouldRelocateOnDrop(makeNode("L1", { type: "leader" }), true)).toBe(false);
  });
});

describe("resolveTidyDrop", () => {
  it("returns a zero delta for an empty mover set", () => {
    expect(resolveTidyDrop([], [])).toEqual({ dx: 0, dy: 0 });
  });

  it("snaps a lone dropped node to the grid when the spot is free", () => {
    // Node dropped at a sub-grid position with no obstacles: the delta must
    // move its origin onto the grid (snapToGrid(100)=96 → dx=-4).
    const node = makeNode("n", {
      position: { x: 100, y: 100 },
      size: { width: 200, height: 100 },
    });
    const { dx, dy } = resolveTidyDrop([node], []);
    expect(node.position.x + dx).toBe(96);
    expect(node.position.y + dy).toBe(96);
    expect((node.position.x + dx) % GRID_SNAP).toBe(0);
    expect((node.position.y + dy) % GRID_SNAP).toBe(0);
  });

  it("snaps flush to the RIGHT (tops aligned) when dropped overlapping toward the right", () => {
    const blocker = makeNode("b", {
      position: { x: 0, y: 0 },
      size: { width: 200, height: 100 },
    });
    // Dropped mostly to the right of the blocker → nearest side is the right.
    const dropped = makeNode("d", {
      position: { x: 160, y: 10 },
      size: { width: 200, height: 100 },
    });
    const { dx, dy } = resolveTidyDrop([dropped], [blocker]);
    expect(dropped.position.x + dx).toBe(216); // blocker.right(200) + gutter(16)
    expect(dropped.position.y + dy).toBe(0); // tops aligned with blocker
  });

  it("snaps flush BELOW (left edges aligned) when dropped overlapping toward the bottom", () => {
    const blocker = makeNode("b", {
      position: { x: 0, y: 0 },
      size: { width: 200, height: 100 },
    });
    // Dropped mostly below the blocker → nearest side is the bottom.
    const dropped = makeNode("d", {
      position: { x: 10, y: 80 },
      size: { width: 200, height: 100 },
    });
    const { dx, dy } = resolveTidyDrop([dropped], [blocker]);
    expect(dropped.position.x + dx).toBe(0); // left edges aligned
    expect(dropped.position.y + dy).toBe(116); // blocker.bottom(100) + gutter(16)
  });

  it("keeps a consistent 16px gutter between the two nodes", () => {
    const blocker = makeNode("b", {
      position: { x: 0, y: 0 },
      size: { width: 200, height: 100 },
    });
    const dropped = makeNode("d", {
      position: { x: 160, y: 10 },
      size: { width: 200, height: 100 },
    });
    const { dx } = resolveTidyDrop([dropped], [blocker]);
    const gap =
      dropped.position.x + dx - (blocker.position.x + blocker.size.width);
    expect(gap).toBe(16);
  });

  it("falls through to the next-nearest side when the closest one is occupied", () => {
    const blocker = makeNode("b", {
      position: { x: 0, y: 0 },
      size: { width: 200, height: 100 },
    });
    // The right slot is already taken.
    const occupied = makeNode("c", {
      position: { x: 216, y: 0 },
      size: { width: 200, height: 100 },
    });
    // Dropped overlapping only the blocker, leaning down-and-right so that,
    // once the right slot is ruled out, "below" is the next-nearest side.
    const dropped = makeNode("d", {
      position: { x: 120, y: 40 },
      size: { width: 80, height: 60 },
    });
    const { dx, dy } = resolveTidyDrop([dropped], [blocker, occupied]);
    // Right is blocked by `occupied`, so it drops to the next nearest free
    // side: flush below, left-aligned.
    expect(dropped.position.x + dx).toBe(0);
    expect(dropped.position.y + dy).toBe(116);
  });

  it("moves a cluster as one unit, preserving relative offsets and clearing the blocker", () => {
    // A leader + dashboard cluster dropped squarely onto a wide blocker.
    const leader = makeNode("leader", {
      position: { x: 0, y: 0 },
      size: { width: 200, height: 200 },
    });
    const dash = makeNode("dash", {
      position: { x: 216, y: 0 },
      size: { width: 200, height: 200 },
    });
    const blocker = makeNode("b", {
      position: { x: 0, y: 0 },
      size: { width: 400, height: 200 },
    });
    const gapBefore = dash.position.x - leader.position.x;
    const { dx, dy } = resolveTidyDrop([leader, dash], [blocker]);
    // Both move by the same delta → internal layout preserved.
    expect(dash.position.x + dx - (leader.position.x + dx)).toBe(gapBefore);
    // Dropped centred on the blocker → nearest free flush side is below.
    expect(leader.position.x + dx).toBe(0); // left aligned
    expect(leader.position.y + dy).toBe(216); // blocker.bottom(200) + gutter(16)
  });

  it("ignores obstacles that do not overlap and just grid-snaps", () => {
    const far = makeNode("far", {
      position: { x: 5000, y: 5000 },
      size: { width: 100, height: 100 },
    });
    const node = makeNode("n", {
      position: { x: 48, y: 48 },
      size: { width: 100, height: 100 },
    });
    // Already grid-aligned and clear → zero delta.
    expect(resolveTidyDrop([node], [far])).toEqual({ dx: 0, dy: 0 });
  });
});
