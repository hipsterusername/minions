import { ArrowRight, Plus } from "lucide-react";

import type { MobileSessionInfo } from "./mobile/mobile-selectors.ts";
import {
  attentionKind,
  sessionDisplayTitle,
  sessionRoleLabel,
} from "./mobile/mobile-selectors.ts";
import { timeAgo } from "./nodes/leader-message-helpers.ts";

const MAX_RELEVANT_SESSIONS = 4;
const SUMMARY_LIMIT = 220;

function relevanceBucket(session: MobileSessionInfo): number {
  const reviewState = session.reviewLifecycle?.reviewState;
  if (reviewState === "decision_needed") return 0;
  if (
    reviewState === "error_to_review" ||
    reviewState === "interrupted_to_review" ||
    session.status === "error"
  ) return 1;
  if (
    reviewState === "completion_to_review" ||
    session.reviewableChanges === true
  ) return 2;
  if (session.status === "waiting" || session.pendingAttention === true) return 3;
  if (session.status === "running" || session.status === "creating") return 4;
  if (session.status === "idle") return 5;
  if (session.status === "completed") return 6;
  return 7;
}

function relevanceTimestamp(session: MobileSessionInfo): number {
  return session.reviewLifecycle?.terminalAt ?? session.lastActivityAt ?? 0;
}

/** Rank the small project-open dashboard by required action, live work, then recency. */
export function selectRelevantSessions(
  sessions: MobileSessionInfo[],
  limit = MAX_RELEVANT_SESSIONS,
): MobileSessionInfo[] {
  return [...sessions]
    .sort((a, b) => {
      const bucketDelta = relevanceBucket(a) - relevanceBucket(b);
      if (bucketDelta !== 0) return bucketDelta;
      return (
        relevanceTimestamp(b) - relevanceTimestamp(a) ||
        sessionDisplayTitle(a).localeCompare(sessionDisplayTitle(b))
      );
    })
    .slice(0, limit);
}

export function sessionRelevanceLabel(session: MobileSessionInfo): string {
  const reviewState = session.reviewLifecycle?.reviewState;
  if (reviewState === "decision_needed") return "Decision needed";
  if (reviewState === "error_to_review" || session.status === "error") return "Needs recovery";
  if (reviewState === "interrupted_to_review") return "Interrupted";
  if (reviewState === "completion_to_review") return "Ready to review";
  if (session.reviewableChanges === true) return "Changes ready";
  if (session.status === "waiting" || session.pendingAttention === true) return "Waiting for you";
  if (session.status === "running" || session.status === "creating") return "In progress";
  if (session.status === "idle") return "Recently active";
  if (session.status === "completed") return "Completed";
  if (session.status === "stopped" || session.status === "disconnected") return "Stopped";
  return "Recent session";
}

function sessionSummary(session: MobileSessionInfo): string {
  const source =
    session.reviewLifecycle?.finalReport?.trim() ||
    session.lastActivity?.trim() ||
    session.reviewLifecycle?.reviewReason?.trim();
  if (!source) {
    const label = sessionRelevanceLabel(session).toLocaleLowerCase();
    return `This session is ${label}. Open it to review the latest context and continue the work.`;
  }
  const flat = source.replace(/\s+/g, " ");
  if (flat.length <= SUMMARY_LIMIT) return flat;
  return `${flat.slice(0, SUMMARY_LIMIT - 1).trimEnd()}…`;
}

function sessionMeta(session: MobileSessionInfo): string {
  const parts = [sessionRoleLabel(session)];
  if (session.lastActivityAt) parts.push(timeAgo(session.lastActivityAt));
  if (session.model) parts.push(session.model);
  return parts.join(" · ");
}

function relevanceTone(session: MobileSessionInfo): string {
  if (
    session.reviewLifecycle?.reviewState !== "none" ||
    session.reviewableChanges === true ||
    session.status === "waiting" ||
    session.status === "error"
  ) {
    return attentionKind(session);
  }
  if (session.status === "running" || session.status === "creating") return "active";
  return "recent";
}

export function ActivitySessionHome({
  sessions,
  onOpenSession,
  onLaunch,
}: {
  sessions: MobileSessionInfo[];
  onOpenSession: (sessionKey: string) => void;
  onLaunch: () => void;
}) {
  const relevant = selectRelevantSessions(sessions);
  const primary = relevant[0];
  if (!primary) return null;

  return (
    <main className="act-session-home" aria-label="Session dashboard">
      <div className="act-session-home__content">
        <header className="act-session-home__heading">
          <div>
            <span>Pick up your work</span>
            <h2>Where should we continue?</h2>
            <p>
              The most relevant session is surfaced first, based on what needs you,
              what is still running, and what changed most recently.
            </p>
          </div>
          <button className="act-session-home__new" type="button" onClick={onLaunch}>
            <Plus size={14} strokeWidth={2.25} aria-hidden />
            <span>New leader</span>
          </button>
        </header>

        <section
          className={`act-session-feature act-session-feature--${relevanceTone(primary)}`}
          aria-labelledby="act-session-feature-title"
        >
          <div className="act-session-feature__heading">
            <span>Best next step</span>
            <span className={`act-pill act-pill--${primary.status}`}>{primary.status}</span>
          </div>
          <div className="act-session-feature__body">
            <span className="act-session-home__reason">{sessionRelevanceLabel(primary)}</span>
            <h3 id="act-session-feature-title">{sessionDisplayTitle(primary)}</h3>
            <p>{sessionSummary(primary)}</p>
          </div>
          <footer className="act-session-feature__footer">
            <span>{sessionMeta(primary)}</span>
            <button
              className="act-session-home__open"
              type="button"
              onClick={() => onOpenSession(primary.sessionKey)}
            >
              <span>Open session</span>
              <ArrowRight size={14} strokeWidth={2.25} aria-hidden />
            </button>
          </footer>
        </section>

        {relevant.length > 1 && (
          <section className="act-session-more" aria-labelledby="act-session-more-title">
            <div className="act-session-more__heading">
              <div>
                <h3 id="act-session-more-title">Also relevant</h3>
                <p>A short list of work worth returning to.</p>
              </div>
              {sessions.length > relevant.length && (
                <span>{sessions.length - relevant.length} more in Activity</span>
              )}
            </div>
            <div className="act-session-more__list">
              {relevant.slice(1).map((session) => (
                <button
                  key={session.sessionKey}
                  type="button"
                  className="act-session-row"
                  onClick={() => onOpenSession(session.sessionKey)}
                >
                  <span
                    className={`act-session-row__signal act-session-row__signal--${relevanceTone(session)}`}
                    aria-hidden
                  />
                  <span className="act-session-row__body">
                    <span className="act-session-row__topline">
                      <strong>{sessionDisplayTitle(session)}</strong>
                      <span>{sessionRelevanceLabel(session)}</span>
                    </span>
                    <span className="act-session-row__summary">{sessionSummary(session)}</span>
                    <span className="act-session-row__meta">{sessionMeta(session)}</span>
                  </span>
                  <ArrowRight
                    className="act-session-row__arrow"
                    size={15}
                    strokeWidth={2}
                    aria-hidden
                  />
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
