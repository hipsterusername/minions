import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { randomUuid } from "../random-id.ts";
import { ContextLineage, findProducer } from "./ContextLineage.tsx";
import { formatDuration } from "./GraphSummaryCard.tsx";
import { IterationTrack } from "./IterationTrack.tsx";
import { filterNodes, summarizeGraph } from "./model.ts";
import { NodeState } from "./NodeState.tsx";
import { PlanMap } from "./PlanMap.tsx";
import { PlanRail } from "./PlanRail.tsx";
import { Topology } from "./Topology.tsx";
import { WorkQueue } from "./WorkQueue.tsx";
import type {
  EvidenceLineageView,
  GraphFilter,
  GraphInspectorAction,
  GraphInspectorCallbacks,
  GraphPlanItem,
  TaskGraphNodeView,
  TaskGraphSnapshotView,
} from "./types.ts";
import "./task-graph.css";

type Tab = "topology" | "plan" | "evidence" | "overview" | "queue" | "timeline";
type ActionIntent =
  | { type: "pause" | "resume" | "retry" | "cancel_attempt" | "request_verification" | "cancel_run" }
  | { type: "waive_verification"; reason: string }
  | { type: "provide_input"; input: string };

const TABS: { id: Tab; label: string }[] = [
  { id: "topology", label: "Flow" },
  { id: "plan", label: "Plan map" },
  { id: "evidence", label: "Context lineage" },
  { id: "overview", label: "Overview" },
  { id: "queue", label: "Work queue" },
  { id: "timeline", label: "Timeline" },
];

const FILTERS: { id: GraphFilter; label: string }[] = [
  { id: "all", label: "All nodes" },
  { id: "active", label: "Active path" },
  { id: "attention", label: "Needs attention" },
  { id: "ready", label: "Ready" },
  { id: "blocked", label: "Blocked" },
  { id: "failed", label: "Failed" },
  { id: "unverified", label: "Unverified" },
  { id: "critical", label: "Critical" },
];

export interface GraphInspectorProps extends GraphInspectorCallbacks {
  snapshot: TaskGraphSnapshotView;
  onClose: () => void;
  plan?: readonly GraphPlanItem[];
  goal?: string | null | undefined;
  initialTab?: Tab;
  controlsEnabled?: boolean;
}

export function GraphInspector({
  snapshot,
  onClose,
  onAction,
  createRequestId,
  plan = [],
  goal,
  initialTab = "topology",
  controlsEnabled = true,
}: GraphInspectorProps) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [filter, setFilter] = useState<GraphFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const [focusedPlanTaskId, setFocusedPlanTaskId] = useState<string | null>(null);
  const [planOpen, setPlanOpen] = useState(() => typeof window === "undefined" || window.innerWidth >= 900);
  const [detailOpen, setDetailOpen] = useState(() => typeof window === "undefined" || window.innerWidth >= 900);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const filteredNodes = useMemo(() => filterNodes(snapshot.nodes, filter), [snapshot.nodes, filter]);
  const selected = snapshot.nodes.find((node) => node.id === selectedId) ?? null;
  const selectedEvidence = snapshot.evidence.find((item) => item.id === selectedEvidenceId) ?? null;
  const summary = summarizeGraph(snapshot);
  const canPause = snapshot.status === "running" || snapshot.status === "quiescent" || snapshot.status === "blocked";
  const canCancelRun = canPause || snapshot.status === "paused";

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    let wasNarrow = window.innerWidth < 900;
    const collapseAtNarrowWidth = () => {
      const isNarrow = window.innerWidth < 900;
      if (isNarrow && !wasNarrow) {
        setPlanOpen(false);
        setDetailOpen(false);
      }
      wasNarrow = isNarrow;
    };
    window.addEventListener("resize", collapseAtNarrowWidth);
    return () => window.removeEventListener("resize", collapseAtNarrowWidth);
  }, []);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "Escape") {
        event.stopPropagation();
        if (selectedId || selectedEvidenceId) {
          setSelectedId(null);
          setSelectedEvidenceId(null);
        } else onClose();
      }
      if (event.key === "Tab" && dialogRef.current) {
        const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')];
        if (!focusable.length) return;
        const first = focusable[0]!;
        const last = focusable.at(-1)!;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onClose, selectedId, selectedEvidenceId]);

  const requestId = () => createRequestId?.() ?? randomUuid();
  const dispatch = (action: ActionIntent, node: TaskGraphNodeView | null = null) => {
    onAction({
      ...action,
      requestId: requestId(),
      graphRunId: snapshot.graphRunId,
      expectedRunRevision: snapshot.revision,
      nodeId: node?.id ?? null,
      currentAttemptId: node?.currentAttempt?.id ?? null,
    } as GraphInspectorAction);
  };
  const onTabKey = (event: ReactKeyboardEvent, index: number) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
    setTab(TABS[next]!.id);
    document.getElementById(`tg-tab-${TABS[next]!.id}`)?.focus();
  };
  const selectNode = (nodeId: string, revealFlow = false) => {
    setSelectedId(nodeId);
    setSelectedEvidenceId(null);
    setDetailOpen(true);
    if (revealFlow) setTab("topology");
  };
  const selectEvidence = (evidenceId: string) => {
    setSelectedEvidenceId(evidenceId);
    setSelectedId(null);
    setDetailOpen(true);
    setTab("evidence");
  };
  const selectPlan = (taskId: string | null) => {
    setFocusedPlanTaskId(taskId);
    setTab("topology");
  };

  return (
    <div className="tg-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="tg-inspector" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="tg-inspector__header">
          <div className="tg-inspector__title">
            <span className="tg-eyebrow">Leader / execution workspace</span>
            <h2 id={titleId}>{snapshot.title}</h2>
          </div>
          <div className="tg-header-actions">
            <button className="tg-icon-button" aria-label={planOpen ? "Collapse plan" : "Expand plan"} aria-pressed={planOpen} onClick={() => setPlanOpen((open) => !open)}>P</button>
            <button className="tg-icon-button" aria-label={detailOpen ? "Collapse details" : "Expand details"} aria-pressed={detailOpen} onClick={() => setDetailOpen((open) => !open)}>I</button>
            {canPause ? <button className="tg-button" disabled={!controlsEnabled} onClick={() => dispatch({ type: "pause" })}>Pause</button> : snapshot.status === "paused" ? <button className="tg-button" disabled={!controlsEnabled} onClick={() => dispatch({ type: "resume" })}>Resume</button> : null}
            {canCancelRun ? <button className="tg-button tg-button--danger" disabled={!controlsEnabled} onClick={() => dispatch({ type: "cancel_run" })}>Cancel run</button> : null}
            <button className="tg-close" aria-label="Close graph inspector" onClick={onClose}>×</button>
          </div>
        </header>

        <section className="tg-mission-bar" aria-label="Execution goal and run status">
          <div className="tg-mission-copy"><span className="tg-eyebrow">Goal</span><p>{goal ?? snapshot.title}</p></div>
          <div className="tg-mission-stats">
            <span className={`tg-run-status tg-run-status--${snapshot.status}`}>{snapshot.status}</span>
            <span>{summary.succeeded}/{summary.total} complete</span>
            <span>{snapshot.capacity.running}/{snapshot.capacity.limit} slots</span>
            <span>rev {snapshot.revision}</span>
          </div>
        </section>

        <div className={`tg-workspace${planOpen ? "" : " is-plan-collapsed"}${detailOpen ? "" : " is-detail-collapsed"}`}>
          {planOpen ? <PlanRail snapshot={snapshot} plan={plan} selectedTaskId={focusedPlanTaskId} onSelect={selectPlan} /> : null}

          <section className="tg-graph-workspace">
            <div className="tg-graph-toolbar">
              <div className="tg-tabs" role="tablist" aria-label="Execution workspace views">
                {TABS.map((item, index) => (
                  <button
                    id={`tg-tab-${item.id}`}
                    key={item.id}
                    role="tab"
                    aria-selected={tab === item.id}
                    aria-controls={`tg-panel-${item.id}`}
                    tabIndex={tab === item.id ? 0 : -1}
                    onKeyDown={(event) => onTabKey(event, index)}
                    onClick={() => setTab(item.id)}
                  >{item.label}</button>
                ))}
              </div>
              {tab === "topology" ? (
                <div className="tg-filterbar" aria-label="Graph filters">
                  {FILTERS.map((item) => <button key={item.id} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}
                  <span className="tg-filterbar__count">{filteredNodes.length}/{snapshot.nodes.length}</span>
                </div>
              ) : null}
              {focusedPlanTaskId ? <button className="tg-selection-chip" type="button" onClick={() => setFocusedPlanTaskId(null)}>Plan focus · {focusedPlanTaskId} ×</button> : null}
            </div>

            <main id={`tg-panel-${tab}`} role="tabpanel" aria-labelledby={`tg-tab-${tab}`} className="tg-panel">
              {tab === "topology" ? <Topology snapshot={snapshot} filter={filter} selectedNodeId={selectedId} focusedPlanTaskId={focusedPlanTaskId} plan={plan} onSelect={(id) => selectNode(id)} /> : null}
              {tab === "plan" ? <PlanMap snapshot={snapshot} plan={plan} selectedTaskId={focusedPlanTaskId} onSelectPlan={setFocusedPlanTaskId} onSelectNode={(id) => selectNode(id, true)} onSelectEvidence={selectEvidence} /> : null}
              {tab === "evidence" ? <ContextLineage snapshot={snapshot} selectedEvidenceId={selectedEvidenceId} onSelectEvidence={selectEvidence} onSelectNode={(id) => selectNode(id)} /> : null}
              {tab === "overview" ? <Overview snapshot={snapshot} onSelect={(id) => selectNode(id, true)} /> : null}
              {tab === "queue" ? <WorkQueue nodes={filteredNodes} onSelect={(id) => selectNode(id)} /> : null}
              {tab === "timeline" ? <Timeline snapshot={snapshot} onSelect={(id) => selectNode(id, true)} /> : null}
            </main>

            {tab === "topology" || tab === "plan" || tab === "evidence" ? <IterationTrack snapshot={snapshot} onSelectNode={(id) => selectNode(id, true)} onSelectEvidence={selectEvidence} /> : null}
          </section>

          {detailOpen ? selected ? (
            <DetailDrawer node={selected} controlsEnabled={controlsEnabled} onClose={() => setSelectedId(null)} dispatch={dispatch} />
          ) : selectedEvidence ? (
            <EvidenceDetail evidence={selectedEvidence} snapshot={snapshot} onSelectNode={(id) => selectNode(id, true)} onClose={() => setSelectedEvidenceId(null)} />
          ) : (
            <aside className="tg-detail tg-detail--empty" aria-label="Selection details">
              <span className="tg-empty-state__icon">⌁</span><strong>Inspector</strong><p>Select a task, plan row, or checkpoint to inspect its canonical runtime facts.</p>
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Overview({ snapshot, onSelect }: { snapshot: TaskGraphSnapshotView; onSelect: (id: string) => void }) {
  const summary = summarizeGraph(snapshot);
  const remaining = snapshot.budget.limitUsd == null ? null : Math.max(0, snapshot.budget.limitUsd - snapshot.budget.spentUsd);
  const critical = snapshot.criticalPath.nodeIds.map((id) => snapshot.nodes.find((node) => node.id === id)).filter(Boolean) as TaskGraphNodeView[];
  const metrics = [["Logical progress", `${summary.succeeded}/${summary.total}`], ["Running attempts", summary.running], ["Ready / capacity", `${summary.ready} / ${snapshot.capacity.running} of ${snapshot.capacity.limit}`], ["Blocked", summary.blocked], ["Logical failures", summary.logicalFailed], ["Attempt-only failures", summary.attemptFailed], ["Verified outputs", summary.verified], ["Unverified outputs", summary.unverified]];
  return <div className="tg-overview"><div className="tg-metrics">{metrics.map(([label, value]) => <div className="tg-metric" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><section className="tg-budget"><h3>Cost &amp; budget</h3><strong>${snapshot.budget.spentUsd.toFixed(2)}</strong><span>{remaining == null ? "No limit" : `$${remaining.toFixed(2)} remaining`} · {snapshot.budget.tokens.toLocaleString()} tokens</span></section><section className="tg-critical"><h3>Completion-determining chain</h3><p>{formatDuration(snapshot.criticalPath.observedMs)} observed · {formatDuration(snapshot.criticalPath.estimatedRemainingMs)} estimated remaining</p><div>{critical.map((node, index) => <span key={node.id}><button onClick={() => onSelect(node.id)}>{node.title}</button>{index < critical.length - 1 ? " → " : null}</span>)}</div></section></div>;
}

function Timeline({ snapshot, onSelect }: { snapshot: TaskGraphSnapshotView; onSelect: (id: string) => void }) {
  const rows = snapshot.timeline.slice(-160).reverse();
  return <ol className="tg-timeline">{rows.map((event) => <li key={event.id}><time>{new Date(event.at).toLocaleTimeString()}</time><span className="tg-event-type">{event.type}</span>{event.nodeId ? <button onClick={() => onSelect(event.nodeId!)}>{event.summary}</button> : <span>{event.summary}</span>}</li>)}</ol>;
}

function EvidenceDetail({ evidence, snapshot, onSelectNode, onClose }: { evidence: EvidenceLineageView; snapshot: TaskGraphSnapshotView; onSelectNode: (id: string) => void; onClose: () => void }) {
  const producer = findProducer(snapshot.nodes, evidence);
  return <aside className="tg-detail" aria-labelledby="tg-evidence-detail-title"><header><div><span className="tg-eyebrow">Context checkpoint</span><h3 id="tg-evidence-detail-title">{evidence.artifactId}</h3></div><button className="tg-close" aria-label="Close checkpoint details" onClick={onClose}>×</button></header><span className={`tg-detail-status tg-verification--${evidence.status}`}>{evidence.status.replaceAll("_", " ")}</span><section><h4>Lineage</h4><div className="tg-detail-lineage"><span>{producer?.title ?? evidence.producerAttemptId}</span><b>→</b><span>{evidence.artifactId}</span><b>→</b><span>{evidence.consumerNodeIds.length} consumers</span></div></section><section><h4>Transfer manifest</h4><dl className="tg-kv-list"><div><dt>Source</dt><dd>{evidence.sourceSnapshot}</dd></div><div><dt>Producer</dt><dd>{evidence.producerAttemptId}</dd></div><div><dt>Verifier</dt><dd>{evidence.verifierAttemptId ?? "Pending"}</dd></div><div><dt>Consumers</dt><dd>{evidence.consumerNodeIds.length}</dd></div></dl></section>{evidence.consumerNodeIds.length ? <section><h4>Downstream consumers</h4><div className="tg-detail-chips">{evidence.consumerNodeIds.map((id) => <button type="button" key={id} onClick={() => onSelectNode(id)}>{snapshot.nodes.find((node) => node.id === id)?.title ?? id}</button>)}</div></section> : null}</aside>;
}

function DetailDrawer({ node, controlsEnabled, onClose, dispatch }: { node: TaskGraphNodeView; controlsEnabled: boolean; onClose: () => void; dispatch: (action: ActionIntent, node?: TaskGraphNodeView | null) => void }) {
  const [input, setInput] = useState("");
  const [waiverReason, setWaiverReason] = useState("");
  const attemptState = node.currentAttempt?.state;
  const canRetry = attemptState === "failed" || attemptState === "cancelled" || attemptState === "backoff" || node.logicalState === "failed" || node.logicalState === "exhausted";
  const canCancel = attemptState === "queued" || attemptState === "running" || attemptState === "blocked";
  const canVerify = node.outputArtifactIds.length > 0 && (node.verification.state === "pending" || node.verification.state === "failed" || node.verification.state === "stale");
  const needsInput = node.blocker?.category === "input";
  return <aside className="tg-detail" aria-labelledby="tg-detail-title"><header><div><span className="tg-eyebrow">{node.kind} · {node.id}</span><h3 id="tg-detail-title">{node.title}</h3></div><button className="tg-close" aria-label="Close task details" onClick={onClose}>×</button></header><NodeState node={node} /><section><h4>Why not running?</h4><p>{node.currentAttempt?.state === "running" ? "Running now" : node.blocker?.explanation ?? (node.readiness === "ready" ? "Ready; waiting for executor capacity" : "Waiting for dependencies")}</p></section><section><h4>Current session &amp; ownership</h4><p>{node.currentAttempt?.sessionId ?? "No active session"} · {node.owner ?? "unowned"}</p><p>${node.budgetReservedUsd?.toFixed(2) ?? "0.00"} reserved · ${node.costUsd.toFixed(2)} spent · {node.tokens.toLocaleString()} tokens</p></section><section><h4>Inputs &amp; outputs</h4><div className="tg-detail-chips">{node.inputIds.map((id) => <span key={`input-${id}`}>{id}</span>)}{node.outputArtifactIds.map((id) => <span key={`output-${id}`}>{id}</span>)}{!node.inputIds.length && !node.outputArtifactIds.length ? <em>None projected</em> : null}</div></section><section><h4>Attempt history</h4>{node.attemptHistory.slice(-30).reverse().map((attempt) => <p key={attempt.id}>#{attempt.number} {attempt.state} · {attempt.executor ?? "unassigned"} · ${attempt.costUsd.toFixed(2)}</p>)}</section><section><h4>Logs</h4>{node.logs?.slice(-50).map((line, index) => <pre key={`${index}-${line}`}>{line}</pre>) ?? <p>No logs</p>}</section><div className="tg-detail__controls">{canRetry ? <button disabled={!controlsEnabled} onClick={() => dispatch({ type: "retry" }, node)}>Retry</button> : null}{canCancel ? <button disabled={!controlsEnabled} onClick={() => dispatch({ type: "cancel_attempt" }, node)}>Cancel attempt</button> : null}{canVerify ? <button disabled={!controlsEnabled} onClick={() => dispatch({ type: "request_verification" }, node)}>Verify</button> : null}{canVerify ? <><label>Waiver reason<textarea disabled={!controlsEnabled} value={waiverReason} onChange={(event) => setWaiverReason(event.target.value)} /></label><button disabled={!controlsEnabled || !waiverReason.trim()} onClick={() => { dispatch({ type: "waive_verification", reason: waiverReason.trim() }, node); setWaiverReason(""); }}>Waive verification</button></> : null}{needsInput ? <><label>Provide input<textarea disabled={!controlsEnabled} value={input} onChange={(event) => setInput(event.target.value)} /></label><button disabled={!controlsEnabled || !input.trim()} onClick={() => { dispatch({ type: "provide_input", input: input.trim() }, node); setInput(""); }}>Send input</button></> : null}</div></aside>;
}
