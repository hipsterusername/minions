import type { Dispatch } from "react";

import type { WorkItemSnapshot } from "../shared/work-item-contracts.ts";
import type { GraphAction } from "./graph-runtime.ts";
import type { CanvasAction, CanvasNode } from "./types.ts";
import type { LeaderData } from "./nodes/leader/types.ts";
import { canvasDetachCommand } from "./nodes/leader/work-item.ts";

interface DetachSessionCanvasNodesOptions {
  send: (data: unknown) => void;
  dispatch: Dispatch<CanvasAction>;
  graphDispatch: Dispatch<GraphAction>;
  /** Fresh canonical state used when a reloaded node has not rehydrated yet. */
  workItem?: WorkItemSnapshot | null;
}

export interface CanvasSessionIdentity {
  sessionKey: string;
  workItemId?: string | null;
}

/**
 * Remove every canvas representation of a session, including its graph edges.
 * Canonical leaders also detach their durable canvas binding before the local
 * node disappears.
 */
export function detachSessionCanvasNodes(
  nodes: readonly CanvasNode[],
  session: CanvasSessionIdentity,
  { send, dispatch, graphDispatch, workItem }: DetachSessionCanvasNodesOptions,
): void {
  const attached = nodes.filter((node) => {
    const data = node.data as {
      sessionKey?: string | null;
      workItemId?: string | null;
    };
    if (session.workItemId) {
      return data.workItemId === session.workItemId
        || (!data.workItemId && data.sessionKey === session.sessionKey);
    }
    return data.sessionKey === session.sessionKey;
  });
  for (const node of attached) {
    if (node.type === "leader") {
      const data = node.data as LeaderData;
      const detachData = workItem && workItem.id === session.workItemId
        ? {
            ...data,
            workItemId: workItem.id,
            currentRunKey: workItem.currentRunKey,
            workItemSnapshot: workItem,
          }
        : data;
      const command = canvasDetachCommand(detachData, node.id);
      if (command) send(command);
    }
    dispatch({ type: "REMOVE_NODE", id: node.id });
    graphDispatch({ type: "REMOVE_EDGES_FOR_NODE", nodeId: node.id });
  }
}
