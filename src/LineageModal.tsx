import { type JSX, useEffect, useState } from "react";
import { randomUuid } from "./random-id.ts";
import type {
  WorktreeContributionSnapshot,
  WorktreeLineageSnapshot,
} from "../shared/worktree-integration.ts";
import {
  selectLatestLineageReview,
  selectLatestQueueEntry,
  selectWorktreeContribution,
} from "./use-worktree-integration.ts";

const short = (value: string | null, length = 10) =>
  value ? value.slice(0, length) : "pending";

type Tab = "this" | "all";

/** Progressive-disclosure lineage modal — Tab A (this lineage) + Tab B (all lineages). */
export function LineageModal({
  lineage,
  workItemId,
  runKey,
  allLineages,
  send,
  onClose,
}: {
  lineage: WorktreeLineageSnapshot;
  workItemId?: string | null;
  runKey?: string | null;
  allLineages: WorktreeLineageSnapshot[];
  send: (data: unknown) => void;
  onClose: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<Tab>("this");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const command = (value: Record<string, unknown>) =>
    send({ requestId: randomUuid(), ...value });

  return (
    <div className="lin-modal__backdrop" onClick={onClose}>
      <div className="lin-modal" onClick={(event) => event.stopPropagation()}>
        <div className="lin-modal__head">
          <h3>Lineage {short(lineage.id, 12)}…</h3>
          <span className="lin-chip">{lineage.integrationState}</span>
          <span className="lin-modal__spacer" />
          {workItemId ? (
            <button
              type="button"
              className="lin-btn lin-btn--ghost lin-btn--sm"
              onClick={() =>
                command({ type: "create_worktree_lineage", workItemId })
              }
            >
              + New lineage
            </button>
          ) : null}
          <button
            type="button"
            className="lin-modal__close"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="lin-modal__tabs">
          <button
            type="button"
            className={`lin-modal__tab${tab === "this" ? " lin-modal__tab--active" : ""}`}
            onClick={() => setTab("this")}
          >
            This lineage
          </button>
          <button
            type="button"
            className={`lin-modal__tab${tab === "all" ? " lin-modal__tab--active" : ""}`}
            onClick={() => setTab("all")}
          >
            All lineages <small>· {allLineages.length}</small>
          </button>
        </div>

        <div className="lin-modal__body">
          {tab === "this" ? (
            <ThisLineageTab
              lineage={lineage}
              workItemId={workItemId ?? null}
              runKey={runKey ?? null}
              command={command}
              onMap={() => setTab("all")}
            />
          ) : (
            <AllLineagesTab
              lineage={lineage}
              workItemId={workItemId ?? null}
              allLineages={allLineages}
              command={command}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================ Tab A: this lineage

function ThisLineageTab({
  lineage,
  workItemId,
  runKey,
  command,
  onMap,
}: {
  lineage: WorktreeLineageSnapshot;
  workItemId: string | null;
  runKey: string | null;
  command: (value: Record<string, unknown>) => void;
  onMap: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selfContribution = selectWorktreeContribution(lineage, { workItemId, runKey });

  const integratedCount = lineage.contributions.filter((e) => e.state === "integrated").length;
  const discardedCount = lineage.contributions.filter((e) => e.state === "discarded").length;
  const total = lineage.contributions.length;
  const pendingCount = total - integratedCount - discardedCount;
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);

  const contributions = [...lineage.contributions].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );

  const lineageQueue = selectLatestQueueEntry(lineage, (entry) => entry.kind === "lineage");
  const lineageGates = lineage.gates.filter((gate) => gate.scope === "lineage");
  const lineageBlocked = lineageGates.some(
    (gate) => gate.status === "pending" || gate.status === "failed",
  );
  const finalReady =
    lineage.contributions.length > 0
    && lineage.contributions.every((e) => e.state === "integrated" || e.state === "discarded")
    && lineage.contributions.some((e) => e.state === "integrated")
    && lineage.status === "open"
    && lineage.integrationState === "active";
  const latestFinalReview = selectLatestLineageReview(lineage);
  const finalApproved =
    latestFinalReview?.decision === "approved"
    && latestFinalReview.reviewedHeadSha === lineage.integrationHeadSha;

  return (
    <>
      <div className="lin2-head">
        <span className="lin-chip">→ {lineage.targetRef}</span>
        <span className="lin-chip">
          head {short(lineage.integrationHeadSha ?? lineage.baseSha)}
        </span>
        <span className="lin-modal__spacer" />
        <button type="button" className="lin-btn lin-btn--ghost lin-btn--sm" onClick={onMap}>
          Map to another lineage →
        </button>
      </div>

      <div className="lin2-seg" aria-hidden>
        <i className="i" style={{ width: `${pct(integratedCount)}%` }} />
        <i className="p" style={{ width: `${pct(pendingCount)}%` }} />
        <i className="d" style={{ width: `${pct(discardedCount)}%` }} />
      </div>
      <div className="lin2-legend">
        <span><i className="lin2-sq i" /> {integratedCount} integrated</span>
        <span><i className="lin2-sq p" /> {pendingCount} pending</span>
        <span><i className="lin2-sq d" /> {discardedCount} discarded</span>
      </div>

      <div className="lin2-rail">
        <div className="lin2-stage">
          <span className="lin-dot" />
          <span>{total} contribution{total === 1 ? "" : "s"}</span>
        </div>
        <span className="lin2-arrow" aria-hidden>→</span>
        <div className="lin2-stage">
          <span className={`lin-dot ${dotForState(lineage.integrationState)}`} />
          <span>Combined<small>{lineage.integrationRef}</small></span>
        </div>
        <span className="lin2-arrow" aria-hidden>→</span>
        <div className="lin2-stage lin2-stage--target">
          <span className={`lin-dot ${lineage.status === "integrated" ? "lin-dot--ok" : ""}`.trim()} />
          <span>Target<small>{lineage.targetRef}</small></span>
        </div>
      </div>

      {lineage.integrationState === "conflicted" ? (
        <div className="lin2-alert" role="alert">
          Promotion conflict. Resolve it in the retained integration worktree, merge the latest
          target, and submit the combined head for final re-review.
        </div>
      ) : null}
      {lineageQueue?.conflictDetails ? (
        <div className="lin2-alert">
          <div>Conflicts: {lineageQueue.conflictDetails.conflicts.join(", ") || "none reported"}</div>
          <div>
            Preserved worktrees:{" "}
            {lineageQueue.conflictDetails.preservedPaths.join(", ") || "none"}
          </div>
        </div>
      ) : null}

      <div className="lin2-rows">
        {contributions.map((entry) => {
          const isSelf = !!selfContribution && selfContribution.id === entry.id;
          const selected = selectedId === entry.id;
          return (
            <div key={entry.id}>
              <button
                type="button"
                className={
                  "lin2-row"
                  + (selected ? " lin2-row--selected" : "")
                  + (entry.state === "discarded" ? " lin2-row--discarded" : "")
                }
                onClick={() => setSelectedId(selected ? null : entry.id)}
              >
                <span className="lin-dot" />
                <span className="lin2-row__who">
                  <b>{isSelf ? "This leader" : `Leader ${short(entry.workItemId, 8)}`}</b>
                  <span className="lin2-row__meta">
                    {entry.branchName} · {entry.runKeys.length} iteration
                    {entry.runKeys.length === 1 ? "" : "s"}
                  </span>
                </span>
                <span className="lin2-row__end">
                  <span className={`lin-rev lin-rev--${entry.reviewState}`}>{entry.reviewState}</span>
                  <span className="lin2-kebab" aria-hidden>⋮</span>
                </span>
              </button>
              {selected ? (
                <ContributionDetail
                  lineage={lineage}
                  entry={entry}
                  command={command}
                  finalReady={finalReady}
                  finalApproved={finalApproved}
                  lineageBlocked={lineageBlocked}
                  latestFinalReview={latestFinalReview}
                />
              ) : null}
            </div>
          );
        })}
        {total === 0 ? <div className="lin2-hint">No contributions yet.</div> : null}
      </div>
    </>
  );
}

function ContributionDetail({
  lineage,
  entry,
  command,
  finalReady,
  finalApproved,
  lineageBlocked,
  latestFinalReview,
}: {
  lineage: WorktreeLineageSnapshot;
  entry: WorktreeContributionSnapshot;
  command: (value: Record<string, unknown>) => void;
  finalReady: boolean;
  finalApproved: boolean;
  lineageBlocked: boolean;
  latestFinalReview: ReturnType<typeof selectLatestLineageReview>;
}) {
  const queue = selectLatestQueueEntry(lineage, (item) => item.contributionId === entry.id);
  const contributionGates = lineage.gates.filter(
    (gate) => gate.scope === "contribution" && gate.contributionId === entry.id,
  );
  const contributionBlocked = contributionGates.some(
    (gate) => gate.status === "pending" || gate.status === "failed",
  );

  return (
    <div className="lin2-detail">
      {entry.state === "conflicted" ? (
        <div className="lin2-alert" role="alert">
          Contribution conflict. Start a new iteration on this work item to resolve it in the
          retained contribution worktree, then submit the new head for review.
        </div>
      ) : null}
      {queue?.conflictDetails ? (
        <div className="lin2-alert">
          <div>Conflicts: {queue.conflictDetails.conflicts.join(", ") || "none reported"}</div>
          <div>
            Preserved worktrees: {queue.conflictDetails.preservedPaths.join(", ") || "none"}
          </div>
        </div>
      ) : null}

      <dl className="lin2-detail__grid">
        <div>
          <dt>State</dt>
          <dd>{entry.state} · review {entry.reviewState}</dd>
        </div>
        <div>
          <dt>Queue</dt>
          <dd>
            {queue
              ? `${queue.state}${queue.position ? ` · position ${queue.position}` : ""}`
              : "—"}
          </dd>
        </div>
        <div>
          <dt>Cleanup</dt>
          <dd>{entry.cleanupState}</dd>
        </div>
      </dl>

      {contributionGates.length > 0 ? (
        <ul className="lin2-gates" aria-label="Integration gates">
          {contributionGates.map((gate) => (
            <li key={gate.id} className="lin2-gate" data-status={gate.status}>
              {gate.name}: {gate.status}
              {gate.details ? ` — ${gate.details}` : ""}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="lin2-actions">
        {entry.state === "ready" && entry.reviewState !== "approved" ? (
          <button
            type="button"
            className="lin-btn lin-btn--approve"
            disabled={contributionBlocked}
            onClick={() =>
              command({
                type: "review_worktree_contribution",
                contributionId: entry.id,
                expectedIntegrationRevision: entry.revision,
                decision: "approved",
                actor: "user",
                summary: "Approved contribution changes",
              })
            }
          >
            Approve contribution
          </button>
        ) : null}
        {entry.state === "ready" && entry.reviewState !== "rejected" ? (
          <button
            type="button"
            className="lin-btn lin-btn--reject"
            onClick={() =>
              command({
                type: "review_worktree_contribution",
                contributionId: entry.id,
                expectedIntegrationRevision: entry.revision,
                decision: "rejected",
                actor: "user",
                summary: "Contribution needs another iteration",
              })
            }
          >
            Reject contribution
          </button>
        ) : null}
        {entry.state === "ready" && entry.reviewState === "approved" ? (
          <button
            type="button"
            className="lin-btn lin-btn--primary"
            disabled={contributionBlocked}
            onClick={() =>
              command({
                type: "enqueue_worktree_contribution",
                contributionId: entry.id,
                expectedIntegrationRevision: entry.revision,
              })
            }
          >
            Enqueue contribution
          </button>
        ) : null}
        {entry.state === "failed" ? (
          <button
            type="button"
            className="lin-btn"
            onClick={() =>
              command({
                type: "retry_worktree_contribution",
                contributionId: entry.id,
                expectedIntegrationRevision: entry.revision,
              })
            }
          >
            Retry contribution
          </button>
        ) : null}
        {!["queued", "integrating", "integrated", "discarded"].includes(entry.state) ? (
          <button
            type="button"
            className="lin-btn"
            onClick={() =>
              command({
                type: "discard_worktree_contribution",
                contributionId: entry.id,
                expectedIntegrationRevision: entry.revision,
                reason: "Discarded during integration review",
              })
            }
          >
            Discard contribution
          </button>
        ) : null}
        {finalReady && !finalApproved ? (
          <button
            type="button"
            className="lin-btn lin-btn--approve"
            disabled={lineageBlocked}
            onClick={() =>
              command({
                type: "review_worktree_lineage",
                lineageId: lineage.id,
                expectedIntegrationRevision: lineage.revision,
                decision: "approved",
                actor: "user",
                summary: "Approved final combined lineage",
              })
            }
          >
            Approve combined lineage
          </button>
        ) : null}
        {finalReady && latestFinalReview?.decision !== "rejected" ? (
          <button
            type="button"
            className="lin-btn lin-btn--reject"
            onClick={() =>
              command({
                type: "review_worktree_lineage",
                lineageId: lineage.id,
                expectedIntegrationRevision: lineage.revision,
                decision: "rejected",
                actor: "user",
                summary: "Combined lineage needs another iteration",
              })
            }
          >
            Reject combined lineage
          </button>
        ) : null}
        {finalReady && finalApproved ? (
          <button
            type="button"
            className="lin-btn lin-btn--primary"
            disabled={lineageBlocked}
            onClick={() =>
              command({
                type: "promote_worktree_lineage",
                lineageId: lineage.id,
                expectedIntegrationRevision: lineage.revision,
              })
            }
          >
            Promote to {lineage.targetRef}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function dotForState(state: WorktreeLineageSnapshot["integrationState"]): string {
  switch (state) {
    case "integrated":
      return "lin-dot--ok";
    case "queued":
    case "integrating":
      return "lin-dot--run";
    case "conflicted":
      return "lin-dot--err";
    case "abandoned":
      return "lin-dot--idle";
    default:
      return "";
  }
}

// ============================================================ Tab B: all lineages

function AllLineagesTab({
  lineage,
  workItemId,
  allLineages,
  command,
}: {
  lineage: WorktreeLineageSnapshot;
  workItemId: string | null;
  allLineages: WorktreeLineageSnapshot[];
  command: (value: Record<string, unknown>) => void;
}) {
  const candidates = allLineages.filter((l) => l.id !== lineage.id && l.status === "open");
  const [chosen, setChosen] = useState<string>("");
  const selectedId = chosen || candidates[0]?.id || "";
  const selectedLineage = candidates.find((l) => l.id === selectedId) ?? null;
  const canMap = !!workItemId && candidates.length > 0;

  return (
    <>
      <div className="lin3-list">
        {allLineages.map((l) => {
          const isCurrent = l.id === lineage.id;
          const leaders = l.memberships.filter((m) => m.status === "active").length;
          return (
            <div
              key={l.id}
              className={`lin3-item${isCurrent ? " lin3-item--current" : ""}`}
            >
              <span className="lin3-item__id" title={l.id}>{short(l.id, 12)}…</span>
              <span className="lin3-item__meta">
                {l.contributions.length} contributions · {leaders} leaders · → {l.targetRef}
              </span>
              <span className="lin-chip">{l.integrationState}</span>
              {isCurrent ? <span className="lin3-item__cur">current</span> : null}
            </div>
          );
        })}
        {allLineages.length <= 1 ? (
          <div className="lin3-empty">No other lineages in this project yet.</div>
        ) : null}
      </div>

      <div className="lin3-map">
        <h4>Map this leader to an active lineage</h4>
        <p>Combine this leader's work item into another open lineage.</p>
        <div className="lin3-map__row">
          <select
            aria-label="Target lineage"
            value={selectedId}
            disabled={!canMap}
            onChange={(event) => setChosen(event.target.value)}
          >
            {candidates.length === 0 ? (
              <option value="">No active lineages available</option>
            ) : (
              candidates.map((l) => (
                <option key={l.id} value={l.id}>
                  {short(l.id, 12)}… · → {l.targetRef}
                </option>
              ))
            )}
          </select>
          <button
            type="button"
            className="lin-btn lin-btn--primary lin-btn--sm"
            disabled={!canMap || !selectedLineage}
            onClick={() => {
              if (!workItemId || !selectedLineage) return;
              command({
                type: "join_worktree_lineage",
                workItemId,
                lineageId: selectedLineage.id,
                expectedIntegrationRevision: selectedLineage.revision,
                actor: "user",
              });
            }}
          >
            Map
          </button>
        </div>
        <div className="lin3-map__note">
          Mapping locks before the first worktree run — a leader can only join a lineage while its
          work item has not yet provisioned a worktree.
        </div>
      </div>
    </>
  );
}
