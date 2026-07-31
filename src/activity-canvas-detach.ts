import type { Dispatch } from "react";

import type { GraphAction } from "./graph-runtime.ts";
import type { CanvasAction, CanvasNode } from "./types.ts";
import type { LeaderData } from "./nodes/leader/types.ts";
import { canvasDetachCommand } from "./nodes/leader/work-item.ts";

interface DetachSessionCanvasNodesOptions {
  send: (data: unknown) => void;
  dispatch: Dispatch<CanvasAction>;
  graphDispatch: Dispatch<GraphAction>;
}

/**
 * Remove every canvas representation of a session, including its graph edges.
 * Canonical leaders also detach their durable canvas binding before the local
 * node disappears.
 */
export function detachSessionCanvasNodes(
  nodes: readonly CanvasNode[],
  sessionKey: string,
  { send, dispatch, graphDispatch }: DetachSessionCanvasNodesOptions,
): void {
  const attached = nodes.filter((node) =>
    (node.data as { sessionKey?: string | null }).sessionKey === sessionKey);
  for (const node of attached) {
    if (node.type === "leader") {
      const command = canvasDetachCommand(node.data as LeaderData, node.id);
      if (command) send(command);
    }
    dispatch({ type: "REMOVE_NODE", id: node.id });
    graphDispatch({ type: "REMOVE_EDGES_FOR_NODE", nodeId: node.id });
  }
}
