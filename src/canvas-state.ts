import { useCallback, useRef, useState } from "react";
import type { CanvasAction, CanvasNode } from "./types.ts";

export function canvasReducer(
  state: CanvasNode[],
  action: CanvasAction,
): CanvasNode[] {
  switch (action.type) {
    case "ADD_NODE":
      return [...state, action.node];
    case "REMOVE_NODE":
      return state.filter((n) => n.id !== action.id);
    case "MOVE_NODE":
      return state.map((n) =>
        n.id === action.id ? { ...n, position: action.position } : n,
      );
    case "RESIZE_NODE":
      return state.map((n) =>
        n.id === action.id ? { ...n, size: action.size } : n,
      );
    case "UPDATE_NODE_DATA":
      return state.map((n) =>
        n.id === action.id ? { ...n, data: action.data } : n,
      );
    case "SET_NODES":
      return action.nodes;
    case "MOVE_GROUP": {
      // Build a Map for O(1) lookups instead of O(n×m) Array.find per node.
      const moveMap = new Map(action.moves.map((m) => [m.id, m.position]));
      return state.map((n) => {
        const pos = moveMap.get(n.id);
        return pos ? { ...n, position: pos } : n;
      });
    }
  }
}

/** Actions that represent user edits and should be tracked in undo history */
const HISTORY_ACTIONS = new Set<CanvasAction["type"]>([
  "ADD_NODE",
  "REMOVE_NODE",
  "MOVE_NODE",
  "RESIZE_NODE",
  "UPDATE_NODE_DATA",
  "MOVE_GROUP",
]);

const MAX_HISTORY = 50;

export interface CanvasHistoryState {
  nodes: CanvasNode[];
  dispatch: (action: CanvasAction) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * Wraps `canvasReducer` with an undo/redo history stack.
 * - User-edit actions (ADD_NODE, REMOVE_NODE, MOVE_NODE, RESIZE_NODE,
 *   UPDATE_NODE_DATA, MOVE_GROUP) push to `past` and clear `future`.
 * - SET_NODES is excluded from history (used for loading saved state).
 * - `past` is capped at MAX_HISTORY (50) entries.
 */
export function useCanvasHistory(): CanvasHistoryState {
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const pastRef = useRef<CanvasNode[][]>([]);
  const futureRef = useRef<CanvasNode[][]>([]);
  const nodesRef = useRef<CanvasNode[]>(nodes);
  nodesRef.current = nodes;

  // Force re-render when past/future lengths change (for canUndo/canRedo)
  const [, setTick] = useState(0);
  const tick = useCallback(() => setTick((t) => t + 1), []);

  const dispatch = useCallback(
    (action: CanvasAction) => {
      const prev = nodesRef.current;
      const next = canvasReducer(prev, action);

      if (HISTORY_ACTIONS.has(action.type)) {
        const past = pastRef.current;
        past.push(prev);
        if (past.length > MAX_HISTORY) {
          past.splice(0, past.length - MAX_HISTORY);
        }
        futureRef.current = [];
        tick();
      }

      setNodes(next);
    },
    [tick],
  );

  const undo = useCallback(() => {
    const past = pastRef.current;
    if (past.length === 0) return;
    const previous = past.pop()!;
    futureRef.current.push(nodesRef.current);
    setNodes(previous);
    tick();
  }, [tick]);

  const redo = useCallback(() => {
    const future = futureRef.current;
    if (future.length === 0) return;
    const next = future.pop()!;
    pastRef.current.push(nodesRef.current);
    setNodes(next);
    tick();
  }, [tick]);

  return {
    nodes,
    dispatch,
    undo,
    redo,
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
  };
}

let counter = 0;
export function generateId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}
