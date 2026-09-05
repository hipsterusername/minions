import type { JSX } from "react";
import type {
  WorktreeContributionSnapshot,
  WorktreeLineageSnapshot,
} from "../shared/worktree-integration.ts";
import { useReviewContribution } from "./use-review-contribution.ts";
import type { SocketSubscribeLike } from "./use-socket.ts";
import "./review-feedback.css";
import "./lineage.css";

const REVIEW_TEXT = {
  pending: "review pending",
  approved: "approved",
  rejected: "rejected",
} as const;

export function LineageNodeStrip(props: {
  lineage: WorktreeLineageSnapshot;
  contribution: WorktreeContributionSnapshot | null;
  send: (data: unknown) => void;
  onExpand: () => void;
  subscribe?: SocketSubscribeLike;
  className?: string;
}): JSX.Element {
  const { lineage, send, onExpand, className } = props;
  const { contribution, pending, error, review, refresh } = useReviewContribution(props.contribution, send, props.subscribe);

  const shortId = `${lineage.id.slice(0, 12)}…`;
  const rev = contribution?.reviewState ?? "pending";
  const reviewText = rev === "approved" && contribution
    ? contribution.state === "integrated" ? "Approved · contribution integrated"
      : ["ready", "queued", "integrating"].includes(contribution.state)
        ? "Approved · awaiting integration" : REVIEW_TEXT[rev]
    : REVIEW_TEXT[rev];

  const canReview =
    contribution != null &&
    contribution.state === "ready" &&
    contribution.reviewState === "pending";

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
        <span className={`lin-rev lin-rev--${rev}`}>{reviewText}</span>
        <button
          type="button"
          className="lin-strip__expand"
          disabled={!!pending}
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
            disabled={!!pending}
            onClick={() => review("approved")}
          >
            {pending?.decision === "approved" ? "Recording approval…" : "✓ Approve contribution"}
          </button>
          <button
            type="button"
            className="lin-btn lin-btn--reject lin-btn--sm"
            disabled={!!pending}
            onClick={() => review("rejected")}
          >
            {pending?.decision === "rejected" ? "Recording request…" : "↶ Request changes"}
          </button>
        </div>
      )}

      {pending && <span className="review-feedback" role="status">Review requested…</span>}
      {error && <div className="review-feedback" role="alert">{error} <button type="button" className="lin-btn lin-btn--sm" onClick={refresh}>Refresh review status</button></div>}
      <div className="lin-strip__foot">
        {contribution
          ? `This contribution · head ${contribution.headSha ? contribution.headSha.slice(0, 7) : "pending"}`
          : "No contribution yet"}
      </div>
    </div>
  );
}
