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

  it("two leaders are packed left-to-right with a gap between their bounding boxes", () => {
    const l1 = makeLeader("l1");
    const l2 = makeLeader("l2");

    const moves = computeAutoLayout([l1, l2], []);
    const m1 = moves.find((m) => m.id === "l1")!;
    const m2 = moves.find((m) => m.id === "l2")!;

    // l2 starts after l1's right edge (bounding boxes don't overlap, with a gap)
    expect(m2.position.x).toBeGreaterThan(m1.position.x + l1.size.width);
  });

  it("orders leader clusters by running status first, then last updated date", () => {
    const runningOlder = makeLeader("running-older", {
      data: {
        status: "running",
        messages: [{ id: "r", role: "assistant", content: "", timestamp: 100 }],
      },
    });
    const idleNewer = makeLeader("idle-newer", {
      data: {
        status: "idle",
        messages: [{ id: "n", role: "assistant", content: "", timestamp: 900 }],
      },
    });
    const idleOlder = makeLeader("idle-older", {
      data: {
        status: "idle",
        messages: [{ id: "o", role: "assistant", content: "", timestamp: 500 }],
      },
    });

    const moves = computeAutoLayout([idleOlder, idleNewer, runningOlder], []);
    const byX = moves
      .filter((m) =>
        ["running-older", "idle-newer", "idle-older"].includes(m.id),
      )
      .sort((a, b) => a.position.x - b.position.x)
      .map((m) => m.id);

    expect(byX).toEqual(["running-older", "idle-newer", "idle-older"]);
  });

  it("orders child agents by running status first, then last updated date", () => {
    const leader = makeLeader("l");
    const runningOlder = makeMinion("running-older", {
      data: {
        status: "running",
        messages: [{ id: "r", role: "assistant", content: "", timestamp: 100 }],
      },
    });
    const idleNewer = makeMinion("idle-newer", {
      data: {
        status: "idle",
        messages: [{ id: "n", role: "assistant", content: "", timestamp: 900 }],
      },
    });
    const idleOlder = makeMinion("idle-older", {
      data: {
        status: "idle",
        messages: [{ id: "o", role: "assistant", content: "", timestamp: 500 }],
      },
    });

    const moves = computeAutoLayout(
      [leader, idleOlder, idleNewer, runningOlder],
      [
        makeEdge("e1", "l", "idle-older"),
        makeEdge("e2", "l", "idle-newer"),
        makeEdge("e3", "l", "running-older"),
      ],
    );
    const byY = moves
      .filter((m) =>
        ["running-older", "idle-newer", "idle-older"].includes(m.id),
      )
      .sort((a, b) => a.position.y - b.position.y)
      .map((m) => m.id);

    expect(byY).toEqual(["running-older", "idle-newer", "idle-older"]);
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

  it("chained leaders (leader dashboard→context-in) stay contiguous within the shared horizontal row", () => {
    // Setup (dashboards are embedded in leaders now):
    //   leader A's context-out feeds leader B's context-in port
    //   leader X is unrelated and must not be inserted between A and B
    const leaderA = makeLeader("A");
    const leaderB = makeLeader("B");
    const leaderX = makeLeader("X");

    const chainEdge = {
      id: "chain",
      sourceNodeId: leaderA.id,
      sourcePortId: "context-out",
      targetNodeId: leaderB.id,
      targetPortId: "context-in",
      protocol: "context" as const,
    };

    // Pass leaderX between A and B in input order to verify chain
    // ordering wins over input order.
    const moves = computeAutoLayout(
      [leaderA, leaderX, leaderB],
      [chainEdge],
    );
    const mA = moves.find((m) => m.id === "A")!;
    const mB = moves.find((m) => m.id === "B")!;
    const mX = moves.find((m) => m.id === "X")!;

    // B sits to the right of A's cluster.
    expect(mB.position.x).toBeGreaterThan(
      mA.position.x + leaderA.size.width,
    );
    // A, B and the unrelated X all share the single horizontal row now
    // that connected and independent units flow together by recency.
    expect(mA.position.y).toBe(mB.position.y);
    expect(mX.position.y).toBe(mA.position.y);
    // The chain stays contiguous: X is not inserted between A and B.
    // It flows after the chain (equal freshness → later input order).
    expect(mX.position.x).toBeGreaterThan(mB.position.x);
  });

  it("packs chains and singletons into one recency-ordered horizontal row, keeping chains contiguous", () => {
    // Chain A→B (older). Standalone leader S (newer). S should sort
    // before the chain by recency, but A and B stay adjacent.
    const leaderA = makeLeader("A", {
      data: {
        messages: [{ id: "a", role: "assistant", content: "", timestamp: 100 }],
      },
    });
    const leaderB = makeLeader("B", {
      data: {
        messages: [{ id: "b", role: "assistant", content: "", timestamp: 200 }],
      },
    });
    const singleton = makeLeader("S", {
      data: {
        messages: [{ id: "s", role: "assistant", content: "", timestamp: 900 }],
      },
    });

    const chainEdge = {
      id: "chain",
      sourceNodeId: leaderA.id,
      sourcePortId: "context-out",
      targetNodeId: leaderB.id,
      targetPortId: "context-in",
      protocol: "context" as const,
    };

    const moves = computeAutoLayout(
      [leaderA, leaderB, singleton],
      [chainEdge],
    );
    const mA = moves.find((m) => m.id === "A")!;
    const mB = moves.find((m) => m.id === "B")!;
    const mS = moves.find((m) => m.id === "S")!;

    // All three units share one horizontal row.
    expect(mA.position.y).toBe(mS.position.y);
    expect(mA.position.y).toBe(mB.position.y);
    // Newer standalone leader sorts before the older chain by recency.
    expect(mS.position.x).toBeLessThan(mA.position.x);
    // Chain stays contiguous: B directly follows A, S is not between them.
    expect(mB.position.x).toBeGreaterThan(mA.position.x);
  });

});
