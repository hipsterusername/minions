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

    it("does not mutate the input array", () => {
      const initial = [makeNode("a")];
      canvasReducer(initial, { type: "ADD_NODE", node: makeNode("b") });
      expect(initial).toHaveLength(1);
    });

    it("does not deduplicate by id", () => {
      // The reducer is intentionally a primitive — dedup is the caller's job.
      const initial = [makeNode("a")];
      const next = canvasReducer(initial, {
        type: "ADD_NODE",
        node: makeNode("a"),
      });
      expect(next).toHaveLength(2);
    });
  });

  describe("REMOVE_NODE", () => {
    it("removes the matching node and preserves order", () => {
      const initial = [makeNode("a"), makeNode("b"), makeNode("c")];
      const next = canvasReducer(initial, { type: "REMOVE_NODE", id: "b" });
      expect(next.map((n) => n.id)).toEqual(["a", "c"]);
    });

    it("returns the same shape (empty) when removing from empty", () => {
      const next = canvasReducer([], { type: "REMOVE_NODE", id: "nope" });
      expect(next).toEqual([]);
    });

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
  });
});
