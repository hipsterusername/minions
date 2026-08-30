import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { ChangeMode } from "../../shared/work-item-lifecycle.ts";

import { randomUuid } from "../random-id.ts";
import { useWorktreeIntegration } from "../use-worktree-integration.ts";
import { WorktreeIntegrationControls } from "../WorktreeIntegrationControls.tsx";
import type { ServerMessage, SocketSubscribe } from "../use-socket.ts";
import {
  fileStatusSymbol,
  formatDiffStat,
  isDetailedDiff,
  type DetailedDiff,
} from "./mobile-approvals.ts";

interface ReviewChangesScreenProps {
  sessionKey: string;
  workItemId?: string | null | undefined;
  changeMode?: ChangeMode | undefined;
  send: (data: unknown) => void;
  subscribe: SocketSubscribe;
  onClose: () => void;
  onRequestChanges?: ((prompt: string) => boolean) | undefined;
  summary?: string | undefined;
  title?: string | undefined;
}

interface MergeConflict {
  conflicts: string[];
  summary: string;
  targetBranch?: string | undefined;
}

function makeRequestId(): string {
  return randomUuid();
}

export function ReviewChangesScreen({
  changeMode,
  workItemId,
  ...props
}: ReviewChangesScreenProps) {
  if (workItemId && changeMode !== "worktree") {
    return (
      <main className="mob-review" aria-label="Live changes">
        <header className="mob-chat-header">
          <button className="mob-icon-button" type="button" onClick={props.onClose} aria-label="Close">
            ×
          </button>
          <div className="mob-chat-title">
            <span>Live mode</span>
            <h1>{props.title ?? props.sessionKey}</h1>
          </div>
        </header>
        <section className="mob-review-body">
          <div className="mob-review-summary">
            <h2>No approval required</h2>
            <p>Live changes are applied directly to the current working tree.</p>
          </div>
        </section>
      </main>
    );
  }
  return <WorktreeReviewChangesScreen {...props} workItemId={workItemId} changeMode={changeMode} />;
}

function WorktreeReviewChangesScreen({
  sessionKey,
  workItemId,
  send,
  subscribe,
  onClose,
  onRequestChanges,
  summary,
  title,
}: ReviewChangesScreenProps) {
  const [requestId] = useState(makeRequestId);
  const [diff, setDiff] = useState<DetailedDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requestingChanges, setRequestingChanges] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [feedbackFocused, setFeedbackFocused] = useState(false);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [conflict, setConflict] = useState<MergeConflict | null>(null);
  const integration = useWorktreeIntegration({ workItemId: workItemId ?? null,
    runKey: sessionKey, send, subscribe });

  useEffect(() => {
    send({ type: "get_worktree_diff", sessionKey, requestId });
  }, [requestId, send, sessionKey]);

  useEffect(() => {
    return subscribe("*", (msg: ServerMessage) => {
      if (msg.type === "control_response") {
        if (
          msg.command !== "get_worktree_diff" ||
          msg.sessionKey !== sessionKey ||
          msg.requestId !== requestId
        ) {
          return;
        }

        if (msg.success === false) {
          setError(msg.error ?? "Could not load diff.");
          return;
        }

        if (isDetailedDiff(msg["diff"])) {
          const nextDiff = msg["diff"];
          setDiff(nextDiff);
          setExpandedFile(nextDiff.files[0]?.file ?? null);
          setError(null);
        } else {
          setError("Diff response was incomplete.");
        }
        return;
      }

      if (!workItemId && msg.type === "worktree_merge_failed" && msg.sessionKey === sessionKey) {
        setConflict({
          conflicts: msg.result?.conflicts ?? [],
          summary: msg.result?.summary ?? msg.error ?? "Merge conflicts detected.",
          targetBranch: msg.result?.targetBranch,
        });
        return;
      }

      if (
        (msg.type === "worktree_merged" || msg.type === "session_completed") &&
        msg.sessionKey === sessionKey
      ) {
        onClose();
      }
    });
  }, [onClose, requestId, sessionKey, subscribe, workItemId]);

  const commitsLabel = useMemo(() => {
    if (!diff) return "";
    return `${diff.commits.length} ${diff.commits.length === 1 ? "commit" : "commits"}`;
  }, [diff]);

  function handleRequestChanges(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = feedback.trim();
    if (!prompt) return;
    if (workItemId) {
      if (onRequestChanges?.(prompt) !== true) {
        setError("Work item details are still loading. Your feedback has been preserved.");
        return;
      }
    } else send({ type: "send_message", sessionKey, prompt });
    setFeedback("");
    setRequestingChanges(false);
    onClose();
  }

  return (
    <main className="mob-review" aria-label="Review changes">
      <header className="mob-chat-header">
        <button className="mob-icon-button" type="button" onClick={onClose} aria-label="Close review">
          ×
        </button>
        <div className="mob-chat-title">
          <span>Review changes</span>
          <h1>{title ?? sessionKey}</h1>
        </div>
      </header>

      <section className="mob-review-body">
        <div className="mob-review-summary">
          <h2>Changes ready for review</h2>
          {summary ? <p>{summary}</p> : null}
          {diff ? (
            <p className="mob-review-stat">
              {formatDiffStat(diff)} · {commitsLabel} · {diff.branch}
            </p>
          ) : null}
        </div>

        {!diff && !error ? (
          <div className="mob-review-loading" role="status">Loading diff...</div>
        ) : null}
        {error ? <div className="mob-review-error" role="alert">{error}</div> : null}

        {diff ? (
          <>
            <section className="mob-review-section" aria-label="Changed files">
              <h2>Files</h2>
              <div className="mob-file-list">
                {diff.files.map((file) => (
                  <div
                    className="mob-file-review-item"
                    data-expanded={expandedFile === file.file ? "true" : "false"}
                    key={`${file.status}:${file.file}`}
                  >
                    <button
                      className="mob-file-row"
                      type="button"
                      aria-expanded={expandedFile === file.file}
                      onClick={() =>
                        setExpandedFile((current) => current === file.file ? null : file.file)
                      }
                    >
                      <span className={`mob-file-status mob-file-status--${file.status}`} aria-hidden="true">
                        {fileStatusSymbol(file.status)}
                      </span>
                      <span className="mob-file-path">{file.file}</span>
                      <span className="mob-file-stat">+{file.insertions} -{file.deletions}</span>
                    </button>
                    {expandedFile === file.file ? (
                      <div className="mob-file-detail">
                        <span>Status: {file.status}</span>
                        <span>{file.insertions} additions</span>
                        <span>{file.deletions} deletions</span>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>

            <section className="mob-review-section" aria-label="Commits">
              <h2>Commits</h2>
              {diff.commits.length === 0 ? (
                <p className="mob-muted">No commits reported.</p>
              ) : (
                <ul className="mob-commit-list">
                  {diff.commits.map((commit) => (
                    <li key={commit}>{commit}</li>
                  ))}
                </ul>
              )}
            </section>
          </>
        ) : null}

        {conflict ? (
          <section className="mob-conflict-panel" aria-label="Merge conflict">
            <h2>Merge conflict</h2>
            <p>{conflict.summary}</p>
            {conflict.targetBranch ? <p className="mob-muted">Target: {conflict.targetBranch}</p> : null}
            {conflict.conflicts.length > 0 ? (
              <ul className="mob-conflict-list">
                {conflict.conflicts.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            ) : null}
            {!workItemId ? <div className="mob-conflict-actions">
              <button type="button" onClick={() => send({ type: "retry_merge", sessionKey })}>
                Retry
              </button>
              <button type="button" onClick={() => send({ type: "force_merge", sessionKey })}>
                Force
              </button>
              <button type="button" onClick={() => send({ type: "theirs_merge", sessionKey })}>
                Theirs
              </button>
            </div> : null}
          </section>
        ) : null}
        {workItemId && integration.lineage ? <section className="mob-review-section"
          aria-label="Worktree integration">
          <h2>Integration</h2>
          <WorktreeIntegrationControls lineage={integration.lineage} workItemId={workItemId}
            runKey={sessionKey} send={send} className="integration-controls--mobile" subscribe={subscribe} />
        </section> : null}
      </section>

      <footer className="mob-review-actions">
        {requestingChanges ? (
          <form
            className="mob-review-feedback"
            data-focused={feedbackFocused ? "true" : "false"}
            onSubmit={handleRequestChanges}
          >
            <label htmlFor="mob-review-feedback">Request changes</label>
            <textarea
              id="mob-review-feedback"
              value={feedback}
              onChange={(event) => setFeedback(event.currentTarget.value)}
              onFocus={() => setFeedbackFocused(true)}
              onBlur={() => setFeedbackFocused(false)}
              placeholder="Describe what needs to change"
              rows={3}
            />
            <div className="mob-review-feedback-actions">
              <button type="button" onClick={() => setRequestingChanges(false)}>
                Cancel
              </button>
              <button type="submit" disabled={feedback.trim().length === 0}>Send</button>
            </div>
          </form>
        ) : null}

        {confirmDiscard ? (
          <div className="mob-discard-confirm" role="group" aria-label="Confirm discard">
            <span>Discard this worktree?</span>
            <button type="button" onClick={() => setConfirmDiscard(false)}>
              Cancel
            </button>
            <button type="button" onClick={() => {
              if (integration.contribution) send({ type: "discard_worktree_contribution",
                requestId: randomUuid(), contributionId: integration.contribution.id,
                expectedIntegrationRevision: integration.contribution.revision,
                reason: "Discarded from mobile review" });
              else if (!workItemId) send({ type: "discard_worktree", sessionKey });
            }}>
              Discard
            </button>
          </div>
        ) : null}

        <div className="mob-review-action-row">
          {!workItemId ? <button
            className="mob-primary-action"
            type="button"
            onClick={() => send({ type: "approve_changes", sessionKey })}
          >
            Approve &amp; Merge
          </button> : null}
          <button type="button" onClick={() => setRequestingChanges(true)}>
            Request changes
          </button>
          {!workItemId ? <button type="button" onClick={() => setConfirmDiscard(true)}>
            Discard
          </button> : null}
        </div>
      </footer>
    </main>
  );
}
