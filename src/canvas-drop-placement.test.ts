import { describe, expect, it } from "vitest";
import { canvasDropPlacement } from "./canvas-drop-placement.ts";
import type { CanvasNode } from "./types.ts";

const node = (id: string, type: string, x: number, y: number, data = {}): CanvasNode =>
  ({ id, type, position: { x, y }, size: { width: 200, height: 100 }, data });

describe("canvas drop placement", () => {
  const leader = node("leader", "leader", 211, 5);
  const minion = node("minion", "minion", 211, 125, { leaderId: "leader" });
  const obstacle = node("obstacle", "note", 220, 0);
  const nodes = [leader, minion, obstacle];

  it("keeps the minion offset when snapping a leader cluster away from an obstacle", () => {
    const moves = canvasDropPlacement(leader, nodes, nodes, new Set(["leader"]));
    expect(moves.map(m => m.id)).toEqual(["leader", "minion"]);
    expect(moves[0]!.position).not.toEqual(leader.position);
    expect(moves[1]!.position.x - moves[0]!.position.x).toBe(0);
    expect(moves[1]!.position.y - moves[0]!.position.y).toBe(120);
    expect(leader.position).toEqual({ x: 211, y: 5 });
  });

  it("preserves exact coordinates with tidy disabled or a multi-selection", () => {
    for (const [selection, tidy] of [[new Set(["leader"]), false], [new Set(["leader", "minion"]), true]] as const) {
      const moves = canvasDropPlacement(leader, nodes, nodes, selection, tidy);
      expect(moves).toEqual([{ id: "leader", position: leader.position }, { id: "minion", position: minion.position }]);
    }
  });

  it("ignores parked obstacles and context frames", () => {
    const frame = { ...obstacle, id: "frame", type: "context-group" };
    const withoutObstacle = canvasDropPlacement(leader, nodes, [leader, minion], new Set(["leader"]));
    expect(canvasDropPlacement(leader, [...nodes, frame], [leader, minion, frame], new Set(["leader"]))).toEqual(withoutObstacle);
  });
});
