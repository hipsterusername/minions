import type { CanvasNode } from "./types.ts";
import type { LeaderData } from "./nodes/leader/types.ts";
import type { SocketSubscribe } from "./use-socket.ts";
import type { RecentAgentWork } from "./activity-recent-work.ts";
import { timeAgo } from "./nodes/leader-message-helpers.ts";
import { LeaderNodeRenderer } from "./nodes/LeaderNode.tsx";

/**
 * Shared empty state for the Activity tab (primary "no sessions" and
 * filtered-empty variants).
 *
 * Layout, top to bottom:
 * 1. "Recent agent work" — up to three previews of the most recently active
 *    agents; clicking one reveals it on the canvas (or attaches it first).
 *    Conditional: hidden when there is genuinely nothing to preview.
 * 2. The variant's headline (and Clear-filter escape hatch when filtering).
 * 3. "Add an agent" — the full launch composer (prompt bar, starter chips,
 *    model/permissions, skills) inline, so the first keystroke starts a
 *    session with zero extra clicks. Falls back to a Launch button until the
 *    draft leader node exists.
 */
export function ActivityEmptyState({
  title,
  subtitle,
  onClearFilter,
  recent,
  onOpenInCanvas,
  onAttachToCanvas,
  launchNode,
  onLaunch,
  onUpdateNodeData,
  socketSend,
  socketSubscribe,
  projectPath,
}: {
  title: string;
  subtitle?: string | undefined;
  /** Present only for the filtered-empty variant with an active filter. */
  onClearFilter?: (() => void) | undefined;
  recent: RecentAgentWork[];
  onOpenInCanvas: (nodeId: string) => void;
  onAttachToCanvas: (sessionKey: string) => void;
  /** Draft leader node backing the inline composer, once created. */
  launchNode: CanvasNode | undefined;
  /** Fallback CTA when the draft could not be auto-created. */
  onLaunch: () => void;
  onUpdateNodeData: (nodeId: string, data: LeaderData) => void;
  socketSend?: ((data: unknown) => void) | undefined;
  socketSubscribe?: SocketSubscribe | undefined;
  projectPath?: string | undefined;
}) {
  const openRecent = (entry: RecentAgentWork) => {
    if (entry.nodeId) onOpenInCanvas(entry.nodeId);
    else if (entry.sessionKey) onAttachToCanvas(entry.sessionKey);
  };

  return (
    <div className="act-empty act-empty--rich">
      {recent.length > 0 && (
        <section className="act-empty-recent" aria-label="Recent agent work">
          <h2 className="act-empty-section-head">Recent agent work</h2>
          <div className="act-empty-recent-grid">
            {recent.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className="act-empty-recent-card"
                onClick={() => openRecent(entry)}
              >
                <span className="act-empty-recent-top">
                  <span className="act-empty-recent-title">{entry.title}</span>
                  {entry.status && (
                    <span className={`act-pill act-pill--${entry.status}`}>{entry.status}</span>
                  )}
                </span>
                {entry.snippet && (
                  <span className="act-empty-recent-snippet">{entry.snippet}</span>
                )}
                <span className="act-empty-recent-foot">
                  {entry.lastActivityAt ? `${timeAgo(entry.lastActivityAt)} · ` : ""}
                  {entry.nodeId ? "Open in canvas" : "Attach to canvas"}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="act-empty-headline">
        <p className="act-empty-title">{title}</p>
        {subtitle && <p className="act-empty-sub">{subtitle}</p>}
        {onClearFilter && (
          <button className="act-btn" type="button" onClick={onClearFilter}>
            Clear filter
          </button>
        )}
      </div>

      <section className="act-empty-add" aria-label="Add an agent">
        <h2 className="act-empty-section-head">Add an agent</h2>
        {launchNode ? (
          <div className="act-empty-add-form">
            <LeaderNodeRenderer
              node={launchNode}
              launchMode
              isSelected
              onUpdateData={(data) => onUpdateNodeData(launchNode.id, data as LeaderData)}
              socketSend={socketSend}
              socketSubscribe={socketSubscribe}
              projectPath={projectPath}
            />
          </div>
        ) : (
          <button
            className="act-btn act-btn--primary act-empty-launch"
            type="button"
            onClick={onLaunch}
          >
            Launch
          </button>
        )}
      </section>
    </div>
  );
}
