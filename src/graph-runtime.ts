/**
 * Graph Runtime — manages edges and routes messages between nodes.
 *
 * This is the execution layer for the graph document. It provides:
 * - Edge state management (add/remove/query)
 * - Message dispatch: send a message out of a port, and it arrives
 *   at every connected input port on other nodes.
 * - A React-friendly reducer for edge state.
 */

import type { GraphEdge, GraphDocument, EdgeMessage } from "./graph.ts";
import { canConnect, isPortOpen, getPortDef, getAllContracts } from "./graph.ts";

// ── Edge state reducer ──────────────────────────────────

export type GraphAction =
  | { type: "ADD_EDGE"; edge: GraphEdge }
  | { type: "REMOVE_EDGE"; id: string }
  | { type: "REMOVE_EDGES_FOR_NODE"; nodeId: string }
  | { type: "SET_EDGES"; edges: GraphEdge[] };

export function graphReducer(
  state: GraphDocument,
  action: GraphAction,
): GraphDocument {
  switch (action.type) {
    case "ADD_EDGE": {
      const exists = state.edges.some(
        (e) =>
          e.sourceNodeId === action.edge.sourceNodeId &&
          e.sourcePortId === action.edge.sourcePortId &&
          e.targetNodeId === action.edge.targetNodeId &&
          e.targetPortId === action.edge.targetPortId,
      );
      if (exists) return state;
      return { edges: [...state.edges, action.edge] };
    }
    case "REMOVE_EDGE":
      return { edges: state.edges.filter((e) => e.id !== action.id) };
    case "REMOVE_EDGES_FOR_NODE":
      return {
        edges: state.edges.filter(
          (e) =>
            e.sourceNodeId !== action.nodeId &&
            e.targetNodeId !== action.nodeId,
        ),
      };
    case "SET_EDGES":
      return { edges: action.edges };
  }
}

// ── Query helpers ───────────────────────────────────────

export function getEdgesFrom(
  graph: GraphDocument,
  nodeId: string,
  portId?: string,
): GraphEdge[] {
  return graph.edges.filter(
    (e) =>
      e.sourceNodeId === nodeId &&
      (portId === undefined || e.sourcePortId === portId),
  );
}

export function getEdgesTo(
  graph: GraphDocument,
  nodeId: string,
  portId?: string,
): GraphEdge[] {
  return graph.edges.filter(
    (e) =>
      e.targetNodeId === nodeId &&
      (portId === undefined || e.targetPortId === portId),
  );
}

export function getConnectedNodeIds(
  graph: GraphDocument,
  nodeId: string,
  portId: string,
): string[] {
  let port;
  for (const contract of getAllContracts()) {
    port = contract.ports.find((p) => p.id === portId);
    if (port) break;
  }
  if (!port) return [];
  if (port.direction === "output") {
    return getEdgesFrom(graph, nodeId, portId).map((e) => e.targetNodeId);
  }
  return getEdgesTo(graph, nodeId, portId).map((e) => e.sourceNodeId);
}

// ── Message routing ─────────────────────────────────────

export type MessageHandler = (
  targetNodeId: string,
  targetPortId: string,
  message: EdgeMessage,
) => void;

export function dispatchMessage(
  graph: GraphDocument,
  sourceNodeId: string,
  sourcePortId: string,
  message: EdgeMessage,
  handler: MessageHandler,
): void {
  const edges = getEdgesFrom(graph, sourceNodeId, sourcePortId);
  for (const edge of edges) {
    handler(edge.targetNodeId, edge.targetPortId, message);
  }
}

// ── Edge creation helper ────────────────────────────────

let edgeCounter = 0;

export function createEdge(
  sourceNodeId: string,
  sourcePortId: string,
  sourceNodeType: string,
  targetNodeId: string,
  targetPortId: string,
  targetNodeType: string,
  /** Optional — pass target node data to enable state-aware guards (e.g. context port lock) */
  targetNodeData?: unknown,
): GraphEdge | null {
  if (!canConnect(sourceNodeType, sourcePortId, targetNodeType, targetPortId)) {
    return null;
  }
  // Lifecycle guard: consult the target port's lifecycle callback
  if (
    targetNodeData !== undefined &&
    !isPortOpen(targetNodeType, targetPortId, targetNodeData)
  ) {
    return null;
  }
  const srcPort = getPortDef(sourceNodeType, sourcePortId);
  if (!srcPort) return null;

  edgeCounter += 1;
  return {
    id: `edge-${Date.now().toString(36)}-${edgeCounter}`,
    sourceNodeId,
    sourcePortId,
    targetNodeId,
    targetPortId,
    protocol: srcPort.protocol,
  };
}
