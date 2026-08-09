import { useCallback, useEffect, useState } from "react";

import type { WorktreeLineageSnapshot } from "../shared/worktree-integration.ts";
import { randomUuid } from "./random-id.ts";
import {
  subscribeSocketTopic,
  type ServerMessage,
  type SocketSubscribeLike,
} from "./use-socket.ts";

type Send = (data: unknown) => void;

/**
 * Big-picture data source for View 3 ("All lineages"): requests every worktree
 * lineage in the current project via `list_worktree_lineages` and keeps the
 * latest `worktree_lineages_list` response.
 *
 * Kept deliberately separate from `useWorktreeIntegration` (which tracks the
 * single lineage bound to one work item) so the modal can stay presentational
 * and receive `allLineages` as a prop.
 */
export function useProjectLineages(input: {
  send?: Send | undefined;
  subscribe?: SocketSubscribeLike;
  /** Only fetch while true (e.g. the modal is open). Defaults to true. */
  enabled?: boolean;
}) {
  const enabled = input.enabled ?? true;
  const [allLineages, setAllLineages] = useState<WorktreeLineageSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!input.send) return;
    input.send({ type: "list_worktree_lineages", requestId: randomUuid() });
  }, [input.send]);

  useEffect(() => {
    if (!enabled || !input.subscribe) return;
    const unsubscribe = subscribeSocketTopic(input.subscribe, "*", (raw) => {
      const message = raw as ServerMessage;
      if (message.type !== "worktree_lineages_list") return;
      setAllLineages(message.lineages ?? []);
      setError(message.error ?? null);
    });
    return () => unsubscribe?.();
  }, [enabled, input.subscribe]);

  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, refresh]);

  return { allLineages, error, refresh };
}
