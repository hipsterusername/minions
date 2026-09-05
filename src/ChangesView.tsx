/**
 * Worktree review — folded into the Activity view.
 *
 * `SessionChangesPanel` renders the diff + merge/discard controls for a single
 * leader session's isolated worktree. It's shown inside the Activity
 * inspector when the selected session has reviewable changes, so review lives
 * next to where you inspect a session rather than in a separate tab.
 *
 * The heavy conflict-resolution UI still lives on the leader card; when a
 * session hits merge conflicts this panel deep-links to it via "Open in
 * Canvas" rather than duplicating that stateful flow.
 */
import { useCallback, useState } from "react";
import {
  GitMerge,
  GitBranch,
  Trash2,
  ExternalLink,
  RefreshCw,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import type { CanvasNode } from "./types.ts";
import type { LeaderData } from "./nodes/leader/types.ts";
import { ConfirmModal } from "./components/ConfirmModal.tsx";
import type { SocketSubscribe } from "./use-socket.ts";
import { useReviewDiff } from "./use-review-diff.ts";
import "./review-feedback.css";
import { randomUuid } from "./random-id.ts";
import { useWorktreeIntegration } from "./use-worktree-integration.ts";
import { WorktreeIntegrationControls } from "./WorktreeIntegrationControls.tsx";
import { selectCanvasChangeMode } from "./nodes/leader/work-item.ts";
import "./changes-view.css";

/**
 * Pure predicate: does this leader have worktree changes worth surfacing for
 * review? Kept separate + exported so it can be unit-tested and reused by the
 * Activity view to decide whether to show the review panel / changes chip.
 */
export function leaderHasReviewableChanges(data: LeaderData): boolean {
  if (!data.sessionKey) return false;
  if (selectCanvasChangeMode(data) !== "worktree") return false;
  if (data.approvalPending) return true;
  if (data.mergeConflict) return true;
  return data.worktreeStatus === "active" || data.worktreeStatus === "merging";
}

/** Count the reviewable leader nodes on the canvas (for badges/summaries). */
export function countReviewableLeaders(nodes: CanvasNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.type !== "leader") continue;
    if (leaderHasReviewableChanges(node.data as LeaderData)) n++;
  }
  return n;
}

const FILE_STATUS_COLOR: Record<string, string> = {
  added: "var(--success-color)",
  deleted: "var(--status-error)",
};
const fileStatusColor = (s: string) => FILE_STATUS_COLOR[s] ?? "var(--accent)";
const fileStatusLetter = (s: string) =>
  s === "added" ? "A" : s === "deleted" ? "D" : "M";

export function SessionChangesPanel({
  nodeId,
  sessionKey,
  data,
  socketSend,
  socketSubscribe,
  onUpdateNodeData,
  onOpenInCanvas,
}: {
  nodeId: string;
  sessionKey: string;
  data: LeaderData;
  socketSend?: ((data: unknown) => void) | undefined;
  socketSubscribe?: SocketSubscribe | undefined;
  onUpdateNodeData: (nodeId: string, data: LeaderData) => void;
  onOpenInCanvas: (nodeId: string) => void;
}) {
  if (selectCanvasChangeMode(data) !== "worktree") return null;

  return (
    <WorktreeSessionChangesPanel
      nodeId={nodeId}
      sessionKey={sessionKey}
      data={data}
      socketSend={socketSend}
      socketSubscribe={socketSubscribe}
      onUpdateNodeData={onUpdateNodeData}
      onOpenInCanvas={onOpenInCanvas}
    />
  );
}

function WorktreeSessionChangesPanel({
  nodeId,
  sessionKey,
  data,
  socketSend,
  socketSubscribe,
  onUpdateNodeData,
  onOpenInCanvas,
}: {
  nodeId: string;
  sessionKey: string;
  data: LeaderData;
  socketSend?: ((data: unknown) => void) | undefined;
  socketSubscribe?: SocketSubscribe | undefined;
  onUpdateNodeData: (nodeId: string, data: LeaderData) => void;
  onOpenInCanvas: (nodeId: string) => void;
}) {
  const { diff, loading, error: diffError, loadedAt, refresh: fetchDiff } = useReviewDiff(sessionKey, socketSend, socketSubscribe);
  const [confirm, setConfirm] = useState<"merge" | "discard" | null>(null);
  const integration = useWorktreeIntegration({ workItemId: data.workItemId ?? null,
    runKey: sessionKey, ...(socketSend ? { send: socketSend } : {}),
    ...(socketSubscribe ? { subscribe: socketSubscribe } : {}) });

  const hasConflict = !!data.mergeConflict;
  const approvalPending = !!data.approvalPending;

  const doMerge = useCallback(() => {
    if (socketSend && !data.workItemId) socketSend({ type: "approve_changes", sessionKey });
    onUpdateNodeData(nodeId, {
      ...data,
      worktreeStatus: "merging",
      approvalPending: false,
    });
    setConfirm(null);
  }, [socketSend, sessionKey, nodeId, data, onUpdateNodeData]);

  const doDiscard = useCallback(() => {
    if (socketSend && integration.contribution) socketSend({
      type: "discard_worktree_contribution", requestId: randomUuid(),
      contributionId: integration.contribution.id,
      expectedIntegrationRevision: integration.contribution.revision,
      reason: "Discarded in Changes review",
    });
    else if (socketSend && !data.workItemId) socketSend({ type: "discard_worktree", sessionKey });
    setConfirm(null);
  }, [data.workItemId, integration.contribution, socketSend, sessionKey]);

  return (
    <div className="changes-card changes-card--inline" data-testid="session-changes-panel">
      <div className="changes-card__top">
        {!data.workItemId && approvalPending && (
          <span className="changes-badge changes-badge--pending">Ready for review</span>
        )}
        {!data.workItemId && hasConflict && (
          <span className="changes-badge changes-badge--conflict">
            <AlertTriangle size={11} strokeWidth={2.5} aria-hidden /> Conflicts
          </span>
        )}
        {!data.workItemId && data.worktreeStatus === "merging" && (
          <span className="changes-badge changes-badge--merging">Merging…</span>
        )}
      </div>

      {data.worktreeBranch && (
        <div className="changes-card__branch">
          <GitBranch size={11} strokeWidth={2} aria-hidden /> {data.worktreeBranch}
        </div>
      )}

      {loading && (
        <div className="changes-card__loading" role="status">
          <Loader2 size={13} strokeWidth={2} className="changes-spin" aria-hidden />
          {diff ? "Refreshing…" : "Loading diff…"}
        </div>
      )}

      {diff && diff.filesChanged > 0 && (
        <>
          <div className="changes-card__stats">
            {diff.filesChanged} file{diff.filesChanged !== 1 ? "s" : ""} ·{" "}
            <span className="changes-add">+{diff.insertions}</span>{" "}
            <span className="changes-del">-{diff.deletions}</span>
            {diff.commits.length > 0 && (
              <span>
                {" "}· {diff.commits.length} commit{diff.commits.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>
          <div className="changes-card__files">
            {diff.files.map((f, i) => (
              <div key={i} className="changes-file">
                <span
                  className="changes-file__status"
                  style={{ color: fileStatusColor(f.status) }}
                >
                  {fileStatusLetter(f.status)}
                </span>
                <span className="changes-file__path">{f.file}</span>
                <span className="changes-add">+{f.insertions}</span>
                <span className="changes-del">-{f.deletions}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {diff && diff.filesChanged === 0 && (
        <div className="changes-card__none">No changes yet.</div>
      )}

      {loadedAt != null && <div className="review-feedback" role="status">Last loaded {new Date(loadedAt).toLocaleTimeString()}</div>}
      {diffError && <div className="review-feedback" role="alert">Couldn’t load changes: {diffError} <button className="changes-btn" onClick={fetchDiff}>Retry</button></div>}
      {integration.error ? <div className="changes-card__none" role="alert">{integration.error}</div> : null}
      {data.workItemId && integration.lineage && socketSend ? (
        <WorktreeIntegrationControls lineage={integration.lineage} workItemId={data.workItemId}
          runKey={sessionKey} send={socketSend}
          {...(socketSubscribe ? { subscribe: socketSubscribe } : {})} />
      ) : null}

      <div className="changes-card__actions">
        {!data.workItemId && <button
          className="changes-btn changes-btn--merge"
          disabled={hasConflict || (diff != null && diff.filesChanged === 0)}
          onClick={() => setConfirm("merge")}
        >
          <GitMerge size={13} strokeWidth={2} aria-hidden /> Merge
        </button>}
        <button className="changes-btn" onClick={fetchDiff}>
          <RefreshCw size={13} strokeWidth={2} aria-hidden /> Refresh
        </button>
        {!data.workItemId && hasConflict && (
          <button className="changes-btn" onClick={() => onOpenInCanvas(nodeId)}>
            <ExternalLink size={13} strokeWidth={2} aria-hidden /> Resolve in Canvas
          </button>
        )}
        {!data.workItemId && <span className="changes-card__spacer" />}
        {!data.workItemId && <button
          className="changes-btn changes-btn--discard"
          onClick={() => setConfirm("discard")}
        >
          <Trash2 size={13} strokeWidth={2} aria-hidden /> Discard
        </button>}
      </div>

      {!data.workItemId && confirm === "merge" && (
        <ConfirmModal
          title="Merge worktree changes?"
          description="Merge this session's reviewed worktree changes into your working tree."
          onClose={() => setConfirm(null)}
          actions={[{ label: "Merge", variant: "primary", onClick: doMerge }]}
        />
      )}
      {!data.workItemId && confirm === "discard" && (
        <ConfirmModal
          title="Discard worktree changes?"
          description="This will remove all changes from this session's isolated worktree."
          onClose={() => setConfirm(null)}
          actions={[{ label: "Discard", variant: "danger", onClick: doDiscard }]}
        />
      )}
    </div>
  );
}
