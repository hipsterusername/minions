import { useState } from "react";
import type { WorktreeLineageSnapshot } from "../shared/worktree-integration.ts";
import type { SocketSubscribeLike } from "./use-socket.ts";
import { selectWorktreeContribution } from "./use-worktree-integration.ts";
import { useProjectLineages } from "./use-project-lineages.ts";
import { LineageNodeStrip } from "./LineageNodeStrip.tsx";
import { LineageModal } from "./LineageModal.tsx";

/**
 * Progressive-disclosure lineage controls.
 *
 * View 1 ("in-action") is the slim {@link LineageNodeStrip} that lives inline in
 * the changes/leader surface: current lineage + Approve/Reject for a ready,
 * pending contribution. Expanding opens the {@link LineageModal}, which carries
 * View 2 ("this lineage" detail) and View 3 ("all lineages" big picture).
 *
 * The container stays thin: it selects the current contribution, owns the
 * open/closed state, and — only while the modal is open — subscribes for the
 * project-wide lineage list that feeds View 3. All actions flow out through
 * `send`; both child views are pure presentational.
 */
export function WorktreeIntegrationControls({
  lineage,
  workItemId,
  runKey,
  send,
  subscribe,
  className = "",
}: {
  lineage: WorktreeLineageSnapshot;
  workItemId?: string | null;
  runKey?: string | null;
  send: (data: unknown) => void;
  subscribe?: SocketSubscribeLike;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  const contribution = selectWorktreeContribution(lineage, {
    workItemId: workItemId ?? null,
    runKey: runKey ?? null,
  });

  const { allLineages } = useProjectLineages({
    send,
    ...(subscribe ? { subscribe } : {}),
    enabled: open,
  });

  return (
    <div
      className={`integration-controls ${className}`.trim()}
      data-testid="worktree-integration-controls"
    >
      <LineageNodeStrip
        lineage={lineage}
        contribution={contribution ?? null}
        send={send}
        onExpand={() => setOpen(true)}
      />
      {open ? (
        <LineageModal
          lineage={lineage}
          workItemId={workItemId ?? null}
          runKey={runKey ?? null}
          allLineages={allLineages}
          send={send}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
