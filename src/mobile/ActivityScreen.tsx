import { useEffect, useState } from "react";

import type { MobileSessionInfo, ActivityVisibility } from "./mobile-selectors.ts";
import type { WorkItemRunSnapshot } from "../../shared/work-item-contracts.ts";
import { randomUuid } from "../random-id.ts";
import {
  activeMinionSummary,
  attentionAction,
  attentionKind,
  attentionReason,
  compareActivityPriority,
  groupSessionsForTriage,
  needsAttention,
  sessionDisplayTitle,
  sessionRoleLabel,
  isVisibleInActivity,
} from "./mobile-selectors.ts";
import {
  buildLifecycleCommand,
  canAcknowledge,
  isDismissed,
  type LifecycleAction,
} from "./mobile-activity-actions.ts";

interface ActivityScreenProps {
  sessions: MobileSessionInfo[];
  onOpenSession: (sessionKey: string) => void;
  notice?: ActivityNotice | null;
  workItemRuns?: Record<string, WorkItemRunSnapshot[]>;
  runNextCursor?: Record<string, string | null>;
  onLoadRuns?: (workItemId: string, cursor?: string) => void;
  /** WS send — drives the triage lane's Mark reviewed / Dismiss / Restore actions. */
  send?: (data: unknown) => void;
}

export interface ActivityNotice {
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
}

const VISIBILITY_LABELS: Record<ActivityVisibility, string> = {
  open: "Open",
  all: "All",
  dismissed: "Dismissed",
};

type ActivitySummaryFilter = "needs-you" | "active" | "waiting";

function matchesSummaryFilter(
  session: MobileSessionInfo,
  filter: ActivitySummaryFilter,
): boolean {
  switch (filter) {
    case "needs-you":
      return needsAttention(session);
    case "active":
      return session.status === "running" || session.status === "creating";
    case "waiting":
      return session.status === "waiting" ||
        session.reviewLifecycle?.reviewState === "decision_needed";
  }
}

function formatCost(cost: number | undefined): string {
  if (cost == null || !Number.isFinite(cost)) return "$0.00";
  if (cost > 0 && cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/**
 * Work-item lifecycle commands validate `requestId` as a UUID server-side, so
 * the fallback must be a real RFC-4122 UUID — a `${Date.now()}-…` string gets
 * the whole command rejected on non-secure origins.
 */
function newRequestId(): string {
  return randomUuid();
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

/** A checkbox that toggles a session's membership in the bulk-selection set. */
function SelectBox({
  checked,
  label,
  onToggle,
}: {
  checked: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <label className="mob-select" onClick={(event) => event.stopPropagation()}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label={`Select ${label}`}
      />
    </label>
  );
}

/**
 * The immediate review/dismiss controls shared by the triage rows and the
 * session cards, so a session can be resolved without opening it. Each button
 * renders only when its lifecycle transition applies to the current state.
 */
function LifecycleActions({
  session,
  onAction,
}: {
  session: MobileSessionInfo;
  onAction: (action: LifecycleAction, session: MobileSessionInfo) => void;
}) {
  const dismissed = isDismissed(session);
  return (
    <span className="mob-life-actions">
      {canAcknowledge(session) ? (
        <button
          className="mob-mini-btn"
          type="button"
          onClick={() => onAction("acknowledge", session)}
        >
          Mark reviewed
        </button>
      ) : null}
      {dismissed ? (
        <button
          className="mob-mini-btn"
          type="button"
          onClick={() => onAction("reopen", session)}
        >
          Restore
        </button>
      ) : (
        <button
          className="mob-mini-btn"
          type="button"
          onClick={() => onAction("dismiss", session)}
        >
          Dismiss
        </button>
      )}
    </span>
  );
}

/**
 * A pinned attention row for a session that needs the user. Tapping the body
 * opens the session; the inline buttons resolve it without leaving Activity.
 */
function TriageRow({
  session,
  onOpenSession,
  onAction,
  checked,
  onToggleSelect,
}: {
  session: MobileSessionInfo;
  onOpenSession: (sessionKey: string) => void;
  onAction?: ((action: LifecycleAction, session: MobileSessionInfo) => void) | undefined;
  checked?: boolean;
  onToggleSelect?: (() => void) | undefined;
}) {
  const kind = attentionKind(session);
  return (
    <div
      className={`mob-triage-row mob-triage-row--${kind}${checked ? " mob-triage-row--selected" : ""}`}
    >
      {onToggleSelect ? (
        <SelectBox
          checked={checked ?? false}
          label={sessionDisplayTitle(session)}
          onToggle={onToggleSelect}
        />
      ) : null}
      <button
        className="mob-triage-main"
        type="button"
        onClick={() => onOpenSession(session.sessionKey)}
      >
        <span className={`mob-triage-icon mob-triage-icon--${kind}`} aria-hidden="true">
          {kind === "error" ? "!" : kind === "waiting" ? "?" : "±"}
        </span>
        <span className="mob-triage-body">
          <span className="mob-triage-line">
            <span className="mob-triage-title">{sessionDisplayTitle(session)}</span>
            <span className={`mob-triage-reason mob-triage-reason--${kind}`}>
              {attentionReason(session)}
            </span>
          </span>
          <span className="mob-triage-sub">
            {sessionRoleLabel(session).toUpperCase()} · {formatCost(session.totalCost)} ·{" "}
            {session.turns ?? 0} turns
          </span>
        </span>
      </button>
      <span className="mob-triage-actions">
        <button
          className="mob-mini-btn mob-mini-btn--primary"
          type="button"
          onClick={() => onOpenSession(session.sessionKey)}
        >
          {attentionAction(session)}
        </button>
        {onAction ? <LifecycleActions session={session} onAction={onAction} /> : null}
      </span>
    </div>
  );
}

function SessionCard({
  session,
  onOpenSession,
  onAction,
  checked,
  onToggleSelect,
}: {
  session: MobileSessionInfo;
  onOpenSession: (sessionKey: string) => void;
  onAction?: ((action: LifecycleAction, session: MobileSessionInfo) => void) | undefined;
  checked?: boolean;
  onToggleSelect?: (() => void) | undefined;
}) {
  const hasSessionRun = !session.sessionKey.startsWith("work-item:");
  return (
    <div
      className={`mob-session-card-wrap${checked ? " mob-session-card-wrap--selected" : ""}`}
    >
      {onToggleSelect ? (
        <SelectBox
          checked={checked ?? false}
          label={sessionDisplayTitle(session)}
          onToggle={onToggleSelect}
        />
      ) : null}
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
          {session.model ? ` · ${session.model}` : ""}
        </span>
        <MinionSummary session={session} />
        <span className="mob-card-activity">
          {session.lastActivity || session.cwd || session.sessionKey}
        </span>
      </button>
      {onAction ? <LifecycleActions session={session} onAction={onAction} /> : null}
    </div>
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

function RunHistory({
  session,
  workItemRuns,
  runNextCursor,
  onLoadRuns,
}: {
  session: MobileSessionInfo;
  workItemRuns: Record<string, WorkItemRunSnapshot[]>;
  runNextCursor: Record<string, string | null>;
  onLoadRuns?: ((workItemId: string, cursor?: string) => void) | undefined;
}) {
  if (!session.workItemId) return null;
  const workItemId = session.workItemId;
  const runs = workItemRuns[workItemId] ?? [];
  return (
    <details className="mob-run-history" onToggle={(event) => {
      if (event.currentTarget.open && runs.length === 0) {
        onLoadRuns?.(workItemId);
      }
    }}>
      <summary>
        <span>Run history</span>
        {runs.length > 0 ? <span className="mob-run-history-count">{runs.length}</span> : null}
      </summary>
      <div className="mob-run-history-body">
        {runs.length === 0 ? (
          <p className="mob-run-history-empty">No prior runs loaded.</p>
        ) : (
          <ol aria-label={`Run history for ${sessionDisplayTitle(session)}`}>
            {runs.map((run) => <li key={run.runKey}>
              <div className="mob-run-history-line">
                <strong>Iteration {run.runNumber ?? "child"}</strong>
                <span>{run.outcome}</span>
              </div>
              <time>{run.endedAt
                ? new Date(run.endedAt).toLocaleString()
                : "Active now"}</time>
              {run.finalReport ? <p>{run.finalReport}</p> : null}
            </li>)}
          </ol>
        )}
        {runNextCursor[workItemId] ? (
          <button className="mob-mini-btn" type="button" onClick={() =>
            onLoadRuns?.(workItemId, runNextCursor[workItemId]!)}>Load more</button>
        ) : null}
      </div>
    </details>
  );
}

export function ActivityScreen({ sessions, onOpenSession, notice,
  workItemRuns = {}, runNextCursor = {}, onLoadRuns, send }: ActivityScreenProps) {
  const [visibility, setVisibility] = useState<ActivityVisibility>("open");
  const [summaryFilter, setSummaryFilter] = useState<ActivitySummaryFilter | null>(null);
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(() => new Set());

  const toggleChecked = (sessionKey: string) =>
    setCheckedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(sessionKey)) next.delete(sessionKey);
      else next.add(sessionKey);
      return next;
    });

  // Minions are spawned and managed by their leader; the mobile Activity list
  // surfaces top-level sessions only, so their cards are filtered out here.
  const visibilitySessions = sessions
    .filter((session) => session.role !== "minion" && isVisibleInActivity(session, visibility))
    .sort(compareActivityPriority);
  const visibleSessions = summaryFilter
    ? visibilitySessions.filter((session) => matchesSummaryFilter(session, summaryFilter))
    : visibilitySessions;
  const triage = groupSessionsForTriage(visibleSessions);
  const summaryItems: Array<{
    id: ActivitySummaryFilter;
    label: string;
    count: number;
    attention?: boolean;
  }> = [
    {
      id: "needs-you",
      label: "needs you",
      count: visibilitySessions.filter((session) => needsAttention(session)).length,
      attention: true,
    },
    {
      id: "active",
      label: "active",
      count: visibilitySessions.filter((session) => matchesSummaryFilter(session, "active")).length,
    },
    {
      id: "waiting",
      label: "waiting",
      count: visibilitySessions.filter((session) => matchesSummaryFilter(session, "waiting")).length,
    },
  ];

  const handleAction = send
    ? (action: LifecycleAction, session: MobileSessionInfo) =>
        send(buildLifecycleCommand(action, session, newRequestId()))
    : undefined;

  // The concrete sessions currently checked for a bulk action, in list order.
  const checkedSessions = visibleSessions.filter((session) => checkedKeys.has(session.sessionKey));
  const bulkCounts = {
    reviewable: checkedSessions.filter((session) => canAcknowledge(session)).length,
    dismissed: checkedSessions.filter((session) => isDismissed(session)).length,
    open: checkedSessions.filter((session) => !isDismissed(session)).length,
  };
  const clearSelection = () => setCheckedKeys(new Set());
  const selectAllVisible = () =>
    setCheckedKeys(new Set(visibleSessions.map((session) => session.sessionKey)));
  const applyBulk = handleAction
    ? (action: LifecycleAction) => {
        for (const session of checkedSessions) {
          if (action === "acknowledge" && !canAcknowledge(session)) continue;
          if (action === "dismiss" && isDismissed(session)) continue;
          if (action === "reopen" && !isDismissed(session)) continue;
          handleAction(action, session);
        }
        clearSelection();
      }
    : undefined;

  // Drop checked keys whose sessions have left the current view (e.g. after a
  // bulk dismiss moves them out of Open, or a filter change hides them) so the
  // bulk bar count stays honest. Keyed on a stable signature of visible keys.
  const visibleKeysSignature = visibleSessions.map((session) => session.sessionKey).join("\n");
  useEffect(() => {
    setCheckedKeys((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(visibleKeysSignature ? visibleKeysSignature.split("\n") : []);
      let changed = false;
      const next = new Set<string>();
      for (const key of prev) {
        if (visible.has(key)) next.add(key);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [visibleKeysSignature]);

  const filters = (
    <div className="mob-filters" role="tablist" aria-label="Activity visibility">
      {(["open", "all", "dismissed"] as const).map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={visibility === id}
          className={`mob-filter${visibility === id ? " mob-filter--active" : ""}`}
          onClick={() => {
            setVisibility(id);
            setSummaryFilter(null);
          }}
        >
          {VISIBILITY_LABELS[id]}
        </button>
      ))}
    </div>
  );

  if (visibilitySessions.length === 0) {
    return (
      <main className="mob-screen mob-activity" aria-label="Activity">
        <header className="mob-screen-header">
          <h1>Activity</h1>
          <span className="mob-count">0</span>
        </header>
        {notice ? <NoticeBanner notice={notice} /> : null}
        {filters}
        <div className="mob-empty">
          <p>{visibility === "dismissed" ? "No dismissed sessions." : "No sessions are running."}</p>
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

      <div className="mob-activity-summary" aria-label="Filter activity by status">
        {summaryItems.map((item) => {
          const selected = summaryFilter === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={`mob-summary-item${item.attention ? " mob-summary-item--attention" : ""}${
                selected ? " mob-summary-item--active" : ""
              }`}
              aria-pressed={selected}
              aria-label={`${item.label}: ${item.count}. ${selected ? "Clear filter" : "Filter activity"}`}
              onClick={() => setSummaryFilter(selected ? null : item.id)}
            >
              <strong>{item.count}</strong><span>{item.label}</span>
            </button>
          );
        })}
      </div>

      {filters}

      {applyBulk && checkedSessions.length > 0 ? (
        <div className="mob-bulk" role="toolbar" aria-label="Bulk actions">
          <span className="mob-bulk-count">{checkedSessions.length} selected</span>
          <div className="mob-bulk-actions">
            {bulkCounts.reviewable > 0 ? (
              <button
                className="mob-mini-btn mob-mini-btn--primary"
                type="button"
                onClick={() => applyBulk("acknowledge")}
              >
                Mark {bulkCounts.reviewable} reviewed
              </button>
            ) : null}
            {bulkCounts.open > 0 ? (
              <button className="mob-mini-btn" type="button" onClick={() => applyBulk("dismiss")}>
                Dismiss {bulkCounts.open}
              </button>
            ) : null}
            {bulkCounts.dismissed > 0 ? (
              <button className="mob-mini-btn" type="button" onClick={() => applyBulk("reopen")}>
                Restore {bulkCounts.dismissed}
              </button>
            ) : null}
            <button
              className="mob-mini-btn mob-mini-btn--ghost"
              type="button"
              onClick={selectAllVisible}
              disabled={checkedSessions.length === visibleSessions.length}
            >
              Select all
            </button>
            <button className="mob-mini-btn mob-mini-btn--ghost" type="button" onClick={clearSelection}>
              Clear
            </button>
          </div>
        </div>
      ) : null}

      {visibleSessions.length === 0 ? (
        <div className="mob-empty">
          <p>No sessions match this activity filter.</p>
        </div>
      ) : null}

      {triage.needsYou.length > 0 ? (
        <section className="mob-activity-section mob-activity-section--triage" aria-label="Needs you">
          <h2 className="mob-section-header">
            <span>Needs you</span>
            <span className="mob-section-count">{triage.needsYou.length}</span>
          </h2>
          <div className="mob-triage-list">
            {triage.needsYou.map((session) => (
              <div key={session.sessionKey}>
                <TriageRow
                  session={session}
                  onOpenSession={onOpenSession}
                  onAction={handleAction}
                  checked={checkedKeys.has(session.sessionKey)}
                  onToggleSelect={
                    handleAction ? () => toggleChecked(session.sessionKey) : undefined
                  }
                />
                <RunHistory
                  session={session}
                  workItemRuns={workItemRuns}
                  runNextCursor={runNextCursor}
                  onLoadRuns={onLoadRuns}
                />
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {triage.sections.map((section) => (
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
                <SessionCard
                  session={session}
                  onOpenSession={onOpenSession}
                  onAction={handleAction}
                  checked={checkedKeys.has(session.sessionKey)}
                  onToggleSelect={
                    handleAction ? () => toggleChecked(session.sessionKey) : undefined
                  }
                />
                <RunHistory
                  session={session}
                  workItemRuns={workItemRuns}
                  runNextCursor={runNextCursor}
                  onLoadRuns={onLoadRuns}
                />
              </div>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
