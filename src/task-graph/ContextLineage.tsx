import { Inbox, Send } from "lucide-react";
import type { EvidenceLineageView, TaskGraphNodeView, TaskGraphSnapshotView } from "./types.ts";

const MAX_CHECKPOINTS = 80;

export function ContextLineage({
  snapshot,
  selectedEvidenceId,
  onSelectEvidence,
  onSelectNode,
}: {
  snapshot: TaskGraphSnapshotView;
  selectedEvidenceId: string | null;
  onSelectEvidence: (evidenceId: string) => void;
  onSelectNode: (nodeId: string) => void;
}) {
  const evidence = snapshot.evidence.slice(0, MAX_CHECKPOINTS);
  const active = evidence.find((item) => item.id === selectedEvidenceId) ?? evidence[0] ?? null;

  if (!active) {
    return (
      <div className="tg-empty-state">
        <span className="tg-empty-state__icon">◇</span>
        <strong>No context checkpoints yet</strong>
        <p>Committed artifacts and verification lineage will appear here when the server projects them.</p>
      </div>
    );
  }

  const producer = findProducer(snapshot.nodes, active);
  const consumers = active.consumerNodeIds
    .map((id) => snapshot.nodes.find((node) => node.id === id))
    .filter(Boolean) as TaskGraphNodeView[];

  return (
    <div className="tg-lineage-lens">
      <header className="tg-lens-intro">
        <div>
          <span className="tg-eyebrow">Bounded, inspectable transfer</span>
          <h3>Context lineage</h3>
          <p>Each checkpoint exposes the exact source snapshot, producer attempt, artifact, verification, and downstream consumers.</p>
        </div>
        <div className="tg-checkpoint-switcher" role="tablist" aria-label="Context checkpoints">
          {evidence.map((item, index) => (
            <button
              type="button"
              role="tab"
              aria-selected={active.id === item.id}
              key={item.id}
              onClick={() => onSelectEvidence(item.id)}
            >C{index + 1}</button>
          ))}
        </div>
      </header>

      <div className="tg-lineage-flow">
        <article className="tg-lineage-card tg-lineage-card--source">
          <span className="tg-lineage-icon" aria-hidden="true"><Send aria-hidden="true" /></span>
          <span className="tg-eyebrow">Source</span>
          <h4>{producer?.title ?? "Producer attempt"}</h4>
          <p>{active.producerAttemptId}</p>
          <code>{active.sourceSnapshot}</code>
          {producer ? <button type="button" onClick={() => onSelectNode(producer.id)}>Inspect producer</button> : null}
        </article>
        <span className="tg-lineage-arrow" aria-hidden="true">→</span>
        <article className="tg-lineage-card tg-lineage-card--packet">
          <span className="tg-lineage-icon">◇</span>
          <span className="tg-eyebrow">Context checkpoint</span>
          <h4>{active.artifactId}</h4>
          <p>{active.status === "passed" ? "Verified before transfer" : `Verification ${active.status.replaceAll("_", " ")}`}</p>
          <code>{active.verifierAttemptId ?? "verifier pending"}</code>
        </article>
        <span className="tg-lineage-arrow" aria-hidden="true">→</span>
        <article className="tg-lineage-card tg-lineage-card--target">
          <span className="tg-lineage-icon" aria-hidden="true"><Inbox aria-hidden="true" /></span>
          <span className="tg-eyebrow">Next consumers</span>
          <h4>{consumers.length ? `${consumers.length} downstream ${consumers.length === 1 ? "task" : "tasks"}` : "No consumers admitted"}</h4>
          <p>{consumers.length ? "Consumers reference the committed artifact identity." : "The artifact remains available without an invented downstream handoff."}</p>
          <div className="tg-consumer-list">
            {consumers.map((node) => <button type="button" key={node.id} onClick={() => onSelectNode(node.id)}>{node.title}</button>)}
          </div>
        </article>
      </div>

      <section className="tg-transfer-manifest">
        <div><span>Source snapshot</span><strong>{active.sourceSnapshot}</strong></div>
        <div><span>Producer attempt</span><strong>{active.producerAttemptId}</strong></div>
        <div><span>Verification</span><strong>{active.status.replaceAll("_", " ")}</strong></div>
        <div><span>Consumers</span><strong>{active.consumerNodeIds.length}</strong></div>
      </section>
      {snapshot.evidence.length > evidence.length ? <p className="tg-bounded-note">Showing {evidence.length} of {snapshot.evidence.length} checkpoint rows.</p> : null}
    </div>
  );
}

export function findProducer(nodes: readonly TaskGraphNodeView[], evidence: EvidenceLineageView) {
  return nodes.find((node) => node.attemptHistory.some((attempt) => attempt.id === evidence.producerAttemptId)) ?? null;
}
