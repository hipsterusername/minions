import { runtimeRole, summarizeGraph } from "./model.ts";
import type { GraphPlanItem, TaskGraphSnapshotView } from "./types.ts";
import "./task-graph.css";

export function GraphSummaryCard({
  snapshot,
  onOpen,
  plan = [],
  goal,
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
  const previewNodes = snapshot.nodes
    .filter((node) => node.currentAttempt?.state === "running" || node.blocker || node.readiness === "ready")
    .slice(0, 3);
  const fallbackNodes = previewNodes.length ? previewNodes : snapshot.nodes.slice(0, 3);

  return (
    <section className="tg-summary" aria-label={`Task graph ${snapshot.title}`}>
      <header className="tg-summary__head">
        <div className="tg-summary__identity">
          <span className="tg-summary__leader-mark" aria-hidden="true">L</span>
          <div><strong>{snapshot.title}</strong><span>{goal ?? "Canonical execution graph"}</span></div>
        </div>
        <span className={`tg-run-status tg-run-status--${snapshot.status}`}>{snapshot.status}</span>
      </header>

      <div className="tg-summary__goal">
        <span className="tg-eyebrow">Goal</span>
        <p>{goal ?? snapshot.title}</p>
      </div>

      <div className="tg-mini-flow" aria-hidden="true">
        <span className="tg-mini-flow__leader">Leader</span>
        <span className="tg-mini-flow__line" />
        <span className="tg-mini-flow__fanout">
          {fallbackNodes.map((node) => (
            <i
              key={node.id}
              className={`tg-mini-flow__node tg-mini-flow__node--${runtimeRole(node, plan)} tg-mini-flow__node--${node.currentAttempt?.state ?? node.logicalState}`}
              title={node.title}
            />
          ))}
        </span>
        <span className="tg-mini-flow__line" />
        <span className={`tg-mini-flow__checkpoint${snapshot.evidence.length ? " is-ready" : ""}`}>◇</span>
      </div>

      <div className="tg-summary__progress-copy">
        <strong>{summary.succeeded}/{summary.total} logical tasks</strong>
        <span>{summary.running} running · {summary.blocked + summary.logicalFailed} need attention</span>
      </div>
      <div className="tg-progress" aria-label={`${summary.succeeded} of ${summary.total} logical tasks succeeded`}>
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="tg-summary__stats">
        <span><b>{summary.running}</b>Running</span>
        <span><b>{summary.ready}</b>Ready</span>
        <span><b>{snapshot.evidence.length}</b>Checkpoints</span>
        <span><b>{summary.unverified}</b>Unverified</span>
      </div>
      <footer className="tg-summary__foot">
        {stale ? <span className="tg-plan-proposal__warning">Reconnecting · controls paused</span> : null}
        <span>${snapshot.budget.spentUsd.toFixed(2)} spent{remaining == null ? "" : ` · $${remaining.toFixed(2)} left`}</span>
        <span>{formatDuration(snapshot.criticalPath.estimatedRemainingMs)} critical path</span>
        <button type="button" className="tg-button tg-button--primary" onClick={onOpen}>Open graph</button>
      </footer>
    </section>
  );
}

export function formatDuration(ms: number) {
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.ceil(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
