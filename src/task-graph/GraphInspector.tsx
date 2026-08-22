import { Workflow } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ViewportOverlay } from "../components/ViewportOverlay.tsx";
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
  | {type:"adjudicate";decision:"accepted"|"rejected"|"retry";reason:string;guidance?:string}
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
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < 900);
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
      setNarrow(isNarrow);
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
        if (narrow && (planOpen || detailOpen)) {
          setSelectedId(null);
          setSelectedEvidenceId(null);
          setPlanOpen(false);
          setDetailOpen(false);
        } else if (selectedId || selectedEvidenceId) {
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
  }, [detailOpen, narrow, onClose, planOpen, selectedId, selectedEvidenceId]);

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
    if (narrow) setPlanOpen(false);
    if (revealFlow) setTab("topology");
  };
  const selectEvidence = (evidenceId: string) => {
    setSelectedEvidenceId(evidenceId);
    setSelectedId(null);
    setDetailOpen(true);
    if (narrow) setPlanOpen(false);
    setTab("evidence");
  };
  const selectPlan = (taskId: string | null) => {
    setFocusedPlanTaskId(taskId);
    setTab("topology");
  };
  const togglePlan = () => setPlanOpen((open) => {
    if (!open && narrow) setDetailOpen(false);
    return !open;
  });
  const toggleDetail = () => setDetailOpen((open) => {
    if (!open && narrow) setPlanOpen(false);
    return !open;
  });

  return (
    <ViewportOverlay zIndex={10_000} style={{ pointerEvents: "auto" }}>
      <div className="tg-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
        <div ref={dialogRef} className="tg-inspector tg-inspector--fullscreen" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="tg-inspector__header">
          <div className="tg-inspector__identity">
            <span className="tg-inspector__mark" aria-hidden="true"><Workflow aria-hidden="true" /></span>
            <div className="tg-inspector__title">
              <span className="tg-eyebrow">Workstream inspector</span>
              <h2 id={titleId}>{snapshot.title}</h2>
            </div>
          </div>
          <div className="tg-header-actions">
            <button className="tg-view-toggle" aria-label="Toggle plan rail" aria-pressed={planOpen} onClick={togglePlan}>Plan</button>
            <button className="tg-view-toggle" aria-label="Toggle details rail" aria-pressed={detailOpen} onClick={toggleDetail}>Details</button>
            {canPause ? <button className="tg-button" disabled={!controlsEnabled} onClick={() => dispatch({ type: "pause" })}>Pause</button> : snapshot.status === "paused" ? <button className="tg-button" disabled={!controlsEnabled} onClick={() => dispatch({ type: "resume" })}>Resume</button> : null}
            {canCancelRun ? <button className="tg-button tg-button--danger" disabled={!controlsEnabled} onClick={() => dispatch({ type: "cancel_run" })}>Cancel run</button> : null}
            <button className="tg-close" aria-label="Close graph inspector" onClick={onClose}>×</button>
          </div>
        </header>

        <section className="tg-mission-bar" aria-label="Execution goal and run status">
          <div className="tg-mission-copy"><span className="tg-eyebrow">Run objective</span><p>{goal ?? snapshot.title}</p></div>
          <div className="tg-mission-stats">
            <span className={`tg-run-status tg-run-status--${snapshot.status}`}>{snapshot.status}</span>
            <span><b>{summary.succeeded}/{summary.total}</b> complete</span>
            <span><b>{snapshot.capacity.running}/{snapshot.capacity.limit}</b> active slots</span>
            <span>Run revision <b>{snapshot.revision}</b></span>
          </div>
        </section>

        <div className={`tg-workspace${planOpen ? "" : " is-plan-collapsed"}${detailOpen ? "" : " is-detail-collapsed"}`}>
          {narrow && (planOpen || detailOpen) ? <button type="button" className="tg-rail-scrim" aria-label="Close open inspector rail" onClick={() => { setPlanOpen(false); setDetailOpen(false); }} /> : null}
          {planOpen ? <PlanRail snapshot={snapshot} plan={plan} selectedTaskId={focusedPlanTaskId} onSelect={selectPlan} onClose={() => setPlanOpen(false)} /> : (
            <button type="button" className="tg-rail-tab tg-rail-tab--plan" aria-label="Expand plan" onClick={togglePlan}><span>Plan</span><b aria-hidden="true">›</b></button>
          )}

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
            <DetailDrawer key={selected.id} node={selected} controlsEnabled={controlsEnabled} onClose={() => setSelectedId(null)} dispatch={dispatch} />
          ) : selectedEvidence ? (
            <EvidenceDetail evidence={selectedEvidence} snapshot={snapshot} onSelectNode={(id) => selectNode(id, true)} onClose={() => setSelectedEvidenceId(null)} />
          ) : (
            <aside className="tg-detail tg-detail--empty" aria-label="Selection details">
              <span className="tg-empty-state__icon">⌁</span><strong>Choose work to inspect</strong><p>Select a task to review its brief, routed context, and minion responses. Checkpoints show evidence lineage.</p>
            </aside>
          ) : (
            <button type="button" className="tg-rail-tab tg-rail-tab--detail" aria-label="Expand details" onClick={toggleDetail}><b aria-hidden="true">‹</b><span>Details</span></button>
          )}
        </div>
        </div>
      </div>
    </ViewportOverlay>
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
  const [adjudicationReason,setAdjudicationReason]=useState("");
  const [retryGuidance,setRetryGuidance]=useState("");
  const attemptState = node.currentAttempt?.state;
  const canRetry = attemptState === "failed" || attemptState === "cancelled" || attemptState === "backoff" || node.logicalState === "failed" || node.logicalState === "exhausted";
  const canCancel = attemptState === "queued" || attemptState === "running" || attemptState === "blocked";
  const canVerify = node.outputArtifactIds.length > 0 && (node.verification.state === "pending" || node.verification.state === "failed" || node.verification.state === "stale");
  const canAdjudicate=(node.completionMode==="verification" || (node.verification.state==="failed"
    && node.verification.evidenceIds.length>0)) && Boolean(node.currentAttempt)
    && (attemptState==="failed" || attemptState==="backoff") && node.adjudication===null;
  const needsInput = node.blocker?.category === "input";
  return <aside className="tg-detail" aria-labelledby="tg-detail-title">
    <header><div><span className="tg-eyebrow">{node.kind} · {node.id}</span><h3 id="tg-detail-title">{node.title}</h3></div><button className="tg-close" aria-label="Close task details" onClick={onClose}>×</button></header>
    <div className="tg-detail__status-row"><NodeState node={node} /><span>{node.currentAttempt?.executor ?? node.owner ?? "Unassigned"}</span></div>
    <section className="tg-detail__brief" aria-labelledby="tg-brief-heading"><h4 id="tg-brief-heading">Minion brief</h4><p className="tg-detail__objective">{node.objective}</p><BriefList label="Constraints" items={node.constraints} empty="No additional constraints were routed." /><BriefList label="Acceptance criteria" items={node.acceptanceCriteria} empty="No acceptance criteria were declared." /></section>
    <section aria-labelledby="tg-context-heading"><div className="tg-detail__section-heading"><h4 id="tg-context-heading">Routed context</h4><span>{node.context.length} source{node.context.length === 1 ? "" : "s"}</span></div>{node.context.length ? <div className="tg-context-list">{node.context.map((entry) => <article className={`tg-context-card${"withheld" in entry ? " is-withheld" : ""}`} key={`${entry.sourceId}-${entry.contentHash}`}><header><strong>{entry.sourceId}</strong><span>{entry.classification}</span></header>{"withheld" in entry ? <p>Content withheld by its {entry.classification} classification.</p> : <p>{entry.content || "This context source is empty."}</p>}</article>)}</div> : <p className="tg-detail__empty-copy">No routed context was attached to this task.</p>}</section>
    <section aria-labelledby="tg-responses-heading"><div className="tg-detail__section-heading"><h4 id="tg-responses-heading">Attempt responses</h4><span>{node.attemptHistory.length} attempt{node.attemptHistory.length === 1 ? "" : "s"}</span></div>{node.attemptHistory.length ? <div className="tg-response-list">{node.attemptHistory.slice(-30).reverse().map((attempt) => <article className="tg-response-card" key={attempt.id}><header><strong>Attempt {attempt.number}</strong><span className={`tg-attempt-label tg-attempt-label--${attempt.state}`}>{attempt.state}</span></header><div className="tg-response-card__meta">{attempt.executor ?? "Unassigned"} · ${attempt.costUsd.toFixed(2)} · {attempt.tokens.toLocaleString()} tokens</div>{attempt.response ? <p>{attempt.response}</p> : <p className="tg-detail__empty-copy">No response was recorded for this attempt.</p>}</article>)}</div> : <p className="tg-detail__empty-copy">This task has not started an attempt yet.</p>}</section>
    <section><h4>Runtime</h4><p>{node.currentAttempt?.state === "running" ? "Running now" : node.blocker?.explanation ?? (node.readiness === "ready" ? "Ready; waiting for executor capacity" : "Waiting for dependencies")}</p><p>{node.currentAttempt?.sessionId ?? "No active session"} · ${node.budgetReservedUsd?.toFixed(2) ?? "0.00"} reserved · ${node.costUsd.toFixed(2)} spent</p></section>
    {node.adjudication ? <section><h4>Leader resolution</h4><p><strong>{node.adjudication.decision}</strong> by {node.adjudication.actor}</p><p>{node.adjudication.reason}</p>{node.adjudication.guidance ? <p>Guidance: {node.adjudication.guidance}</p> : null}</section> : null}
    <section><h4>Inputs &amp; outputs</h4><div className="tg-detail-chips">{node.inputIds.map((id) => <span key={`input-${id}`}>{id}</span>)}{node.outputArtifactIds.map((id) => <span key={`output-${id}`}>{id}</span>)}{!node.inputIds.length && !node.outputArtifactIds.length ? <em>None projected</em> : null}</div></section>
    <div className="tg-detail__controls">
      {canRetry ? <button disabled={!controlsEnabled} onClick={() => dispatch({ type: "retry" }, node)}>Retry</button> : null}
      {canCancel ? <button disabled={!controlsEnabled} onClick={() => dispatch({ type: "cancel_attempt" }, node)}>Cancel attempt</button> : null}
      {canVerify ? <button disabled={!controlsEnabled} onClick={() => dispatch({ type: "request_verification" }, node)}>Verify</button> : null}
      {canVerify ? <><label>Waiver reason<textarea disabled={!controlsEnabled} value={waiverReason} onChange={(event) => setWaiverReason(event.target.value)} /></label><button disabled={!controlsEnabled || !waiverReason.trim()} onClick={() => { dispatch({ type: "waive_verification", reason: waiverReason.trim() }, node); setWaiverReason(""); }}>Waive verification</button></> : null}
      {canAdjudicate ? <>
        <label>Adjudication reason<textarea disabled={!controlsEnabled} value={adjudicationReason} onChange={(event)=>setAdjudicationReason(event.target.value)} /></label>
        <label>Retry guidance<textarea disabled={!controlsEnabled} value={retryGuidance} onChange={(event)=>setRetryGuidance(event.target.value)} /></label>
        <button disabled={!controlsEnabled || !adjudicationReason.trim()} onClick={()=>dispatch({type:"adjudicate",decision:"accepted",reason:adjudicationReason.trim()},node)}>Accept with reason</button>
        <button disabled={!controlsEnabled || !adjudicationReason.trim()} onClick={()=>dispatch({type:"adjudicate",decision:"rejected",reason:adjudicationReason.trim()},node)}>Reject verification</button>
        <button disabled={!controlsEnabled || !adjudicationReason.trim()} onClick={()=>dispatch({type:"adjudicate",decision:"retry",reason:adjudicationReason.trim(),...(retryGuidance.trim()?{guidance:retryGuidance.trim()}:{})},node)}>Retry with guidance</button>
      </> : null}
      {needsInput ? <><label>Provide input<textarea disabled={!controlsEnabled} value={input} onChange={(event) => setInput(event.target.value)} /></label><button disabled={!controlsEnabled || !input.trim()} onClick={() => { dispatch({ type: "provide_input", input: input.trim() }, node); setInput(""); }}>Send input</button></> : null}
    </div>
  </aside>;
}

function BriefList({ label, items, empty }: { label: string; items: readonly string[]; empty: string }) {
  return <div className="tg-brief-list"><strong>{label}</strong>{items.length ? <ul>{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : <p className="tg-detail__empty-copy">{empty}</p>}</div>;
}
