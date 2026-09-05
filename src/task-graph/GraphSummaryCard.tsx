import { CrewIcon } from "../components/CrewIcon.tsx";
import { summarizeGraph } from "./model.ts";
import type { GraphPlanItem, TaskGraphSnapshotView } from "./types.ts";
import "./task-graph.css";

export function GraphSummaryCard({
  snapshot,
  onOpen,
  stale = false,
}: {
  snapshot: TaskGraphSnapshotView;
  onOpen: () => void;
  plan?: readonly GraphPlanItem[];
  goal?: string | null | undefined;
  stale?: boolean;
}) {
  const summary = summarizeGraph(snapshot);
  const remaining = snapshot.budget.limitUsd == null ? null : Math.max(0, snapshot.budget.limitUsd - snapshot.budget.spentUsd);
  const progress = summary.total ? (summary.succeeded / summary.total) * 100 : 0;
  const attention = summary.blocked + summary.logicalFailed;
  const budget = remaining == null
    ? `$${snapshot.budget.spentUsd.toFixed(2)} spent`
    : `$${remaining.toFixed(2)} left`;

  return (
    <section className="tg-summary tg-summary--graph" aria-label={`Task graph ${snapshot.title}`}>
      <div className="tg-summary-strip">
        <div className="tg-summary__identity">
          <span className="tg-summary__leader-mark" aria-hidden="true"><CrewIcon aria-hidden="true" active={snapshot.status === "running"} /></span>
          <div className="tg-summary__copy">
            <strong title={snapshot.title}>{snapshot.title}</strong>
            <div className="tg-summary__signals">
              <span className={`tg-run-status tg-run-status--${snapshot.status}`}>{snapshot.status}</span>
              <span className="tg-summary__metric" aria-label={`${summary.succeeded} of ${summary.total} logical tasks succeeded`}>
                <b>{summary.succeeded}/{summary.total}</b> succeeded
              </span>
              {summary.running > 0 ? <span className="tg-summary__signal tg-summary__signal--running">{summary.running} running</span> : null}
              {attention > 0 ? <span className="tg-summary__signal tg-summary__signal--attention">{attention} need attention</span> : null}
              {summary.running === 0 && attention === 0 ? <span className="tg-summary__signal">All clear</span> : null}
              {stale ? <span className="tg-summary__signal tg-summary__signal--stale">Reconnecting</span> : null}
            </div>
          </div>
        </div>
        <span className="tg-summary__secondary" title={`${budget} · ${formatDuration(snapshot.criticalPath.estimatedRemainingMs)} critical path`}>
          {budget} · {formatDuration(snapshot.criticalPath.estimatedRemainingMs)} path
        </span>
        <button type="button" className="tg-button tg-button--primary tg-summary__open" onClick={onOpen}>
          Open graph <span aria-hidden="true">↗</span>
        </button>
      </div>
      <span className="tg-summary__progress" aria-hidden="true" style={{ width: `${progress}%` }} />
    </section>
  );
}

export function formatDuration(ms: number) {
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.ceil(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
