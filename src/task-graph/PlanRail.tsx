import { nodesForPlanItem } from "./model.ts";
import type { GraphPlanItem, TaskGraphSnapshotView } from "./types.ts";

export function PlanRail({
  snapshot,
  plan,
  selectedTaskId,
  onSelect,
  onClose,
}: {
  snapshot: TaskGraphSnapshotView;
  plan: readonly GraphPlanItem[];
  selectedTaskId: string | null;
  onSelect: (taskId: string | null) => void;
  onClose?: (() => void) | undefined;
}) {
  const completed = plan.filter((item) => item.status === "completed").length;
  const active = plan.filter((item) => item.status === "running" || item.status === "starting").length;

  return (
    <aside className="tg-plan-rail" aria-label="Authored execution plan">
      <header className="tg-rail-header">
        <div>
          <span className="tg-eyebrow">Plan</span>
          <strong>{plan.length ? `${completed}/${plan.length} complete` : "Not attached"}</strong>
        </div>
        <div className="tg-rail-header__actions">
          {active > 0 ? <span className="tg-live-count">{active} active</span> : null}
          {onClose ? <button type="button" className="tg-close tg-rail-close" aria-label="Collapse plan" onClick={onClose}>×</button> : null}
        </div>
      </header>

      {plan.length ? (
        <ol className="tg-plan-list">
          {plan.map((item, index) => {
            const mappedNodes = nodesForPlanItem(snapshot.nodes, item);
            const selected = selectedTaskId === item.taskId;
            return (
              <li key={item.taskId}>
                <button
                  type="button"
                  className="tg-plan-row"
                  aria-pressed={selected}
                  onClick={() => onSelect(selected ? null : item.taskId)}
                >
                  <span className={`tg-plan-index tg-plan-index--${item.status}`}>P{index + 1}</span>
                  <span className="tg-plan-copy">
                    <strong>{item.title}</strong>
                    <small>
                      {item.executor === "leader" ? "Leader" : "Minion"}
                      {mappedNodes.length ? ` · ${mappedNodes.length} runtime ${mappedNodes.length === 1 ? "node" : "nodes"}` : " · awaiting projection"}
                    </small>
                  </span>
                  <span className={`tg-plan-status tg-plan-status--${item.status}`}>{formatPlanStatus(item.status)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="tg-rail-empty">
          <strong>No authored plan attached</strong>
          <p>The canonical runtime graph is available. Plan mappings appear when this Leader’s task plan is present.</p>
        </div>
      )}

      <section className="tg-grammar" aria-label="Execution grammar">
        <span className="tg-eyebrow">Execution grammar</span>
        <div><i className="tg-grammar-shape tg-grammar-shape--leader" />Leader work</div>
        <div><i className="tg-grammar-shape tg-grammar-shape--minion" />Minion attempt</div>
        <div><i className="tg-grammar-shape tg-grammar-shape--checkpoint" />Context checkpoint</div>
      </section>
    </aside>
  );
}

export function formatPlanStatus(status: GraphPlanItem["status"]) {
  return status === "ended_without_report" ? "No report" : status.replaceAll("_", " ");
}
