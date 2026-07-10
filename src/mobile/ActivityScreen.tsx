import type { MobileSessionInfo } from "./mobile-selectors.ts";
import {
  groupSessionsByActivity,
  needsAttention,
  sessionDisplayTitle,
  sessionRoleLabel,
} from "./mobile-selectors.ts";

interface ActivityScreenProps {
  sessions: MobileSessionInfo[];
  onOpenSession: (sessionKey: string) => void;
  notice?: ActivityNotice | null;
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

function SessionCard({
  session,
  onOpenSession,
}: {
  session: MobileSessionInfo;
  onOpenSession: (sessionKey: string) => void;
}) {
  return (
    <button
      className={`mob-session-card${needsAttention(session) ? " mob-session-card--attention" : ""}`}
      onClick={() => onOpenSession(session.sessionKey)}
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

export function ActivityScreen({ sessions, onOpenSession, notice }: ActivityScreenProps) {
  // Minions are spawned and managed by their leader; the mobile Activity list
  // surfaces top-level sessions only, so their cards are filtered out here.
  const visibleSessions = sessions.filter((session) => session.role !== "minion");
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
              <SessionCard
                key={session.sessionKey}
                session={session}
                onOpenSession={onOpenSession}
              />
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
