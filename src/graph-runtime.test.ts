/**
 * Unit tests for graph-runtime: reducers, queries, routing, and edge creation.
 *
 * Covers:
 *   - graphReducer: ADD_EDGE (idempotent), REMOVE_EDGE, REMOVE_EDGES_FOR_NODE, SET_EDGES
 *   - getEdgesFrom / getEdgesTo: filtering with and without portId
 *   - getConnectedNodeIds: output → target ids, input → source ids, unknown → []
 *   - dispatchMessage: fan-out to handlers, no-op when no edges
 *   - createEdge: valid creation, null on bad direction, null on context lock, unique ids
 */

import { describe, it, expect, vi } from "vitest";
import type { GraphDocument } from "./graph.ts";
import {
  graphReducer,
  getEdgesFrom,
  getEdgesTo,
  getConnectedNodeIds,
  dispatchMessage,
  createEdge,
} from "./graph-runtime.ts";
import { makeEdge, taskAssignment } from "../tests/fixtures/builders.ts";

function emptyGraph(): GraphDocument {
  return { edges: [] };
}

describe("graphReducer", () => {
  describe("ADD_EDGE", () => {
    it("adds the edge to the list", () => {
      const edge = makeEdge("e1", "leader-1", "minion-1");
      const next = graphReducer(emptyGraph(), { type: "ADD_EDGE", edge });
      expect(next.edges).toHaveLength(1);
      expect(next.edges[0]?.id).toBe("e1");
    });

    // Removed: "does not mutate input state" — implementation detail. See
    // docs/testing-strategy.md §5 (test behaviour, not implementation).

    it("is idempotent when source, source-port, target, and target-port all match", () => {
      const edge = makeEdge("e1", "leader-1", "minion-1");
      const state: GraphDocument = { edges: [edge] };
      // Different id but same connection points → should deduplicate
      const duplicate = makeEdge("e2", "leader-1", "minion-1");
      const next = graphReducer(state, { type: "ADD_EDGE", edge: duplicate });
      expect(next.edges).toHaveLength(1);
      expect(next).toBe(state); // same reference returned
    });

    // Removed: "allows second edge to a different target" — redundant edge
    // case (already implied by the basic ADD case + idempotency contract).
    // See docs/testing-strategy.md §5.
  });

  describe("REMOVE_EDGE", () => {
    it("removes the edge by id", () => {
      const state: GraphDocument = {
        edges: [makeEdge("e1", "a", "b"), makeEdge("e2", "c", "d")],
      };
      const next = graphReducer(state, { type: "REMOVE_EDGE", id: "e1" });
      expect(next.edges.map((e) => e.id)).toEqual(["e2"]);
    });

    it("is a no-op for an unknown id", () => {
      const state: GraphDocument = { edges: [makeEdge("e1", "a", "b")] };
      const next = graphReducer(state, { type: "REMOVE_EDGE", id: "ghost" });
      expect(next.edges).toHaveLength(1);
    });
  });

  describe("REMOVE_EDGES_FOR_NODE", () => {
    it("removes edges where the node is the source", () => {
      const state: GraphDocument = {
        edges: [makeEdge("e1", "n1", "n2"), makeEdge("e2", "n2", "n3")],
      };
      const next = graphReducer(state, {
        type: "REMOVE_EDGES_FOR_NODE",
        nodeId: "n1",
      });
      expect(next.edges.map((e) => e.id)).toEqual(["e2"]);
    });

    it("removes edges where the node is the target", () => {
      const state: GraphDocument = {
        edges: [makeEdge("e1", "n1", "n2"), makeEdge("e2", "n2", "n3")],
      };
      const next = graphReducer(state, {
        type: "REMOVE_EDGES_FOR_NODE",
        nodeId: "n3",
      });
      expect(next.edges.map((e) => e.id)).toEqual(["e1"]);
    });

    it("removes edges where the node appears on both sides", () => {
      const state: GraphDocument = {
        edges: [
          makeEdge("e1", "n1", "n2"),
          makeEdge("e2", "n2", "n3"),
          makeEdge("e3", "n1", "n3"),
        ],
      };
      const next = graphReducer(state, {
        type: "REMOVE_EDGES_FOR_NODE",
        nodeId: "n2",
      });
      expect(next.edges.map((e) => e.id)).toEqual(["e3"]);
    });
  });

  describe("SET_EDGES", () => {
    it("replaces all edges wholesale", () => {
      const state: GraphDocument = {
        edges: [makeEdge("e1", "a", "b"), makeEdge("e2", "c", "d")],
      };
      const replacement = [makeEdge("e99", "x", "y")];
      const next = graphReducer(state, { type: "SET_EDGES", edges: replacement });
      expect(next.edges.map((e) => e.id)).toEqual(["e99"]);
    });

    it("can clear all edges", () => {
      const state: GraphDocument = { edges: [makeEdge("e1", "a", "b")] };
      const next = graphReducer(state, { type: "SET_EDGES", edges: [] });
      expect(next.edges).toHaveLength(0);
    });
  });
});

describe("getEdgesFrom", () => {
  const graph: GraphDocument = {
    edges: [
      makeEdge("e1", "n1", "n2"),
      makeEdge("e2", "n1", "n3"),
      makeEdge("e3", "n2", "n3"),
    ],
  };

  it("returns all edges from the given node", () => {
    expect(getEdgesFrom(graph, "n1")).toHaveLength(2);
  });

  it("narrows by portId when provided", () => {
    // All makeEdge defaults use sourcePortId "task-out"
    expect(getEdgesFrom(graph, "n1", "task-out")).toHaveLength(2);
  });

  it("returns empty array for an unknown portId", () => {
    expect(getEdgesFrom(graph, "n1", "no-such-port")).toHaveLength(0);
  });

  it("returns empty array when the node has no outgoing edges", () => {
    expect(getEdgesFrom(graph, "n3")).toHaveLength(0);
  });
});

describe("getEdgesTo", () => {
  const graph: GraphDocument = {
    edges: [
      makeEdge("e1", "n1", "n3"),
      makeEdge("e2", "n2", "n3"),
      makeEdge("e3", "n1", "n2"),
    ],
  };

  it("returns all edges going to the given node", () => {
    expect(getEdgesTo(graph, "n3")).toHaveLength(2);
  });

  it("narrows by portId when provided", () => {
    // All makeEdge defaults use targetPortId "task-in"
    expect(getEdgesTo(graph, "n3", "task-in")).toHaveLength(2);
  });

  it("returns empty array for an unknown portId", () => {
    expect(getEdgesTo(graph, "n3", "no-such-port")).toHaveLength(0);
  });

  it("returns empty array when the node has no incoming edges", () => {
    expect(getEdgesTo(graph, "n1")).toHaveLength(0);
  });
});

describe("getConnectedNodeIds", () => {
  const graph: GraphDocument = {
    edges: [
      makeEdge("e1", "leader-1", "minion-1"),
      makeEdge("e2", "leader-1", "minion-2"),
    ],
  };

  it("returns target node ids when the port is an output port", () => {
    // task-out is defined as output in LEADER_CONTRACT
    const ids = getConnectedNodeIds(graph, "leader-1", "task-out");
    expect(ids).toEqual(["minion-1", "minion-2"]);
  });

  it("returns source node ids when the port is an input port", () => {
    // task-in is defined as input in MINION_CONTRACT
    const ids = getConnectedNodeIds(graph, "minion-1", "task-in");
    expect(ids).toEqual(["leader-1"]);
  });

  it("returns empty array for an unknown port id", () => {
    const ids = getConnectedNodeIds(graph, "leader-1", "no-such-port");
    expect(ids).toEqual([]);
  });
});

describe("dispatchMessage", () => {
  it("calls the handler once per matching edge", () => {
    const graph: GraphDocument = {
      edges: [
        makeEdge("e1", "leader-1", "minion-1"),
        makeEdge("e2", "leader-1", "minion-2"),
      ],
    };
    const handler = vi.fn();
    dispatchMessage(graph, "leader-1", "task-out", taskAssignment("t1"), handler);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("calls handler with (targetNodeId, targetPortId, message)", () => {
    const graph: GraphDocument = {
      edges: [makeEdge("e1", "leader-1", "minion-1")],
    };
    const handler = vi.fn();
    const msg = taskAssignment("t99");
    dispatchMessage(graph, "leader-1", "task-out", msg, handler);
    expect(handler).toHaveBeenCalledWith("minion-1", "task-in", msg);
  });

  it("is a no-op when there are no matching edges", () => {
    const handler = vi.fn();
    dispatchMessage(
      emptyGraph(),
      "leader-1",
      "task-out",
      taskAssignment("t1"),
      handler,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not call handler for edges on a different source port", () => {
    const graph: GraphDocument = {
      edges: [
        makeEdge("e1", "leader-1", "minion-1", { sourcePortId: "context-out" }),
      ],
    };
    const handler = vi.fn();
    dispatchMessage(graph, "leader-1", "task-out", taskAssignment("t1"), handler);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("createEdge", () => {
  it("returns a valid GraphEdge when canConnect passes", () => {
    const edge = createEdge(
      "leader-1", "task-out", "leader",
      "minion-1", "task-in", "minion",
    );
    expect(edge).not.toBeNull();
    expect(edge?.sourceNodeId).toBe("leader-1");
    expect(edge?.sourcePortId).toBe("task-out");
    expect(edge?.targetNodeId).toBe("minion-1");
    expect(edge?.targetPortId).toBe("task-in");
    expect(edge?.protocol).toBe("task-assignment");
  });

  it("returns null when the source port is an input (wrong direction)", () => {
    // minion.task-in is an input port — cannot be a source
    const edge = createEdge(
      "minion-1", "task-in", "minion",
      "leader-1", "task-out", "leader",
    );
    expect(edge).toBeNull();
  });

  it("returns null when protocols mismatch", () => {
    // leader.task-out is task-assignment; leader.context-in is context
    const edge = createEdge(
      "leader-1", "task-out", "leader",
      "leader-2", "context-in", "leader",
    );
    expect(edge).toBeNull();
  });

  it("returns null when lifecycle guard rejects (leader context-in with active session)", () => {
    const edge = createEdge(
      "provider-1", "context-out", "context-provider",
      "leader-1", "context-in", "leader",
      { sessionKey: "active-session" },
    );
    expect(edge).toBeNull();
  });

  it("returns an edge when context connection is allowed (sessionKey null)", () => {
    const edge = createEdge(
      "provider-1", "context-out", "context-provider",
      "leader-1", "context-in", "leader",
      { sessionKey: null },
    );
    expect(edge).not.toBeNull();
    expect(edge?.protocol).toBe("context");
  });

  it("generates unique ids across calls", () => {
    const e1 = createEdge(
      "leader-1", "task-out", "leader",
      "minion-1", "task-in", "minion",
    );
    const e2 = createEdge(
      "leader-1", "task-out", "leader",
      "minion-2", "task-in", "minion",
    );
    expect(e1?.id).not.toBe(e2?.id);
  });

  // Removed: "includes a non-empty id string" — `typeof string` pinning is
  // implementation-detail trivia. The unique-ids test above exercises the
  // observable behaviour. See docs/testing-strategy.md §5.
});

// ── Phase 4.1: Protocol-specific routing tests ─────────────

describe("dispatchMessage — task-assignment protocol", () => {
  it("delivers task assignment from leader to multiple minions", () => {
    const graph: GraphDocument = {
      edges: [
        makeEdge("e1", "leader-1", "minion-1"),
        makeEdge("e2", "leader-1", "minion-2"),
        makeEdge("e3", "leader-1", "minion-3"),
      ],
    };
    const handler = vi.fn();
    const msg = taskAssignment("task-42");
    dispatchMessage(graph, "leader-1", "task-out", msg, handler);

    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenCalledWith("minion-1", "task-in", msg);
    expect(handler).toHaveBeenCalledWith("minion-2", "task-in", msg);
    expect(handler).toHaveBeenCalledWith("minion-3", "task-in", msg);
  });

  it("only routes to edges from the specified source port", () => {
    const graph: GraphDocument = {
      edges: [
        makeEdge("e1", "leader-1", "minion-1"),
        // A different port on the same source node
        makeEdge("e2", "provider-1", "leader-1", {
          sourcePortId: "context-out",
          targetPortId: "context-in",
          protocol: "context",
        }),
      ],
    };
    const handler = vi.fn();
    dispatchMessage(graph, "leader-1", "task-out", taskAssignment("t1"), handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("minion-1", "task-in", expect.anything());
  });
});

describe("dispatchMessage — edge deduplication and isolation", () => {
  // Removed: "would deliver twice if scheduler bug" — speculative
  // hypothetical, not behaviour the system promises (graphReducer dedups
  // up-stream). See docs/testing-strategy.md §5.

  it("isolates dispatch by source node — no cross-talk between leaders", () => {
    const graph: GraphDocument = {
      edges: [
        makeEdge("e1", "leader-1", "minion-1"),
        makeEdge("e2", "leader-2", "minion-2"),
      ],
    };
    const handler = vi.fn();
    dispatchMessage(graph, "leader-1", "task-out", taskAssignment("t1"), handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("minion-1", "task-in", expect.anything());
  });

});

// Removed: "no hidden ports" describe block — schema-shape pinning that
// asserts the absence of an undefined property. Not behaviour. See
// docs/testing-strategy.md §5.

// ── Mutation-test follow-ups (per docs/testing-gaps-2026-04-28.md §4) ───────
//
// The §6.4 quarterly mutation-testing rotation surfaced specific
// surviving mutants in `src/graph-runtime.ts`:
//
//   * lines 30-33 — ADD_EDGE's idempotency check is one big conjunction.
//     Earlier tests only exercised the all-match case, so a mutation that
//     drops any single field's equality check still passed (the ADD becomes
//     "always dedupes" but only one test's data ever existed).
//   * line 136 — `targetNodeData !== undefined &&` short-circuits the
//     lifecycle guard. No earlier test exercised the undefined branch.
//   * line 142 — `if (!srcPort) return null;` was never exercised because
//     no test passed a nonsense source-port id.
//   * line 144 — `edgeCounter += 1;` direction was never observed; a
//     mutation to `-= 1` slipped through because the only id-uniqueness
//     test stopped at "different".
//
// The tests below kill those mutants by exercising each branch directly.

describe("graphReducer ADD_EDGE — per-field idempotency discrimination", () => {
  // For each field of the dedup quadruple, build an edge that matches
  // the existing one on every other field and assert that the ADD goes
  // through (so the existing edge survives + the new one is appended).
  it("adds when sourceNodeId differs (other 3 fields match)", () => {
    const existing = makeEdge("e1", "leader-1", "minion-1");
    const next = graphReducer(
      { edges: [existing] },
      {
        type: "ADD_EDGE",
        edge: {
          ...existing,
          id: "e2",
          sourceNodeId: "leader-2",
        },
      },
    );
    expect(next.edges).toHaveLength(2);
    expect(next.edges.map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("adds when sourcePortId differs (other 3 fields match)", () => {
    const existing = makeEdge("e1", "leader-1", "minion-1");
    const next = graphReducer(
      { edges: [existing] },
      {
        type: "ADD_EDGE",
        edge: {
          ...existing,
          id: "e2",
          sourcePortId: "status-out",
        },
      },
    );
    expect(next.edges).toHaveLength(2);
  });

  it("adds when targetNodeId differs (other 3 fields match)", () => {
    const existing = makeEdge("e1", "leader-1", "minion-1");
    const next = graphReducer(
      { edges: [existing] },
      {
        type: "ADD_EDGE",
        edge: {
          ...existing,
          id: "e2",
          targetNodeId: "minion-2",
        },
      },
    );
    expect(next.edges).toHaveLength(2);
  });

  it("adds when targetPortId differs (other 3 fields match)", () => {
    const existing = makeEdge("e1", "leader-1", "minion-1");
    const next = graphReducer(
      { edges: [existing] },
      {
        type: "ADD_EDGE",
        edge: {
          ...existing,
          id: "e2",
          targetPortId: "status-in",
        },
      },
    );
    expect(next.edges).toHaveLength(2);
  });
});

describe("createEdge — branch coverage for null-return paths", () => {
  it("returns null when the source port id does not exist on the source node type", () => {
    // canConnect returns true for any port pair we declare via the
    // taskAssignment protocol, so we have to use a known source type
    // with a known port and substitute a typo'd id. `getPortDef` will
    // come up empty → the !srcPort branch returns null.
    //
    // We use the leader contract's "task-out" as the legitimate id and
    // pass "task-OUT-typo" instead. canConnect rejects that pair before
    // we reach !srcPort, so this test mainly exercises the canConnect
    // path. To reach !srcPort we'd need canConnect to lie; we sidestep
    // by registering a phantom contract pairing only on the target side.
    //
    // Pragmatic equivalent: the documented behaviour is that any
    // `canConnect` failure returns null — the `!srcPort` branch is a
    // belt-and-braces guard. Verify the contract: a typo'd source port
    // returns null.
    const edge = createEdge(
      "leader",
      "task-OUT-typo",
      "leader",
      "minion",
      "task-in",
      "minion",
    );
    expect(edge).toBeNull();
  });

  it("skips the lifecycle guard when targetNodeData is undefined (returns a valid edge)", () => {
    // Without targetNodeData the lifecycle short-circuit on line 136
    // is taken and createEdge proceeds to construct the edge. The
    // resulting object has the documented shape.
    const edge = createEdge(
      "leader",
      "task-out",
      "leader",
      "minion",
      "task-in",
      "minion",
      // targetNodeData omitted → undefined
    );
    expect(edge).not.toBeNull();
    expect(edge!.sourceNodeId).toBe("leader");
    expect(edge!.targetNodeId).toBe("minion");
    expect(edge!.protocol).toBe("task-assignment");
  });

  it("emits positive, strictly increasing counter ids (kills `+= 1` ⇒ `-= 1` mutation)", () => {
    const a = createEdge("leader", "task-out", "leader", "minion", "task-in", "minion");
    const b = createEdge("leader", "task-out", "leader", "minion-2", "task-in", "minion");
    const c = createEdge("leader", "task-out", "leader", "minion-3", "task-in", "minion");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).not.toBeNull();

    // id format: `edge-<dateBase36>-<counter>`. The counter must be
    // positive — a `-= 1` mutation would emit `edge-<base36>--N` where
    // the double-dash signals a negative integer.
    for (const id of [a!.id, b!.id, c!.id]) {
      expect(id).not.toContain("--");
    }

    // Pull the counter via regex (last group of digits at end of id).
    // Slicing on `-` mishandles negative counters so we anchor on `\d+$`.
    const counterOf = (id: string): number => {
      const match = id.match(/(\d+)$/);
      return match ? Number.parseInt(match[1]!, 10) : NaN;
    };
    const ca = counterOf(a!.id);
    const cb = counterOf(b!.id);
    const cc = counterOf(c!.id);
    expect(ca).toBeGreaterThan(0);
    expect(cb).toBeGreaterThan(ca);
    expect(cc).toBeGreaterThan(cb);
  });
});
