import { useCallback, useEffect, useState } from "react";
import { ConfirmModal } from "../../components/ConfirmModal.tsx";
import type { ContextItem } from "../../types.ts";
import { subscribeSocketTopic, type SocketSubscribe } from "../../use-socket.ts";
import { sessionTopic } from "../../../shared/ws-envelope.ts";
import type { LeaderData } from "./types.ts";
import { GateStrip, type MergeGateVerdict } from "./GateStrip.tsx";
import { randomUuid } from "../../random-id.ts";
import { useWorktreeIntegration } from "../../use-worktree-integration.ts";
import { WorktreeIntegrationControls } from "../../WorktreeIntegrationControls.tsx";
import { selectCanvasChangeMode } from "./work-item.ts";

/**
 * P4: Compact config footer.
 *
 * Single status bar at the bottom of the leader card that surfaces:
 *   - Worktree isolation toggle + status badge (creating / merged / failed …)
 *   - Connected context source count (locked once a session starts)
 *   - Inline "Review & Merge" / "Discard" actions for the worktree diff
 *   - The merge-confirmed, merge-conflict, and approval-pending banners
 *
 * All worktree actions go through the WebSocket bus; the diff fetch is
 * routed through a sessionTopic subscription scoped to this leader so
 * unrelated traffic is dropped at the boundary.
 *
 * Extracted from `src/nodes/LeaderNode.tsx` (Phase 9 of the leader refactor).
 */
export function ConfigFooter({
  data,
  onUpdateData,
  socketSend,
  socketSubscribe,
  getContextForNode,
  onNewSession,
}: {
  data: LeaderData;
  onUpdateData: (d: LeaderData) => void;
  socketSend?: ((data: unknown) => void) | undefined;
  socketSubscribe?:
    | SocketSubscribe
    | ((fn: (msg: unknown) => void) => () => void)
    | undefined;
  getContextForNode?: (() => ContextItem[]) | undefined;
  onNewSession?: (() => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const contextCount = getContextForNode?.().length ?? 0;
  const hasSession = !!data.sessionKey;
  const changeMode = selectCanvasChangeMode(data);
  const isWorktreeMode = changeMode === "worktree";
  const changeModeLocked = hasSession || !!data.workItemSnapshot;
  const integration = useWorktreeIntegration({
    workItemId: isWorktreeMode ? data.workItemId ?? null : null,
    runKey: isWorktreeMode ? data.sessionKey ?? null : null,
    ...(socketSend ? { send: socketSend } : {}),
    ...(socketSubscribe ? { subscribe: socketSubscribe } : {}) });

  // ── Manual worktree review state ─────────────────────────────────
  const [manualReviewOpen, setManualReviewOpen] = useState(false);
  const [manualDiff, setManualDiff] = useState<LeaderData["approvalDiff"] | null>(
    null,
  );
  const [approvalGates, setApprovalGates] = useState<MergeGateVerdict | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"discard" | "merge" | null>(
    null,
  );

  // Listen for control_response to get_worktree_diff (scoped to this session)
  useEffect(() => {
    if (!socketSubscribe || !data.sessionKey) return;
    return subscribeSocketTopic(
      socketSubscribe,
      sessionTopic(data.sessionKey),
      (msg: unknown) => {
        const m = msg as {
          type?: string;
          command?: string;
          sessionKey?: string;
          success?: boolean;
          diff?: LeaderData["approvalDiff"];
          gates?: MergeGateVerdict | null;
          approval?: { requested?: boolean; gates?: MergeGateVerdict | null } | null;
        };
        if (m.sessionKey !== data.sessionKey) return;
        if (m.type === "approval_requested") {
          setApprovalGates(m.gates ?? null);
          return;
        }
        if (m.type === "approval_resolved") {
          setApprovalGates(null);
          return;
        }
        if (m.type === "sync_response") {
          setApprovalGates(m.approval?.requested ? (m.approval.gates ?? null) : null);
          return;
        }
        if (m.type !== "control_response" || m.command !== "get_worktree_diff")
          return;
        if (m.success) {
          setManualDiff(m.diff ?? null);
        }
        setDiffLoading(false);
      },
    );
  }, [socketSubscribe, data.sessionKey]);

  // Close the manual review panel when worktree is no longer active
  useEffect(() => {
    if (data.worktreeStatus !== "active") {
      setManualReviewOpen(false);
      setManualDiff(null);
    }
  }, [data.worktreeStatus]);

  // Worktree status indicators (merged, merging, discarded, failed) shown inline
  const wtStatus = data.worktreeStatus;
  const worktreeIsActive = wtStatus === "active" || wtStatus === "creating";
  const showWorktreeStatusBadge =
    wtStatus === "merging" ||
    wtStatus === "merged" ||
    wtStatus === "discarded" ||
    wtStatus === "failed";

  const discardWorktree = useCallback(() => {
    if (socketSend && integration.contribution) {
      socketSend({ type: "discard_worktree_contribution", requestId: randomUuid(),
        contributionId: integration.contribution.id,
        expectedIntegrationRevision: integration.contribution.revision,
        reason: "Discarded from Canvas leader" });
    } else if (socketSend && data.sessionKey && !data.workItemId) {
      socketSend({ type: "discard_worktree", sessionKey: data.sessionKey });
    }
    setConfirmAction(null);
  }, [data.sessionKey, data.workItemId, integration.contribution, socketSend]);

  const mergeManualDiff = useCallback(() => {
    if (socketSend && data.sessionKey && !data.workItemId) {
      socketSend({ type: "approve_changes", sessionKey: data.sessionKey });
      onUpdateData({ ...data, worktreeStatus: "merging" });
      setManualReviewOpen(false);
      setManualDiff(null);
    }
    setConfirmAction(null);
  }, [socketSend, data, onUpdateData]);

  return (
    <>
      <div
        style={{
          borderTop: "1px solid var(--border-default)",
          background: "var(--bg-secondary)",
          flexShrink: 0,
        }}
      >
        {/* Compact summary row — always visible */}
        <div
          onClick={() => setExpanded(!expanded)}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            padding: "4px 10px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            cursor: "pointer",
            userSelect: "none",
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
          }}
        >
          {/* Worktree badge */}
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              padding: "1px 6px",
              borderRadius: 3,
              background: isWorktreeMode
                ? "var(--state-active)"
                : "var(--state-hover)",
              color: isWorktreeMode ? "var(--accent)" : "var(--text-muted)",
            }}
          >
            {"\u{1F33F}"} {isWorktreeMode ? "Worktree" : "Live"}
          </span>

          {/* Context count — locked after session starts */}
          {contextCount > 0 && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                color: hasSession ? "var(--text-muted)" : "var(--accent)",
                opacity: hasSession ? 0.7 : 1,
              }}
            >
              {hasSession ? "\u{1F512}" : "\u{1F4CE}"} {contextCount}
            </span>
          )}

          {/* Worktree branch */}
          {data.worktreeBranch && (
            <span style={{ color: "var(--accent)", fontSize: 9 }}>
              {data.worktreeBranch}
            </span>
          )}

          {/* Worktree status badge */}
          {showWorktreeStatusBadge && (
            <span
              style={{
                color:
                  wtStatus === "merged"
                    ? "var(--success-color)"
                    : wtStatus === "failed"
                      ? "var(--danger-color)"
                      : wtStatus === "discarded"
                        ? "var(--status-error)"
                        : "var(--status-creating)",
              }}
            >
              {wtStatus === "merging"
                ? "merging..."
                : wtStatus === "merged"
                  ? "merged"
                  : wtStatus === "failed"
                    ? "isolation failed"
                    : "discarded"}
            </span>
          )}

          <span style={{ flex: 1 }} />
          <span
            style={{
              fontSize: 8,
              transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
              transition: "transform 0.15s",
            }}
          >
            ▼
          </span>
        </div>

        {/* Expanded config */}
        {expanded && (
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{ padding: "4px 10px 8px" }}
          >
            {/* Worktree isolation toggle */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 6,
              }}
            >
              <button
                onClick={() => {
                  if (!changeModeLocked) {
                    onUpdateData({
                      ...data,
                      worktreeIsolation: !data.worktreeIsolation,
                    });
                  }
                }}
                disabled={changeModeLocked}
                title={changeModeLocked ? "Change mode is fixed when the work item is created" : undefined}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  padding: "4px 10px",
                  borderRadius: 4,
                  border: "none",
                  cursor: changeModeLocked ? "default" : "pointer",
                  opacity: changeModeLocked ? 0.7 : 1,
                  background: isWorktreeMode
                    ? "var(--state-active)"
                    : "var(--state-hover)",
                  color: isWorktreeMode
                    ? "var(--accent)"
                    : "var(--text-muted)",
                }}
              >
                {"\u{1F33F}"} Worktree Isolation
                <span
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: isWorktreeMode
                      ? "var(--accent)"
                      : "var(--text-muted)",
                    marginLeft: 2,
                  }}
                />
              </button>
            </div>

            {/* Context sources — locked after session starts */}
            {contextCount > 0 && (
              <div
                style={{
                  fontSize: 10,
                  color: hasSession ? "var(--text-muted)" : "var(--accent)",
                  fontFamily: "var(--font-mono)",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  marginBottom: 4,
                  opacity: hasSession ? 0.7 : 1,
                }}
              >
                {hasSession ? "\u{1F512}" : "\u{1F4CE}"} {contextCount} context source
                {contextCount !== 1 ? "s" : ""}
                {hasSession ? " (locked)" : " connected"}
              </div>
            )}

            {/* Worktree failure warning */}
            {wtStatus === "failed" && (
              <div
                style={{
                  marginTop: 4,
                  padding: "6px 8px",
                  background: "var(--danger-bg)",
                  border: "1px solid var(--danger-color)",
                  borderRadius: 4,
                  fontSize: 10,
                  color: "var(--status-error)",
                  lineHeight: 1.4,
                }}
              >
                <strong>Isolation failed:</strong> The run was stopped before
                making changes because an isolated worktree could not be created.
              </div>
            )}

            {/* Worktree actions — always available when worktree is active */}
            {isWorktreeMode && !data.workItemId && worktreeIsActive && hasSession && !data.approvalPending && (
              <div style={{ marginTop: 4 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <button
                    onClick={() => {
                      if (socketSend && data.sessionKey) {
                        setManualReviewOpen(!manualReviewOpen);
                        if (!manualReviewOpen) {
                          setDiffLoading(true);
                          setManualDiff(null);
                          socketSend({
                            type: "get_worktree_diff",
                            sessionKey: data.sessionKey,
                          });
                        }
                      }
                    }}
                    style={{
                      padding: "3px 8px",
                      fontSize: 10,
                      background: manualReviewOpen
                        ? "var(--state-active)"
                        : "var(--bg-elevated)",
                      border: `1px solid ${manualReviewOpen ? "var(--accent)" : "var(--border-default)"}`,
                      borderRadius: 4,
                      color: manualReviewOpen
                        ? "var(--accent)"
                        : "var(--text-secondary)",
                      cursor: "pointer",
                      fontFamily: "var(--font-mono)",
                      fontWeight: manualReviewOpen ? 600 : 400,
                    }}
                  >
                    {manualReviewOpen ? "▾ Review changes" : "▸ Review changes"}
                  </button>
                  <button
                    onClick={() => {
                      if (socketSend && data.sessionKey)
                        setConfirmAction("discard");
                    }}
                    style={{
                      padding: "3px 8px",
                      fontSize: 10,
                      background: "var(--danger-bg)",
                      border: "1px solid var(--danger-color)",
                      borderRadius: 4,
                      color: "var(--status-error)",
                      cursor: "pointer",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    Discard
                  </button>
                </div>

                {/* Manual review panel — inline diff + merge controls */}
                {manualReviewOpen && (
                  <div
                    style={{
                      marginTop: 6,
                      padding: "8px 10px",
                      background: "var(--bg-surface)",
                      border: "1px solid var(--border-default)",
                      borderRadius: 6,
                    }}
                  >
                    {diffLoading && (
                      <div
                        style={{
                          fontSize: 10,
                          color: "var(--text-muted)",
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <span
                          style={{
                            animation: "spin 1s linear infinite",
                            display: "inline-block",
                          }}
                        >
                          ⟳
                        </span>
                        Loading diff...
                      </div>
                    )}
                    {!diffLoading && manualDiff && (
                      <>
                        {/* Diff stats */}
                        <div
                          style={{
                            fontSize: 11,
                            color: "var(--text-secondary)",
                            marginBottom: 6,
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          {manualDiff.filesChanged} file
                          {manualDiff.filesChanged !== 1 ? "s" : ""} changed
                          {" · "}
                          <span
                            style={{
                              color: "var(--success-color)",
                              fontWeight: 600,
                            }}
                          >
                            +{manualDiff.insertions}
                          </span>{" "}
                          <span
                            style={{
                              color: "var(--status-error)",
                              fontWeight: 600,
                            }}
                          >
                            -{manualDiff.deletions}
                          </span>
                          {manualDiff.commits.length > 0 && (
                            <span>
                              {" "}
                              · {manualDiff.commits.length} commit
                              {manualDiff.commits.length !== 1 ? "s" : ""}
                            </span>
                          )}
                        </div>

                        {/* File list */}
                        {manualDiff.files.length > 0 && (
                          <div
                            style={{
                              fontSize: 10,
                              fontFamily: "var(--font-mono)",
                              background: "var(--bg-elevated)",
                              borderRadius: 4,
                              padding: "4px 6px",
                              marginBottom: 6,
                              maxHeight: 120,
                              overflowY: "auto",
                            }}
                          >
                            {manualDiff.files.map((f, i) => (
                              <div
                                key={i}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 6,
                                  padding: "2px 0",
                                  color: "var(--text-muted)",
                                }}
                              >
                                <span
                                  style={{
                                    fontSize: 9,
                                    fontWeight: 600,
                                    minWidth: 12,
                                    textAlign: "center",
                                    color:
                                      f.status === "added"
                                        ? "var(--success-color)"
                                        : f.status === "deleted"
                                          ? "var(--status-error)"
                                          : "var(--accent)",
                                  }}
                                >
                                  {f.status === "added"
                                    ? "A"
                                    : f.status === "deleted"
                                      ? "D"
                                      : "M"}
                                </span>
                                <span
                                  style={{
                                    flex: 1,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {f.file}
                                </span>
                                <span
                                  style={{
                                    color: "var(--success-color)",
                                    fontSize: 9,
                                  }}
                                >
                                  +{f.insertions}
                                </span>
                                <span
                                  style={{
                                    color: "var(--status-error)",
                                    fontSize: 9,
                                  }}
                                >
                                  -{f.deletions}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* No changes state */}
                        {manualDiff.filesChanged === 0 && (
                          <div
                            style={{
                              fontSize: 10,
                              color: "var(--text-muted)",
                              fontStyle: "italic",
                              marginBottom: 6,
                            }}
                          >
                            No changes to merge yet.
                          </div>
                        )}

                        {/* Merge / Refresh actions */}
                        <div
                          style={{ display: "flex", gap: 6, alignItems: "center" }}
                        >
                          {manualDiff.filesChanged > 0 && !data.workItemId && (
                            <button
                              onClick={() => {
                                if (socketSend && data.sessionKey)
                                  setConfirmAction("merge");
                              }}
                              style={{
                                padding: "4px 12px",
                                fontSize: 11,
                                fontWeight: 700,
                                background: "var(--success-color)",
                                border: "none",
                                borderRadius: 4,
                                color: "var(--text-on-accent)",
                                cursor: "pointer",
                                fontFamily: "var(--font-mono)",
                              }}
                            >
                              Merge
                            </button>
                          )}
                          <button
                            onClick={() => {
                              if (socketSend && data.sessionKey) {
                                setDiffLoading(true);
                                setManualDiff(null);
                                socketSend({
                                  type: "get_worktree_diff",
                                  sessionKey: data.sessionKey,
                                });
                              }
                            }}
                            style={{
                              padding: "4px 8px",
                              fontSize: 10,
                              background: "var(--bg-elevated)",
                              border: "1px solid var(--border-default)",
                              borderRadius: 4,
                              color: "var(--text-secondary)",
                              cursor: "pointer",
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            Refresh
                          </button>
                        </div>
                      </>
                    )}
                    {!diffLoading && !manualDiff && (
                      <div
                        style={{ fontSize: 10, color: "var(--text-muted)" }}
                      >
                        Unable to load diff.{" "}
                        <button
                          onClick={() => {
                            if (socketSend && data.sessionKey) {
                              setDiffLoading(true);
                              socketSend({
                                type: "get_worktree_diff",
                                sessionKey: data.sessionKey,
                              });
                            }
                          }}
                          style={{
                            background: "none",
                            border: "none",
                            color: "var(--accent)",
                            cursor: "pointer",
                            fontSize: 10,
                            padding: 0,
                            textDecoration: "underline",
                          }}
                        >
                          Retry
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Merge confirmed banner — shown briefly after successful merge */}
        {!data.workItemId && data.mergeConfirmed && (
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              margin: "0 6px 6px",
              padding: "10px 12px",
              background: "var(--success-bg, rgba(46,160,67,0.1))",
              border: "2px solid var(--success-color)",
              borderRadius: 8,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--success-color)",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span style={{ fontSize: 14 }}>✓</span> Merged successfully
              </div>
              <button
                onClick={() =>
                  onUpdateData({ ...data, mergeConfirmed: false })
                }
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 14,
                  padding: "0 2px",
                  lineHeight: 1,
                }}
                title="Dismiss"
                aria-label="Dismiss merge success"
              >
                x
              </button>
            </div>
            {data.status === "completed" && (
              <div
                style={{
                  marginTop: 8,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  Session complete.
                </span>
                <button
                  onClick={onNewSession}
                  style={{
                    padding: "4px 12px",
                    borderRadius: 6,
                    border: "1px solid var(--accent)",
                    background: "var(--state-active, rgba(88,166,255,0.1))",
                    color: "var(--accent)",
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  New Session
                </button>
              </div>
            )}
          </div>
        )}

        {/* Merge conflict panel — shown when approve & merge fails */}
        {isWorktreeMode && !data.workItemId && data.approvalPending && data.mergeConflict && (
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              margin: "0 6px 6px",
              padding: "10px 12px",
              background: "var(--danger-bg)",
              border: "2px solid var(--danger-color)",
              borderRadius: 8,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 6,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--status-error)",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span style={{ fontSize: 14 }}>!</span> Merge Conflicts
              </div>
              <button
                onClick={() => onUpdateData({ ...data, mergeConflict: null })}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 14,
                  padding: "0 2px",
                  lineHeight: 1,
                }}
                title="Dismiss"
                aria-label="Dismiss merge conflicts"
              >
                x
              </button>
            </div>
            {data.mergeConflict.conflicts.length > 0 && (
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  marginBottom: 8,
                  fontFamily: "var(--font-mono)",
                  background: "var(--bg-elevated)",
                  padding: "6px 8px",
                  borderRadius: 4,
                  maxHeight: 80,
                  overflowY: "auto",
                }}
              >
                {data.mergeConflict.conflicts.map((f, i) => (
                  <div key={i} style={{ padding: "1px 0" }}>
                    {f}
                  </div>
                ))}
              </div>
            )}
            <div
              style={{
                fontSize: 10,
                color: "var(--text-muted)",
                marginBottom: 6,
                lineHeight: 1.4,
              }}
            >
              Choose a resolution strategy:
            </div>
            <div
              style={{ display: data.workItemId ? "none" : "flex", gap: 6, flexWrap: "wrap" }}
              data-no-drag
            >
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (socketSend && data.sessionKey && !data.workItemId) {
                    socketSend({ type: "force_merge", sessionKey: data.sessionKey });
                    onUpdateData({
                      ...data,
                      worktreeStatus: "merging",
                      mergeConflict: null,
                      approvalPending: false,
                    });
                  }
                }}
                style={{
                  padding: "5px 12px",
                  fontSize: 11,
                  fontWeight: 600,
                  background: "var(--accent)",
                  border: "none",
                  borderRadius: 6,
                  color: "var(--text-on-accent)",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                }}
                title="Keep canvas branch changes where conflicts occur"
              >
                Keep Ours
              </button>
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (socketSend && data.sessionKey && !data.workItemId) {
                    socketSend({ type: "theirs_merge", sessionKey: data.sessionKey });
                    onUpdateData({
                      ...data,
                      worktreeStatus: "merging",
                      mergeConflict: null,
                      approvalPending: false,
                    });
                  }
                }}
                style={{
                  padding: "5px 12px",
                  fontSize: 11,
                  fontWeight: 600,
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 6,
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                }}
                title="Keep main branch changes where conflicts occur"
              >
                Keep Main
              </button>
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (socketSend && data.sessionKey && !data.workItemId) {
                    socketSend({ type: "retry_merge", sessionKey: data.sessionKey });
                    onUpdateData({
                      ...data,
                      worktreeStatus: "merging",
                      mergeConflict: null,
                      approvalPending: false,
                    });
                  }
                }}
                style={{
                  padding: "5px 12px",
                  fontSize: 11,
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 6,
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                }}
                title="Re-attempt a clean merge (use after manually resolving conflicts in the worktree)"
              >
                Retry
              </button>
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (socketSend && data.sessionKey) setConfirmAction("discard");
                }}
                style={{
                  padding: "5px 12px",
                  fontSize: 11,
                  background: "var(--danger-bg)",
                  border: "1px solid var(--danger-color)",
                  borderRadius: 6,
                  color: "var(--status-error)",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                }}
              >
                Discard
              </button>
            </div>
          </div>
        )}

        {isWorktreeMode && data.workItemId && integration.lineage && socketSend ? (
          <div onMouseDown={(event) => event.stopPropagation()} style={{ margin: "0 6px 6px" }}>
            <WorktreeIntegrationControls lineage={integration.lineage} workItemId={data.workItemId}
              runKey={data.sessionKey} send={socketSend} className="integration-controls--canvas"
              {...(socketSubscribe ? { subscribe: socketSubscribe } : {})} />
          </div>
        ) : null}

        {/* Approval pending banner — shown when no conflicts (normal flow) */}
        {isWorktreeMode && !data.workItemId && data.approvalPending && !data.mergeConflict && (
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              margin: "0 6px 6px",
              padding: "10px 12px",
              background: "var(--state-active)",
              border: "2px solid var(--accent)",
              borderRadius: 8,
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: "var(--accent)",
                marginBottom: 6,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span style={{ fontSize: 14 }}>✓</span> Changes Ready for Review
            </div>
            {data.approvalSummary && (
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-secondary)",
                  marginBottom: 8,
                  lineHeight: 1.5,
                }}
              >
                {data.approvalSummary}
              </div>
            )}
            <GateStrip
              gates={approvalGates}
              sessionKey={data.sessionKey}
              socketSend={socketSend}
            />
            {data.approvalDiff && (
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  marginBottom: 8,
                  fontFamily: "var(--font-mono)",
                }}
              >
                {data.approvalDiff.filesChanged} file
                {data.approvalDiff.filesChanged !== 1 ? "s" : ""} changed
                {" · "}
                <span style={{ color: "var(--success-color)", fontWeight: 600 }}>
                  +{data.approvalDiff.insertions}
                </span>{" "}
                <span style={{ color: "var(--status-error)", fontWeight: 600 }}>
                  -{data.approvalDiff.deletions}
                </span>
                {data.approvalDiff.commits.length > 0 && (
                  <span>
                    {" "}
                    {" · "} {data.approvalDiff.commits.length} commit
                    {data.approvalDiff.commits.length !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              {!data.workItemId && <button
                onClick={() => {
                  if (socketSend && data.sessionKey) {
                    socketSend({
                      type: "approve_changes",
                      sessionKey: data.sessionKey,
                    });
                    onUpdateData({
                      ...data,
                      worktreeStatus: "merging",
                      approvalPending: false,
                    });
                  }
                }}
                style={{
                  padding: "6px 16px",
                  fontSize: 12,
                  fontWeight: 700,
                  background: "var(--success-color)",
                  border: "none",
                  borderRadius: 6,
                  color: "var(--text-on-accent)",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                }}
              >
                ✓ Approve & Merge
              </button>}
              <button
                onClick={() => {
                  if (socketSend && data.sessionKey) {
                    socketSend({
                      type: "get_worktree_diff",
                      sessionKey: data.sessionKey,
                    });
                  }
                }}
                style={{
                  padding: "6px 12px",
                  fontSize: 11,
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 6,
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                }}
              >
                View Diff
              </button>
              <button
                onClick={() => {
                  if (socketSend && data.sessionKey) setConfirmAction("discard");
                }}
                style={{
                  padding: "6px 12px",
                  fontSize: 11,
                  background: "var(--danger-bg)",
                  border: "1px solid var(--danger-color)",
                  borderRadius: 6,
                  color: "var(--status-error)",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                }}
              >
                Discard
              </button>
            </div>
            <div
              style={{
                fontSize: 10,
                color: "var(--text-muted)",
                marginTop: 6,
                fontStyle: "italic",
              }}
            >
              Send a message to request changes instead
            </div>
          </div>
        )}
      </div>
      {confirmAction === "discard" && (
        <ConfirmModal
          title="Discard worktree changes?"
          description="This will remove all changes from the isolated worktree for this session."
          onClose={() => setConfirmAction(null)}
          actions={[
            { label: "Discard", variant: "danger", onClick: discardWorktree },
          ]}
        />
      )}
      {confirmAction === "merge" && (
        <ConfirmModal
          title="Merge worktree changes?"
          description="This will merge the reviewed worktree changes into your working tree."
          onClose={() => setConfirmAction(null)}
          actions={[
            { label: "Merge", variant: "primary", onClick: mergeManualDiff },
          ]}
        />
      )}
    </>
  );
}
