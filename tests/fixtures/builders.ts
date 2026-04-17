/**
 * Shared test fixture builders.
 *
 * Small factory functions used by colocated tests to build canonical
 * shapes (nodes, edges, port defs) without each test re-declaring its
 * own object literals.
 *
 * Convention: every builder accepts an `overrides` partial so tests can
 * pin only the fields that matter to them.
 */

import type { CanvasNode, Position, Size } from "../../src/types.ts";
import type { GraphEdge, EdgeMessage } from "../../src/graph.ts";

export function makeNode<T = unknown>(
  id: string,
  overrides: Partial<CanvasNode<T>> = {},
): CanvasNode<T> {
  return {
    id,
    type: "test",
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    data: {} as T,
    ...overrides,
  };
}

export function makeLeader(
  id: string,
  overrides: Partial<CanvasNode> = {},
): CanvasNode {
  return makeNode(id, {
    type: "leader",
    size: { width: 320, height: 200 },
    ...overrides,
  });
}

export function makeMinion(
  id: string,
  overrides: Partial<CanvasNode> = {},
): CanvasNode {
  return makeNode(id, {
    type: "minion",
    size: { width: 280, height: 160 },
    ...overrides,
  });
}

export function makeEdge(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  overrides: Partial<GraphEdge> = {},
): GraphEdge {
  return {
    id,
    sourceNodeId,
    sourcePortId: "task-out",
    targetNodeId,
    targetPortId: "task-in",
    protocol: "task-assignment",
    ...overrides,
  };
}

export function makePosition(x: number, y: number): Position {
  return { x, y };
}

export function makeSize(width: number, height: number): Size {
  return { width, height };
}

export function taskAssignment(taskId: string): EdgeMessage {
  return {
    protocol: "task-assignment",
    payload: {
      taskId,
      title: `task ${taskId}`,
      description: "",
      priority: "medium",
      assignedAt: 0,
    },
  };
}
