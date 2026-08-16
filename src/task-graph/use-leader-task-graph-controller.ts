import { useCallback, useEffect, useState } from "react";
import type { SocketSubscribeLike } from "../use-socket.ts";
import { useTaskGraphView } from "./use-task-graph-view.ts";

export function useLeaderTaskGraphController(input: {
  workItemId: string | null;
  socketSend?: ((data: unknown) => void) | undefined;
  socketSubscribe?: SocketSubscribeLike;
}) {
  const [open, setOpen] = useState(false);
  const projection = useTaskGraphView({ workItemId: input.workItemId,
    send: input.socketSend, subscribe: input.socketSubscribe });
  useEffect(() => setOpen(false), [input.workItemId]);
  const openInspector = useCallback(() => setOpen(true), []);
  const closeInspector = useCallback(() => setOpen(false), []);
  return { ...projection, open, openInspector, closeInspector };
}

export type LeaderTaskGraphController = ReturnType<typeof useLeaderTaskGraphController>;
