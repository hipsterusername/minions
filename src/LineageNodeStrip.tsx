import type { JSX } from "react";
import type {
  WorktreeContributionSnapshot,
  WorktreeLineageSnapshot,
} from "../shared/worktree-integration.ts";
import { randomUuid } from "./random-id.ts";
import "./lineage.css";

const REVIEW_TEXT = {
  pending: "review pending",
  approved: "approved",
  rejected: "rejected",
} as const;

/**
 * View 1 ("in-action") of the progressive-disclosure lineage redesign: a slim
 * strip that lives inside the leader node. Shows the current lineage, this
 * leader's review state, contribution review actions for a ready+pending contribution, and
 * an affordance to expand into the fuller modal views.
 *
 * Pure presentational — all data arrives via props, all actions go out through
 * `props.send`.
 */
export function LineageNodeStrip(props: {
  lineage: WorktreeLineageSnapshot;
  contribution: WorktreeContributionSnapshot | null;
  send: (data: unknown) => void;
  onExpand: () => void;
  className?: string;
}): JSX.Element {
  const { lineage, contribution, send, onExpand, className } = props;

  const shortId = `${lineage.id.slice(0, 12)}…`;
  const rev = contribution?.reviewState ?? "pending";

  const canReview =
    contribution != null &&
    contribution.state === "ready" &&
    contribution.reviewState === "pending";

  function review(decision: "approved" | "rejected") {
    if (!contribution) return;
    send({
      type: "review_worktree_contribution",
      requestId: randomUuid(),
      contributionId: contribution.id,
      expectedIntegrationRevision: contribution.revision,
      decision,
      actor: "user",
      summary:
        decision === "approved"
          ? "Approved contribution changes"
          : "Contribution needs another iteration",
    });
  }

  return (
    <div
      className={`lin-strip ${className ?? ""}`.trim()}
      data-testid="lineage-node-strip"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="lin-strip__head">
        <span className="lin-strip__eyebrow">Lineage</span>
        <span className="lin-strip__id">{shortId}</span>
        <span className="lin-chip">{lineage.integrationState}</span>
        <span className={`lin-rev lin-rev--${rev}`}>{REVIEW_TEXT[rev]}</span>
        <button
          type="button"
          className="lin-strip__expand"
          aria-label="Expand lineage"
          onClick={onExpand}
        >
          ⤢
        </button>
      </div>

      {canReview && (
        <div className="lin-strip__actions">
          <button
            type="button"
            className="lin-btn lin-btn--approve lin-btn--sm"
            onClick={() => review("approved")}
          >
            ✓ Approve contribution
          </button>
          <button
            type="button"
            className="lin-btn lin-btn--reject lin-btn--sm"
            onClick={() => review("rejected")}
          >
            ↶ Request changes
          </button>
        </div>
      )}

      <div className="lin-strip__foot">
        {contribution
          ? `This contribution · head ${contribution.headSha ? contribution.headSha.slice(0, 7) : "pending"}`
          : "No contribution yet"}
      </div>
    </div>
  );
}
