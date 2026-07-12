import type { MobileSessionInfo } from "./mobile-selectors.ts";
import type { WorkItemRunSnapshot } from "../../shared/work-item-contracts.ts";
import {
  activeMinionSummary,
  groupSessionsByActivity,
  needsAttention,
  sessionDisplayTitle,
  sessionRoleLabel,
  isVisibleInActivity,
} from "./mobile-selectors.ts";

interface ActivityScreenProps {
  sessions: MobileSessionInfo[];
  onOpenSession: (sessionKey: string) => void;
  notice?: ActivityNotice | null;
  workItemRuns?: Record<string, WorkItemRunSnapshot[]>;
  runNextCursor?: Record<string, string | null>;
  onLoadRuns?: (workItemId: string, cursor?: string) => void;
}

export interface ActivityNotice {
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
}

function formatCost(cost: number | undefined): string {
  if (cost == null || !Number.isFinite(cost)) return "$0.00";
  if (cost > 0 && cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function MinionSummary({ session }: { session: MobileSessionInfo }) {
  const summary = activeMinionSummary(session);
  if (summary.total === 0) return null;
  return (
    <span className="mob-card-minions" aria-label="Active minions summary">
      {summary.running > 0 ? (
        <span data-tone="running" data-live="true">
          <i aria-hidden="true" />
          {summary.running} running
        </span>
      ) : null}
      {summary.blocked > 0 ? <span data-tone="blocked">{summary.blocked} blocked</span> : null}
      {summary.planned > 0 ? <span data-tone="planned">{summary.planned} queued</span> : null}
    </span>
  );
}

function SessionCard({
  session,
  onOpenSession,
}: {
  session: MobileSessionInfo;
  onOpenSession: (sessionKey: string) => void;
}) {
  const lifecycle = session.reviewLifecycle;
  const hasSessionRun = !session.sessionKey.startsWith("work-item:");
  const lifecycleLabel = lifecycle?.acknowledgedAt
    ? "reviewed"
    : lifecycle?.reviewState === "decision_needed"
      ? "decision needed"
      : lifecycle?.reviewState === "completion_to_review"
        ? "complete · read report"
        : lifecycle?.reviewState === "error_to_review"
          ? "error"
          : lifecycle?.reviewState === "interrupted_to_review"
            ? "interrupted"
            : null;
  return (
    <button
      className={`mob-session-card${needsAttention(session) ? " mob-session-card--attention" : ""}`}
      onClick={() => { if (hasSessionRun) onOpenSession(session.sessionKey); }}
      disabled={!hasSessionRun}
      title={hasSessionRun ? undefined : "No run has started for this work item"}
      type="button"
    >
      <span className="mob-card-topline">
        <span className="mob-card-role">{sessionRoleLabel(session)}</span>
        <span className={`mob-status-pill mob-status-pill--${session.status}`}>
          {session.status}
        </span>
      </span>
      <span className="mob-card-title">{sessionDisplayTitle(session)}</span>
      <span className="mob-card-meta">
        {formatCost(session.totalCost)} · {session.turns ?? 0} turns
      </span>
      {lifecycleLabel ? <span className="mob-card-lifecycle">{lifecycleLabel}</span> : null}
      <MinionSummary session={session} />
      <span className="mob-card-activity">
        {session.lastActivity || session.cwd || session.sessionKey}
      </span>
    </button>
  );
}

function NoticeBanner({ notice }: { notice: ActivityNotice }) {
  return (
    <section className="mob-activity-notice" role="alert" aria-label={notice.title}>
      <div>
        <h2>{notice.title}</h2>
        <p>{notice.message}</p>
      </div>
      <div className="mob-activity-notice-actions">
        {notice.actionLabel && notice.onAction ? (
          <button type="button" onClick={notice.onAction}>
            {notice.actionLabel}
          </button>
        ) : null}
        {notice.onDismiss ? (
          <button type="button" onClick={notice.onDismiss} aria-label="Dismiss notice">
            Dismiss
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function ActivityScreen({ sessions, onOpenSession, notice,
  workItemRuns = {}, runNextCursor = {}, onLoadRuns }: ActivityScreenProps) {
  // Minions are spawned and managed by their leader; the mobile Activity list
  // surfaces top-level sessions only, so their cards are filtered out here.
  const visibleSessions = sessions.filter(
    (session) => session.role !== "minion" && isVisibleInActivity(session, "open"),
  );
  const sections = groupSessionsByActivity(visibleSessions);

  if (visibleSessions.length === 0) {
    return (
      <main className="mob-screen mob-activity" aria-label="Activity">
        {notice ? <NoticeBanner notice={notice} /> : null}
        <div className="mob-empty">
          <h1>Activity</h1>
          <p>No sessions are running.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="mob-screen mob-activity" aria-label="Activity">
      <header className="mob-screen-header">
        <h1>Activity</h1>
        <span className="mob-count">{visibleSessions.length}</span>
      </header>
      {notice ? <NoticeBanner notice={notice} /> : null}
      {sections.map((section) => (
        <section
          className="mob-activity-section"
          key={section.id}
          aria-label={section.title}
        >
          <h2 className="mob-section-header">
            <span>{section.title}</span>
            <span className="mob-section-count">{section.sessions.length}</span>
          </h2>
          <div className="mob-session-list">
            {section.sessions.map((session) => (
              <div key={session.sessionKey}>
                <SessionCard session={session} onOpenSession={onOpenSession} />
                {session.workItemId ? <details onToggle={(event) => {
                  if (event.currentTarget.open && !(workItemRuns[session.workItemId!]?.length)) {
                    onLoadRuns?.(session.workItemId!);
                  }
                }}>
                  <summary>Run history</summary>
                  <ol aria-label={`Run history for ${sessionDisplayTitle(session)}`}>
                    {(workItemRuns[session.workItemId] ?? []).map((run) => <li key={run.runKey}>
                      Iteration {run.runNumber ?? "child"} · {run.outcome}
                      {run.endedAt ? ` · ${new Date(run.endedAt).toLocaleDateString()}` : " · active"}
                      {run.finalReport ? <p>{run.finalReport}</p> : null}
                    </li>)}
                  </ol>
                  {runNextCursor[session.workItemId] ? <button type="button" onClick={() =>
                    onLoadRuns?.(session.workItemId!, runNextCursor[session.workItemId!]!)}>Load more</button> : null}
                </details> : null}
              </div>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
