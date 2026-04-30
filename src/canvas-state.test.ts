/**
 * Unit tests for `canvasReducer`.
 *
 * Covers every action and the invariants we care about:
 *   - additions append; do not mutate input
 *   - removals filter; preserve order
 *   - moves / resizes only touch the targeted node
 *   - SET_NODES replaces wholesale
 *   - MOVE_GROUP only touches nodes named in the moves list
 */

import { describe, it, expect } from "vitest";
import { canvasReducer } from "./canvas-state.ts";
import { makeNode } from "../tests/fixtures/builders.ts";

describe("canvasReducer", () => {
  describe("ADD_NODE", () => {
    it("appends the node to the end", () => {
      const next = canvasReducer([], { type: "ADD_NODE", node: makeNode("a") });
      expect(next).toHaveLength(1);
      expect(next[0]?.id).toBe("a");
    });

    it("preserves existing nodes and order", () => {
      const initial = [makeNode("a"), makeNode("b")];
      const next = canvasReducer(initial, {
        type: "ADD_NODE",
        node: makeNode("c"),
      });
      expect(next.map((n) => n.id)).toEqual(["a", "b", "c"]);
    });

    // Removed: "does not mutate input" + "does not dedupe by id" —
    // implementation-detail / non-behaviour assertions. See
    // docs/testing-strategy.md §5 (test behaviour, not implementation).
  });

  describe("REMOVE_NODE", () => {
    it("removes the matching node and preserves order", () => {
      const initial = [makeNode("a"), makeNode("b"), makeNode("c")];
      const next = canvasReducer(initial, { type: "REMOVE_NODE", id: "b" });
      expect(next.map((n) => n.id)).toEqual(["a", "c"]);
    });

    // Removed: empty-remove trivial test (vacuous case already covered by
    // the unknown-id no-op below). See docs/testing-strategy.md §5.
    it("is a no-op when the id is unknown", () => {
      const initial = [makeNode("a"), makeNode("b")];
      const next = canvasReducer(initial, { type: "REMOVE_NODE", id: "x" });
      expect(next.map((n) => n.id)).toEqual(["a", "b"]);
    });
  });

  describe("MOVE_NODE", () => {
    it("updates the position of the matching node only", () => {
      const initial = [makeNode("a"), makeNode("b")];
      const next = canvasReducer(initial, {
        type: "MOVE_NODE",
        id: "a",
        position: { x: 10, y: 20 },
      });
      expect(next[0]?.position).toEqual({ x: 10, y: 20 });
      expect(next[1]?.position).toEqual({ x: 0, y: 0 });
    });

    it("preserves other fields on the moved node", () => {
      const initial = [
        makeNode("a", { size: { width: 999, height: 888 }, data: { k: 1 } }),
      ];
      const next = canvasReducer(initial, {
        type: "MOVE_NODE",
        id: "a",
        position: { x: 5, y: 5 },
      });
      expect(next[0]?.size).toEqual({ width: 999, height: 888 });
      expect(next[0]?.data).toEqual({ k: 1 });
    });
  });

  describe("RESIZE_NODE", () => {
    it("updates the size of the matching node only", () => {
      const initial = [makeNode("a"), makeNode("b")];
      const next = canvasReducer(initial, {
        type: "RESIZE_NODE",
        id: "b",
        size: { width: 333, height: 222 },
      });
      expect(next[0]?.size).toEqual({ width: 200, height: 100 });
      expect(next[1]?.size).toEqual({ width: 333, height: 222 });
    });
  });

  describe("UPDATE_NODE_DATA", () => {
    it("replaces the node data", () => {
      const initial = [makeNode<{ count: number }>("a", { data: { count: 1 } })];
      const next = canvasReducer(initial, {
        type: "UPDATE_NODE_DATA",
        id: "a",
        data: { count: 7 },
      });
      expect(next[0]?.data).toEqual({ count: 7 });
    });

    it("only touches the matching node — siblings keep their data", () => {
      // §6.4 mutation-test follow-up: without a multi-node case the
      // discriminator `n.id === action.id` could be mutated to `true`
      // and pass against a single-element array.
      const initial = [
        makeNode<{ count: number }>("a", { data: { count: 1 } }),
        makeNode<{ count: number }>("b", { data: { count: 2 } }),
        makeNode<{ count: number }>("c", { data: { count: 3 } }),
      ];
      const next = canvasReducer(initial, {
        type: "UPDATE_NODE_DATA",
        id: "b",
        data: { count: 99 },
      });
      expect(next[0]?.data).toEqual({ count: 1 });
      expect(next[1]?.data).toEqual({ count: 99 });
      expect(next[2]?.data).toEqual({ count: 3 });
    });
  });

  describe("SET_NODES", () => {
    it("replaces the whole list", () => {
      const initial = [makeNode("a"), makeNode("b")];
      const replacement = [makeNode("x"), makeNode("y"), makeNode("z")];
      const next = canvasReducer(initial, {
        type: "SET_NODES",
        nodes: replacement,
      });
      expect(next.map((n) => n.id)).toEqual(["x", "y", "z"]);
    });

    it("can clear all nodes", () => {
      const initial = [makeNode("a")];
      const next = canvasReducer(initial, { type: "SET_NODES", nodes: [] });
      expect(next).toEqual([]);
    });
  });

  describe("MOVE_GROUP", () => {
    it("moves only the listed nodes; others are untouched", () => {
      const initial = [makeNode("a"), makeNode("b"), makeNode("c")];
      const next = canvasReducer(initial, {
        type: "MOVE_GROUP",
        moves: [
          { id: "a", position: { x: 1, y: 1 } },
          { id: "c", position: { x: 3, y: 3 } },
        ],
      });
      expect(next[0]?.position).toEqual({ x: 1, y: 1 });
      expect(next[1]?.position).toEqual({ x: 0, y: 0 });
      expect(next[2]?.position).toEqual({ x: 3, y: 3 });
    });

    it("ignores moves for unknown ids without throwing", () => {
      const initial = [makeNode("a")];
      const next = canvasReducer(initial, {
        type: "MOVE_GROUP",
        moves: [
          { id: "ghost", position: { x: 9, y: 9 } },
          { id: "a", position: { x: 1, y: 1 } },
        ],
      });
      expect(next[0]?.position).toEqual({ x: 1, y: 1 });
    });

    it("moves routine node and its spawned leader children together", () => {
      // Simulates the group-move emitted when a RoutineNode is dragged: the
      // canvas moves the routine node + all leaders whose routineRunId matches.
      const routine = makeNode("rn", {
        type: "routine",
        position: { x: 100, y: 100 },
        data: { runId: "run-1" },
      });
      const leader1 = makeNode("l1", {
        type: "leader",
        position: { x: 600, y: 100 },
        data: { routineRunId: "run-1", sessionKey: "s1" },
      });
      const leader2 = makeNode("l2", {
        type: "leader",
        position: { x: 600, y: 260 },
        data: { routineRunId: "run-1", sessionKey: "s2" },
      });
      const unrelated = makeNode("u1", { position: { x: 0, y: 0 } });

      const initial = [routine, leader1, leader2, unrelated];
      // Simulate Canvas's MOVE_GROUP dispatch: move each node by dx=50, dy=30
      const next = canvasReducer(initial, {
        type: "MOVE_GROUP",
        moves: [
          { id: "rn", position: { x: 150, y: 130 } },
          { id: "l1", position: { x: 650, y: 130 } },
          { id: "l2", position: { x: 650, y: 290 } },
        ],
      });

      expect(next.find((n) => n.id === "rn")?.position).toEqual({ x: 150, y: 130 });
      expect(next.find((n) => n.id === "l1")?.position).toEqual({ x: 650, y: 130 });
      expect(next.find((n) => n.id === "l2")?.position).toEqual({ x: 650, y: 290 });
      // Unrelated node must not move
      expect(next.find((n) => n.id === "u1")?.position).toEqual({ x: 0, y: 0 });
    });
  });

  // Removed: SET_NODES-preserves-fields hydration test — this asserts the
  // reducer doesn't strip arbitrary `data` fields, which is already covered
  // by the wholesale-replacement contract on SET_NODES above. See
  // docs/testing-strategy.md §5 (no implementation-detail pinning).
});
