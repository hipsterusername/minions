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

    it("does not mutate the input state", () => {
      const state = emptyGraph();
      graphReducer(state, { type: "ADD_EDGE", edge: makeEdge("e1", "a", "b") });
      expect(state.edges).toHaveLength(0);
    });

    it("is idempotent when source, source-port, target, and target-port all match", () => {
      const edge = makeEdge("e1", "leader-1", "minion-1");
      const state: GraphDocument = { edges: [edge] };
      // Different id but same connection points → should deduplicate
      const duplicate = makeEdge("e2", "leader-1", "minion-1");
      const next = graphReducer(state, { type: "ADD_EDGE", edge: duplicate });
      expect(next.edges).toHaveLength(1);
      expect(next).toBe(state); // same reference returned
    });

    it("allows a second edge to a different target", () => {
      const e1 = makeEdge("e1", "leader-1", "minion-1");
      const state: GraphDocument = { edges: [e1] };
      const e2 = makeEdge("e2", "leader-1", "minion-2");
      const next = graphReducer(state, { type: "ADD_EDGE", edge: e2 });
      expect(next.edges).toHaveLength(2);
    });
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

  it("includes a non-empty id string on each edge", () => {
    const edge = createEdge(
      "leader-1", "task-out", "leader",
      "minion-1", "task-in", "minion",
    );
    expect(typeof edge?.id).toBe("string");
    expect(edge?.id.length).toBeGreaterThan(0);
  });
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
  it("delivers exactly once per edge (no duplicates)", () => {
    // Even with two edges to the same target, handler is called twice
    // (once per edge — each edge is a distinct delivery)
    const graph: GraphDocument = {
      edges: [
        makeEdge("e1", "leader-1", "minion-1"),
        makeEdge("e2", "leader-1", "minion-1", {
          sourcePortId: "task-out",
          targetPortId: "task-in",
        }),
      ],
    };
    const handler = vi.fn();
    dispatchMessage(graph, "leader-1", "task-out", taskAssignment("t1"), handler);
    // graphReducer prevents adding duplicate edges (same source+target+ports),
    // but if two edges exist, both are delivered
    expect(handler).toHaveBeenCalledTimes(2);
  });

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

describe("port visibility — no hidden ports", () => {
  it("LEADER_CONTRACT has no hidden ports", () => {
    const { LEADER_CONTRACT } = require("./graph.ts");
    for (const port of LEADER_CONTRACT.ports) {
      expect(port).not.toHaveProperty("hidden");
    }
  });

  it("MINION_CONTRACT has no hidden ports", () => {
    const { MINION_CONTRACT } = require("./graph.ts");
    for (const port of MINION_CONTRACT.ports) {
      expect(port).not.toHaveProperty("hidden");
    }
  });

  it("all leader task ports have anchorY for stable positioning", () => {
    const { LEADER_CONTRACT } = require("./graph.ts");
    const taskPorts = LEADER_CONTRACT.ports.filter(
      (p: { protocol: string }) => p.protocol !== "context",
    );
    for (const port of taskPorts) {
      expect(port.anchorY).toBeGreaterThan(0);
      expect(port.anchorY).toBeLessThan(1);
    }
  });

  it("all minion ports have anchorY for stable positioning", () => {
    const { MINION_CONTRACT } = require("./graph.ts");
    for (const port of MINION_CONTRACT.ports) {
      expect(port.anchorY).toBeGreaterThan(0);
      expect(port.anchorY).toBeLessThan(1);
    }
  });
});
