import { useCallback, useRef, useState } from "react";
import type { CanvasAction, CanvasNode } from "./types.ts";
import { activeWorkspaceId, createZone, GLOBAL_WORKSPACE_ID, moveToZone, readZones, zoneMembership, ZONE_NODE_TYPE } from "./canvas-zones.ts";

export function canvasReducer(
  state: CanvasNode[],
  action: CanvasAction,
): CanvasNode[] {
  switch (action.type) {
    case "SET_ACTIVE_WORKSPACE": {
      const id = action.id === GLOBAL_WORKSPACE_ID || readZones(state).some(z => z.id === action.id) ? action.id : GLOBAL_WORKSPACE_ID;
      const global = createZone(GLOBAL_WORKSPACE_ID, "Global");
      return [...state.filter(n => n.id !== GLOBAL_WORKSPACE_ID), { ...global, data: { ...global.data, activeWorkspaceId: id } }];
    }
    case "UPDATE_ZONES": {
      // Apply membership and placement atomically, preserving live session data.
      const positions = new Map(action.moves.map((move) => [move.id, move.position]));
      const content = state.filter((node) => node.type !== ZONE_NODE_TYPE || node.id === GLOBAL_WORKSPACE_ID).map((node) => {
        const position = positions.get(node.id);
        return position ? { ...node, position } : node;
      });
      return [...content, ...readZones([...content, ...action.zones.filter(node => node.id !== GLOBAL_WORKSPACE_ID)])];
    }
    case "ADD_NODE": {
      const next = [...state, action.node];
      const owner = (action.node.data as { leaderId?: string } | null)?.leaderId;
      const owned = (action.node.type === "minion" || action.node.type === "render") && owner && state.some(n => n.id === owner && n.type === "leader");
      const workspace = owned ? zoneMembership(state).get(owner)?.id ?? GLOBAL_WORKSPACE_ID : activeWorkspaceId(state);
      if (action.node.type === ZONE_NODE_TYPE || workspace === GLOBAL_WORKSPACE_ID) return next;
      const content = next.filter(n => n.type !== ZONE_NODE_TYPE || n.id === GLOBAL_WORKSPACE_ID);
      return [...content, ...readZones([...content, ...moveToZone(readZones(next), [action.node.id], workspace)])];
    }
    case "REMOVE_NODE":
      return state.filter((n) => (n.id !== action.id || n.id === GLOBAL_WORKSPACE_ID));
    case "REMOVE_NODES": {
      const ids = new Set(action.ids);
      return state.filter((node) => (!ids.has(node.id) || node.id === GLOBAL_WORKSPACE_ID));
    }
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
        n.id === action.id && n.id !== GLOBAL_WORKSPACE_ID ? { ...n, data: action.data } : n,
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
  "REMOVE_NODES",
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

  const dispatch = useCallback((action: CanvasAction) => {
    const prev = nodesRef.current;
    const next = canvasReducer(prev, action);

    if (HISTORY_ACTIONS.has(action.type)) {
      const past = pastRef.current;
      past.push(prev);
      if (past.length > MAX_HISTORY) {
        past.splice(0, past.length - MAX_HISTORY);
      }
      futureRef.current = [];
    }

    nodesRef.current = next;
    setNodes(next);
  }, []);

  const undo = useCallback(() => {
    const past = pastRef.current;
    if (past.length === 0) return;
    const previous = past.pop()!;
    futureRef.current.push(nodesRef.current);
    nodesRef.current = previous;
    setNodes(previous);
  }, []);

  const redo = useCallback(() => {
    const future = futureRef.current;
    if (future.length === 0) return;
    const next = future.pop()!;
    pastRef.current.push(nodesRef.current);
    nodesRef.current = next;
    setNodes(next);
  }, []);

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
