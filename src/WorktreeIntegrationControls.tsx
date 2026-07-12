import { randomUuid } from "./random-id.ts";
import type { WorktreeLineageSnapshot } from "../shared/worktree-integration.ts";
import { selectWorktreeContribution } from "./use-worktree-integration.ts";

export function WorktreeIntegrationControls({ lineage, workItemId, runKey, send, className = "" }: {
  lineage: WorktreeLineageSnapshot;
  workItemId?: string | null;
  runKey?: string | null;
  send: (data: unknown) => void;
  className?: string;
}) {
  const contribution = selectWorktreeContribution(lineage,
    { workItemId: workItemId ?? null, runKey: runKey ?? null });
  const contributionQueue = contribution
    ? [...lineage.queue].reverse().find((entry) => entry.contributionId === contribution.id) : null;
  const lineageQueue = [...lineage.queue].reverse().find((entry) => entry.kind === "lineage");
  const queue = contributionQueue && !["succeeded", "cancelled"].includes(contributionQueue.state)
    ? contributionQueue : lineageQueue ?? contributionQueue;
  const contributionGates = contribution
    ? lineage.gates.filter((gate) => gate.scope === "contribution" && gate.contributionId === contribution.id) : [];
  const lineageGates = lineage.gates.filter((gate) => gate.scope === "lineage");
  const contributionBlocked = contributionGates.some((gate) => gate.status === "pending" || gate.status === "failed");
  const lineageBlocked = lineageGates.some((gate) => gate.status === "pending" || gate.status === "failed");
  const finalReady = lineage.contributions.length > 0
    && lineage.contributions.every((entry) => entry.state === "integrated" || entry.state === "discarded")
    && lineage.contributions.some((entry) => entry.state === "integrated")
    && lineage.status === "open" && lineage.integrationState === "active";
  const latestFinalReview = lineage.reviews.filter((review) => review.scope === "lineage").at(-1);
  const finalApproved = latestFinalReview?.decision === "approved"
    && latestFinalReview.reviewedHeadSha === lineage.integrationHeadSha;
  const command = (value: Record<string, unknown>) => send({ requestId: randomUuid(), ...value });

  return <div className={`integration-controls ${className}`.trim()} data-testid="worktree-integration-controls">
    <div className="integration-controls__status">
      <strong>Combined lineage: {lineage.integrationState}</strong>
      {contribution ? <span>Contribution: {contribution.state} · review {contribution.reviewState}</span> : null}
      {queue ? <span>Queue: {queue.state}{queue.position ? ` · position ${queue.position}` : ""}
        {queue.error ? ` · ${queue.error}` : ""}</span> : null}
    </div>

    {contribution?.state === "conflicted" ? <div className="integration-controls__alert" role="alert">
      Contribution conflict. Start a new iteration on this work item to resolve it in the retained contribution worktree, then submit the new head for review.
    </div> : lineage.integrationState === "conflicted" ? <div className="integration-controls__alert" role="alert">
      Promotion conflict. Resolve it in the retained integration worktree, merge the latest target, and submit the combined head for final re-review.
    </div> : null}
    {queue?.conflictDetails ? <div className="integration-controls__alert">
      <div>Conflicts: {queue.conflictDetails.conflicts.join(", ") || "none reported"}</div>
      <div>Preserved worktrees: {queue.conflictDetails.preservedPaths.join(", ") || "none"}</div>
    </div> : null}
    {[...contributionGates, ...(finalReady ? lineageGates : [])].length > 0 ? <ul className="integration-controls__gates" aria-label="Integration gates">
      {[...contributionGates, ...(finalReady ? lineageGates : [])].map((gate) =>
        <li key={gate.id} data-status={gate.status}>{gate.name}: {gate.status}{gate.details ? ` — ${gate.details}` : ""}</li>)}
    </ul> : null}

    <div className="integration-controls__actions">
      {contribution && contribution.state === "ready" && contribution.reviewState !== "approved" ?
        <button type="button" disabled={contributionBlocked} onClick={() => command({ type: "review_worktree_contribution",
          contributionId: contribution.id, expectedIntegrationRevision: contribution.revision,
          decision: "approved", actor: "user", summary: "Approved contribution changes" })}>
          Approve contribution
        </button> : null}
      {contribution && contribution.state === "ready" && contribution.reviewState !== "rejected" ?
        <button type="button" onClick={() => command({ type: "review_worktree_contribution",
          contributionId: contribution.id, expectedIntegrationRevision: contribution.revision,
          decision: "rejected", actor: "user", summary: "Contribution needs another iteration" })}>
          Reject contribution
        </button> : null}
      {contribution && contribution.state === "ready" && contribution.reviewState === "approved" ?
        <button type="button" disabled={contributionBlocked} onClick={() => command({ type: "enqueue_worktree_contribution",
          contributionId: contribution.id, expectedIntegrationRevision: contribution.revision })}>
          Enqueue contribution
        </button> : null}
      {contribution && contribution.state === "failed" ?
        <button type="button" onClick={() => command({ type: "retry_worktree_contribution",
          contributionId: contribution.id, expectedIntegrationRevision: contribution.revision })}>
          Retry contribution
        </button> : null}
      {contribution && !["queued", "integrating", "integrated", "discarded"].includes(contribution.state) ?
        <button type="button" onClick={() => command({ type: "discard_worktree_contribution",
          contributionId: contribution.id, expectedIntegrationRevision: contribution.revision,
          reason: "Discarded during integration review" })}>Discard contribution</button> : null}
      {finalReady && !finalApproved ? <button type="button" disabled={lineageBlocked} onClick={() => command({
        type: "review_worktree_lineage", lineageId: lineage.id,
        expectedIntegrationRevision: lineage.revision, decision: "approved", actor: "user",
        summary: "Approved final combined lineage",
      })}>Approve combined lineage</button> : null}
      {finalReady && latestFinalReview?.decision !== "rejected" ? <button type="button" onClick={() => command({
        type: "review_worktree_lineage", lineageId: lineage.id,
        expectedIntegrationRevision: lineage.revision, decision: "rejected", actor: "user",
        summary: "Combined lineage needs another iteration",
      })}>Reject combined lineage</button> : null}
      {finalReady && finalApproved ? <button type="button" disabled={lineageBlocked} onClick={() => command({
        type: "promote_worktree_lineage", lineageId: lineage.id,
        expectedIntegrationRevision: lineage.revision,
      })}>Promote to {lineage.targetRef}</button> : null}
    </div>
  </div>;
}
