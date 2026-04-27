/**
 * Unit tests for computeAutoLayout.
 *
 * Tests cover:
 *  - empty input
 *  - isolate nodes (no cluster membership)
 *  - leader + minion via task-assignment edge
 *  - leader + context provider via context edge
 *  - leader + render dashboard linked by data.leaderId
 *  - multiple leader clusters packed left-to-right
 *  - context-group membership (members track group delta)
 *  - completeness (every input node appears in the output)
 *  - integer positions (Math.round applied)
 */

import { describe, it, expect } from "vitest";
import { computeAutoLayout } from "./auto-layout.ts";
import {
  makeLeader,
  makeMinion,
  makeNode,
  makeEdge,
} from "../tests/fixtures/builders.ts";

describe("computeAutoLayout", () => {
  it("returns [] for an empty node list", () => {
    expect(computeAutoLayout([], [])).toEqual([]);
  });

  it("returns exactly one move for a single isolate node", () => {
    const node = makeNode("a");
    const moves = computeAutoLayout([node], []);
    expect(moves).toHaveLength(1);
    expect(moves[0]?.id).toBe("a");
  });

  it("a single leader with no edges produces exactly one move", () => {
    const leader = makeLeader("l");
    const moves = computeAutoLayout([leader], []);
    expect(moves).toHaveLength(1);
    expect(moves[0]?.id).toBe("l");
  });

  it("leader with one minion: minion is placed to the right of the leader", () => {
    const leader = makeLeader("l");
    const minion = makeMinion("m");
    const edge = makeEdge("e", "l", "m");

    const moves = computeAutoLayout([leader, minion], [edge]);
    const lm = moves.find((m) => m.id === "l")!;
    const mm = moves.find((m) => m.id === "m")!;

    // Minion's left edge must be past the leader's right edge
    expect(mm.position.x).toBeGreaterThan(lm.position.x + leader.size.width);
  });

  it("leader with one context node: context node is above the leader", () => {
    const leader = makeLeader("l");
    const ctx = makeNode("ctx", { size: { width: 200, height: 100 } });
    const ctxEdge = {
      id: "e",
      sourceNodeId: ctx.id,
      sourcePortId: "context-out",
      targetNodeId: leader.id,
      targetPortId: "context-in",
      protocol: "context" as const,
    };

    const moves = computeAutoLayout([leader, ctx], [ctxEdge]);
    const lm = moves.find((m) => m.id === "l")!;
    const cm = moves.find((m) => m.id === "ctx")!;

    // Context providers are laid out above the leader
    expect(cm.position.y).toBeLessThan(lm.position.y);
  });

  it("render dashboard with data.leaderId matching the leader is placed in the children column", () => {
    const leader = makeLeader("l");
    const dashboard = makeNode("d", {
      type: "render",
      data: { leaderId: "l" },
      size: { width: 320, height: 200 },
    });

    const moves = computeAutoLayout([leader, dashboard], []);
    const lm = moves.find((m) => m.id === "l")!;
    const dm = moves.find((m) => m.id === "d")!;

    // Dashboard goes into the children column (right of the leader)
    expect(dm.position.x).toBeGreaterThan(lm.position.x + leader.size.width);
  });

  it("two leaders are packed left-to-right with a gap between their bounding boxes", () => {
    const l1 = makeLeader("l1");
    const l2 = makeLeader("l2");

    const moves = computeAutoLayout([l1, l2], []);
    const m1 = moves.find((m) => m.id === "l1")!;
    const m2 = moves.find((m) => m.id === "l2")!;

    // l2 starts after l1's right edge (bounding boxes don't overlap, with a gap)
    expect(m2.position.x).toBeGreaterThan(m1.position.x + l1.size.width);
  });

  it("context-group members move by the same delta as their group", () => {
    // Group large enough to contain the member
    const group = makeNode("g", {
      type: "context-group",
      position: { x: 100, y: 100 },
      size: { width: 400, height: 300 },
    });
    // Member positioned so its top-centre falls inside the group:
    //   cx = 200 + 50 = 250  ∈ [100, 500]
    //   cy = 150 + min(25, 36) = 175  ∈ [100, 400]
    const member = makeNode("m", {
      position: { x: 200, y: 150 },
      size: { width: 100, height: 50 },
    });

    const moves = computeAutoLayout([group, member], []);
    const gm = moves.find((m) => m.id === "g")!;
    const mm = moves.find((m) => m.id === "m")!;

    const dx = gm.position.x - group.position.x;
    const dy = gm.position.y - group.position.y;
    expect(mm.position.x).toBe(member.position.x + dx);
    expect(mm.position.y).toBe(member.position.y + dy);
  });

  it("returned moves array contains every input node", () => {
    const leader = makeLeader("l");
    const minion = makeMinion("m");
    const ctx = makeNode("c", { size: { width: 200, height: 100 } });
    const taskEdge = makeEdge("e1", "l", "m");
    const ctxEdge = {
      id: "e2",
      sourceNodeId: ctx.id,
      sourcePortId: "context-out",
      targetNodeId: leader.id,
      targetPortId: "context-in",
      protocol: "context" as const,
    };

    const moves = computeAutoLayout([leader, minion, ctx], [taskEdge, ctxEdge]);
    const ids = new Set(moves.map((m) => m.id));

    expect(ids.has("l")).toBe(true);
    expect(ids.has("m")).toBe(true);
    expect(ids.has("c")).toBe(true);
    expect(moves).toHaveLength(3);
  });

  it("chained leaders (dashboard→context-in) sequence horizontally on the same row", () => {
    // Setup:
    //   leader A owns dashboard dA (data.leaderId = "A")
    //   dA has a context edge into leader B's context-in port
    //   leader X is unrelated and should NOT split the chain
    const leaderA = makeLeader("A");
    const dashA = makeNode("dA", {
      type: "render",
      data: { leaderId: "A" },
      size: { width: 320, height: 200 },
    });
    const leaderB = makeLeader("B");
    const leaderX = makeLeader("X");

    const chainEdge = {
      id: "chain",
      sourceNodeId: dashA.id,
      sourcePortId: "context-out",
      targetNodeId: leaderB.id,
      targetPortId: "context-in",
      protocol: "context" as const,
    };

    // Pass leaderX between A and B in input order to verify chain
    // ordering wins over input order.
    const moves = computeAutoLayout(
      [leaderA, leaderX, dashA, leaderB],
      [chainEdge],
    );
    const mA = moves.find((m) => m.id === "A")!;
    const mB = moves.find((m) => m.id === "B")!;
    const mDashA = moves.find((m) => m.id === "dA")!;
    const mX = moves.find((m) => m.id === "X")!;

    // B sits to the right of A's cluster (which includes dashA on the right).
    expect(mB.position.x).toBeGreaterThan(
      mDashA.position.x + dashA.size.width,
    );
    // A and B share the same row (top y matches within the cluster's
    // own internal vertical layout — they are clusters of equal height).
    expect(mA.position.y).toBe(mB.position.y);
    // The unrelated leader X must not appear between A and B horizontally
    // on the chain row.  It either sits before A or after B (chain row
    // takes priority and X falls into a separate singleton row, so its
    // y differs from the chain row).
    expect(mX.position.y).not.toBe(mA.position.y);
  });

  it("all returned positions are integers (Math.round was applied)", () => {
    const leader = makeLeader("l");
    const minion = makeMinion("m");
    const edge = makeEdge("e", "l", "m");

    const moves = computeAutoLayout([leader, minion], [edge]);
    for (const move of moves) {
      expect(Number.isInteger(move.position.x)).toBe(true);
      expect(Number.isInteger(move.position.y)).toBe(true);
    }
  });
});
