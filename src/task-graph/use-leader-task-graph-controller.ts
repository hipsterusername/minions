import { useCallback, useEffect, useState } from "react";
import type { SocketSubscribeLike } from "../use-socket.ts";
import { useTaskGraphView } from "./use-task-graph-view.ts";

export function useLeaderTaskGraphController(input: {
  workItemId: string | null;
  socketSend?: ((data: unknown) => void) | undefined;
  socketSubscribe?: SocketSubscribeLike;
}) {
  const [open, setOpen] = useState(false);
  const [initialSelectedNodeId, setInitialSelectedNodeId] = useState<string | null>(null);
  const projection = useTaskGraphView({ workItemId: input.workItemId,
    send: input.socketSend, subscribe: input.socketSubscribe });
  useEffect(() => {
    setOpen(false);
    setInitialSelectedNodeId(null);
  }, [input.workItemId]);
  const openInspector = useCallback(() => {
    setInitialSelectedNodeId(null);
    setOpen(true);
  }, []);
  const inspectNode = useCallback((nodeId: string) => {
    setInitialSelectedNodeId(nodeId);
    setOpen(true);
  }, []);
  const closeInspector = useCallback(() => setOpen(false), []);
  return { ...projection, open, openInspector, closeInspector, initialSelectedNodeId, inspectNode };
}

export type LeaderTaskGraphController = ReturnType<typeof useLeaderTaskGraphController>;
