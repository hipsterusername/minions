import { evidenceForNodes, nodesForPlanItem, runtimeRole } from "./model.ts";
import { formatPlanStatus } from "./PlanRail.tsx";
import type { GraphPlanItem, TaskGraphNodeView, TaskGraphSnapshotView } from "./types.ts";

const MAX_PLAN_ROWS = 80;

export function PlanMap({
  snapshot,
  plan,
  selectedTaskId,
  onSelectPlan,
  onSelectNode,
  onSelectEvidence,
}: {
  snapshot: TaskGraphSnapshotView;
  plan: readonly GraphPlanItem[];
  selectedTaskId: string | null;
  onSelectPlan: (taskId: string | null) => void;
  onSelectNode: (nodeId: string) => void;
  onSelectEvidence: (evidenceId: string) => void;
}) {
  if (!plan.length) {
    return (
      <div className="tg-empty-state">
        <span className="tg-empty-state__icon">↔</span>
        <strong>Plan mapping is waiting for an authored plan</strong>
        <p>The runtime graph is still authoritative. No title-based or positional mappings are inferred.</p>
      </div>
    );
  }

  const rows = plan.slice(0, MAX_PLAN_ROWS);
  const mapped = plan.filter((item) => nodesForPlanItem(snapshot.nodes, item).length > 0).length;

  return (
    <div className="tg-plan-map">
      <header className="tg-lens-intro">
        <div>
          <span className="tg-eyebrow">Stable intent → runtime projection</span>
          <h3>Plan-to-execution map</h3>
          <p>Plan rows remain stable while Leader work, minion attempts, checkpoints, and outputs update underneath them.</p>
        </div>
        <span className="tg-coverage-pill">{mapped}/{plan.length} mapped</span>
      </header>

      <div className="tg-plan-table-wrap">
        <table className="tg-plan-table">
          <thead>
            <tr><th>Plan</th><th>Leader</th><th>Minions</th><th>Checkpoint</th><th>Outputs</th></tr>
          </thead>
          <tbody>
            {rows.map((item, index) => {
              const nodes = nodesForPlanItem(snapshot.nodes, item);
              const leaderNodes = nodes.filter((node) => runtimeRole(node, plan) === "leader");
              const minionNodes = nodes.filter((node) => runtimeRole(node, plan) !== "leader");
              const evidence = evidenceForNodes(snapshot, nodes);
              const outputs = [...new Set(nodes.flatMap((node) => node.outputArtifactIds))];
              return (
                <tr key={item.taskId} className={selectedTaskId === item.taskId ? "is-selected" : undefined}>
                  <td>
                    <button className="tg-map-plan" type="button" onClick={() => onSelectPlan(selectedTaskId === item.taskId ? null : item.taskId)}>
                      <span>P{index + 1}</span><strong>{item.title}</strong><small>{formatPlanStatus(item.status)}</small>
                    </button>
                  </td>
                  <td>{renderNodeChips(leaderNodes, onSelectNode, "Direct leader work")}</td>
                  <td>{renderNodeChips(minionNodes, onSelectNode, item.executor === "minion" ? "Awaiting runtime projection" : "Direct leader work")}</td>
                  <td>
                    {evidence.length ? evidence.map((entry) => (
                      <button key={entry.id} type="button" className="tg-task-chip tg-task-chip--checkpoint" onClick={() => onSelectEvidence(entry.id)}>
                        {entry.artifactId}
                      </button>
                    )) : <span className="tg-map-empty">—</span>}
                  </td>
                  <td>{outputs.length ? outputs.map((output) => <span className="tg-task-chip tg-task-chip--output" key={output}>{output}</span>) : <span className="tg-map-empty">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {plan.length > rows.length ? <p className="tg-bounded-note">Showing {rows.length} of {plan.length} authored plan items.</p> : null}
    </div>
  );
}

function renderNodeChips(nodes: readonly TaskGraphNodeView[], onSelect: (nodeId: string) => void, empty: string) {
  if (!nodes.length) return <span className="tg-map-empty">{empty}</span>;
  return <div className="tg-map-stack">{nodes.map((node) => (
    <button key={node.id} type="button" className="tg-task-chip" onClick={() => onSelect(node.id)}>
      {node.title}
    </button>
  ))}</div>;
}
