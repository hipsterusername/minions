import { findProducer } from "./ContextLineage.tsx";
import type { EvidenceLineageView, TaskGraphGroupView, TaskGraphNodeView, TaskGraphSnapshotView } from "./types.ts";

export function IterationTrack({
  snapshot,
  onSelectNode,
  onSelectEvidence,
}: {
  snapshot: TaskGraphSnapshotView;
  onSelectNode: (nodeId: string) => void;
  onSelectEvidence: (evidenceId: string) => void;
}) {
  const groups = snapshot.groups.length ? snapshot.groups : fallbackGroup(snapshot.nodes);
  const steps = groups.flatMap((group, index) => {
    const nodes = group.nodeIds.map((id) => snapshot.nodes.find((node) => node.id === id)).filter(Boolean) as TaskGraphNodeView[];
    const checkpoint = checkpointAfterGroup(snapshot, group);
    return [
      <button
        type="button"
        className={`tg-iteration-step tg-iteration-step--${groupState(nodes)}`}
        key={group.id}
        onClick={() => nodes[0] && onSelectNode(nodes.find((node) => node.currentAttempt?.state === "running")?.id ?? nodes[0].id)}
      >
        <span className="tg-iteration-dot">{groupState(nodes) === "done" ? "✓" : index + 1}</span>
        <span>{group.title}</span>
      </button>,
      ...(checkpoint ? [
        <button
          type="button"
          className={`tg-iteration-step tg-iteration-step--checkpoint tg-iteration-step--${checkpoint.status === "passed" ? "done" : "future"}`}
          key={`checkpoint-${checkpoint.id}`}
          onClick={() => onSelectEvidence(checkpoint.id)}
        >
          <span className="tg-iteration-dot">◇</span>
          <span>Checkpoint</span>
        </button>,
      ] : []),
    ];
  });

  return (
    <footer className="tg-iteration-track" aria-label="Graph stage and checkpoint continuity">
      <div className="tg-iteration-summary">
        <strong>Run continuity</strong>
        <span>{snapshot.groups.length} stages · {snapshot.evidence.length} checkpoints</span>
      </div>
      <div className="tg-iteration-steps">{steps}</div>
      <span className="tg-iteration-note">rev {snapshot.revision} · server projected</span>
    </footer>
  );
}

function fallbackGroup(nodes: readonly TaskGraphNodeView[]): TaskGraphGroupView[] {
  return [{ id: "graph-run", title: "Graph run", kind: "stage", nodeIds: nodes.map((node) => node.id), costUsd: nodes.reduce((sum, node) => sum + node.costUsd, 0) }];
}

function checkpointAfterGroup(snapshot: TaskGraphSnapshotView, group: TaskGraphGroupView): EvidenceLineageView | null {
  const nodeIds = new Set(group.nodeIds);
  return snapshot.evidence.find((item) => {
    const producer = findProducer(snapshot.nodes, item);
    return !!producer && nodeIds.has(producer.id);
  }) ?? null;
}

function groupState(nodes: readonly TaskGraphNodeView[]) {
  if (nodes.length && nodes.every((node) => node.logicalState === "succeeded")) return "done" as const;
  if (nodes.some((node) => node.logicalState === "failed" || node.logicalState === "exhausted"
    || node.logicalState === "not_run" || (node.blocker && node.blocker.category !== "none"))) return "attention" as const;
  if (nodes.some((node) => node.currentAttempt?.state === "running")) return "active" as const;
  return "future" as const;
}
