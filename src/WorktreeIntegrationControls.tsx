import { randomUuid } from "./random-id.ts";
import type { WorktreeLineageSnapshot } from "../shared/worktree-integration.ts";
import { selectLatestLineageReview, selectLatestQueueEntry,
  selectWorktreeContribution } from "./use-worktree-integration.ts";

const short = (value: string | null, length = 10) => value ? value.slice(0, length) : "pending";

function LineageMap({ lineage, selectedContributionId }: {
  lineage: WorktreeLineageSnapshot;
  selectedContributionId?: string | null;
}) {
  const integratedCount = lineage.contributions.filter((entry) => entry.state === "integrated").length;
  const discardedCount = lineage.contributions.filter((entry) => entry.state === "discarded").length;
  const pendingCount = lineage.contributions.length - integratedCount - discardedCount;
  const contributions = [...lineage.contributions].sort((left, right) =>
    left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  return <section className="lineage-map" aria-label="Combined lineage map">
    <header className="lineage-map__header">
      <div><span>Lineage</span> <code title={lineage.id}>{short(lineage.id, 16)}</code></div>
      <div className="lineage-map__assignment">
        Set before the first worktree run · locked after provisioning
      </div>
    </header>
    <div className="lineage-map__flow">
      <div className="lineage-map__contributions" aria-label="Leader contributions">
        {contributions.map((entry) => {
          const queue = selectLatestQueueEntry(lineage, (item) => item.contributionId === entry.id);
          const selected = entry.id === selectedContributionId;
          return <article key={entry.id} className="lineage-map__node lineage-map__node--contribution"
            data-state={entry.state} data-selected={selected ? "true" : "false"}>
            <div className="lineage-map__node-title">
              <strong>{selected ? "This leader" : `Leader ${short(entry.workItemId, 8)}`}</strong>
              <span>{entry.state}</span>
            </div>
            <code title={entry.branchName}>{entry.branchName}</code>
            <div>Review: {entry.reviewState} · {entry.runKeys.length} iteration{entry.runKeys.length === 1 ? "" : "s"}</div>
            <div>Head: {short(entry.headSha)}{queue ? ` · queue ${queue.state}` : ""}</div>
          </article>;
        })}
        {lineage.contributions.length === 0 ? <div className="lineage-map__empty">No contributions yet</div> : null}
      </div>
      <div className="lineage-map__arrow" aria-hidden>→</div>
      <article className="lineage-map__node lineage-map__node--combined" data-state={lineage.integrationState}>
        <div className="lineage-map__node-title"><strong>Combined lineage</strong>
          <span>{lineage.integrationState}</span></div>
        <code title={lineage.integrationRef}>{lineage.integrationRef}</code>
        <div>Head: {short(lineage.integrationHeadSha ?? lineage.baseSha)}</div>
        <div>{integratedCount} integrated · {pendingCount} pending · {discardedCount} discarded</div>
      </article>
      <div className="lineage-map__arrow" aria-hidden>→</div>
      <article className="lineage-map__node lineage-map__node--target" data-state={lineage.status}>
        <div className="lineage-map__node-title"><strong>Target</strong><span>{lineage.status}</span></div>
        <code title={lineage.targetRef}>{lineage.targetRef}</code>
        <div>Promoted only after combined review</div>
      </article>
    </div>
    <div className="lineage-map__join-hint">
      To combine another leader, assign its work item to lineage <code>{lineage.id}</code> before its first worktree run.
    </div>
  </section>;
}

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
    ? selectLatestQueueEntry(lineage, (entry) => entry.contributionId === contribution.id) : null;
  const lineageQueue = selectLatestQueueEntry(lineage, (entry) => entry.kind === "lineage");
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
  const latestFinalReview = selectLatestLineageReview(lineage);
  const finalApproved = latestFinalReview?.decision === "approved"
    && latestFinalReview.reviewedHeadSha === lineage.integrationHeadSha;
  const command = (value: Record<string, unknown>) => send({ requestId: randomUuid(), ...value });

  return <div className={`integration-controls ${className}`.trim()} data-testid="worktree-integration-controls">
    <LineageMap lineage={lineage} selectedContributionId={contribution?.id ?? null} />
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
    <dl className="integration-controls__decision-help" role="group" aria-label="Contribution decision guide">
      <div><dt>Approve</dt><dd>Accept this exact contribution head. It remains separate until you enqueue it.</dd></div>
      <div><dt>Reject</dt><dd>Keep the contribution and worktree for another iteration; no changes enter the combined lineage.</dd></div>
      <div><dt>Discard</dt><dd>Terminally exclude this contribution from the lineage and cancel queued integration.</dd></div>
      <div><dt>New iteration</dt><dd>Reuses the same contribution branch/worktree while editable and resets review to pending.</dd></div>
    </dl>
  </div>;
}
