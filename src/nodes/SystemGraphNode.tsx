import { useEffect, useMemo, useState } from "react";
import { sessionTopic } from "../../shared/ws-envelope.ts";
import type { SystemGraph, SystemGraphEdge } from "../../shared/system-model/graph.ts";
import { registerNodeType } from "../node-registry.ts";
import { ResizeHandle } from "../components/ResizeHandle.tsx";
import type { NodeRenderProps } from "../types.ts";
import { subscribeSocketTopic } from "../use-socket.ts";
import type { ServerMessage } from "../use-socket.ts";
import {
  ALL_RELATIONS,
  activePacketsFor,
  capabilityLanesForSurface,
  bridgeReasonsFor,
  cardBadge,
  connectedNodes,
  CROSS_CUTTING_DOMAIN,
  domainGroups,
  entryPointDetailsFor,
  LENSES,
  lastUsedLabel,
  PRIMARY_TYPES,
  RELATIONS,
  relatedCount,
  relatedGroups,
  surfaceLanesForCapability,
  scopeAppliedConstraints,
  usageLabel,
  type GraphNode,
  type LensId,
  type PrimaryType,
  type RelationType,
} from "./system-graph-model.ts";
import "../system-graph.css";

type LoadState = "idle" | "loading" | "loaded" | "error";

interface GraphResponse {
  graph?: { nodes?: GraphNode[]; edges?: SystemGraphEdge[] };
  loadErrors?: string[];
}

interface SystemGraphNodeData {
  sessionKey?: string | null;
}

const REQUEST_PREFIX = "system-graph";

function asData(data: unknown): SystemGraphNodeData {
  return data && typeof data === "object" ? (data as SystemGraphNodeData) : {};
}

function requestId(nodeId: string): string {
  return `${REQUEST_PREFIX}-${nodeId}-${Date.now().toString(36)}`;
}

function graphFromResponse(msg: ServerMessage): GraphResponse | null {
  if (msg.type !== "control_response" || msg.command !== "get_system_graph") {
    return null;
  }
  return msg as ServerMessage & GraphResponse;
}

function Card({
  node,
  selected,
  dim,
  onSelect,
  count,
  relation,
  reason,
}: {
  node: GraphNode;
  selected?: boolean;
  dim?: boolean;
  onSelect: (id: string) => void;
  count?: number;
  relation?: RelationType;
  reason?: string;
}) {
  const badge = cardBadge(node);
  const classes = [
    "sg-card",
    `sg-card-${node.type}`,
    selected ? "sg-card-selected" : "",
    dim ? "sg-card-dim" : "",
    relation ? `sg-card-relation-${relation}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={classes}
      aria-pressed={selected}
      aria-label={`Inspect ${node.label}`}
      title={node.summary ?? node.label}
      onClick={() => onSelect(node.id)}
    >
      <span className="sg-card-rail" aria-hidden="true" />
      <span className="sg-card-head">
        <span className="sg-card-type">{node.type}</span>
        {node.risk && <span className={`sg-card-risk sg-risk-${node.risk}`} aria-hidden="true" />}
      </span>
      <span className="sg-card-name">{node.label}</span>
      <span className="sg-card-meta">
        {badge ?? node.freshness}
        {typeof count === "number" && count > 0 ? ` · ${count} related` : ""}
      </span>
      {reason && <span className="sg-card-reason">{reason}</span>}
    </button>
  );
}

function PathRows({ paths, empty }: { paths: string[]; empty: string }) {
  if (paths.length === 0) return <p className="sg-empty-detail">{empty}</p>;
  return (
    <div className="sg-paths">
      {paths.map((path) => (
        <button
          key={path}
          type="button"
          className="sg-path"
          title={`Copy ${path}`}
          aria-label={`Copy ${path}`}
          onClick={() => void navigator.clipboard?.writeText(path)}
        >
          <code>{path}</code>
          <span aria-hidden="true">copy</span>
        </button>
      ))}
    </div>
  );
}

function SignalBadges({ node }: { node: GraphNode }) {
  return (
    <span className="sg-signals" aria-label={`${node.freshness} freshness${node.risk ? `, ${node.risk} risk` : ""}`}>
      <span className={`sg-signal sg-freshness-${node.freshness}`}>{node.freshness}</span>
      {node.risk && <span className={`sg-signal sg-signal-risk sg-risk-bg-${node.risk}`}>{node.risk} risk</span>}
    </span>
  );
}

function EntryPointDrillDown({
  graph,
  selected,
  primary,
}: {
  graph: SystemGraph;
  selected: GraphNode;
  primary: PrimaryType;
}) {
  if (primary === "capability") {
    const lanes = surfaceLanesForCapability(selected.id, graph);
    return (
      <section className="sg-lanes" aria-label="Surface lanes">
        <div className="sg-row-label">Surface lanes <span className="sg-row-count">{lanes.length}</span></div>
        {lanes.length === 0 ? (
          <div className="sg-related-hint">{selected.label} has no mapped surface entry points.</div>
        ) : (
          <div className="sg-lane-grid">
            {lanes.map((lane) => (
              <article className="sg-lane" key={lane.edge.id}>
                <div className="sg-lane-head">
                  <div><span className="sg-lane-kicker">Surface</span><h3>{lane.surface.label}</h3></div>
                  <SignalBadges node={lane.surface} />
                </div>
                {lane.edge.summary && <p className="sg-lane-summary">{lane.edge.summary}</p>}
                <h4>Entry-point files</h4>
                <PathRows paths={lane.files} empty="No entry-point files mapped." />
                <h4>Tests</h4>
                <PathRows paths={lane.tests} empty="No entry-point tests mapped." />
              </article>
            ))}
          </div>
        )}
      </section>
    );
  }

  if (primary === "surface") {
    const lanes = capabilityLanesForSurface(selected.id, graph);
    return (
      <section className="sg-lanes" aria-label="Surface capability entry points">
        <div className="sg-surface-files">
          <div className="sg-row-label">Surface suggested files</div>
          <PathRows paths={selected.suggestedFiles ?? []} empty="No surface-level suggested files provided." />
        </div>
        <div className="sg-row-label">Capabilities entering here <span className="sg-row-count">{lanes.length}</span></div>
        {lanes.length === 0 ? (
          <div className="sg-related-hint">No capabilities have an entry point on {selected.label}.</div>
        ) : (
          <div className="sg-lane-grid">
            {lanes.map((lane) => (
              <article className="sg-lane" key={lane.edge.id}>
                <div className="sg-lane-head">
                  <div><span className="sg-lane-kicker">Capability</span><h3>{lane.capability.label}</h3></div>
                  <SignalBadges node={lane.capability} />
                </div>
                {lane.edge.summary && <p className="sg-lane-summary">{lane.edge.summary}</p>}
                <h4>Entry-point files</h4>
                <PathRows paths={lane.files} empty="No entry-point files mapped." />
                <h4>Tests</h4>
                <PathRows paths={lane.tests} empty="No entry-point tests mapped." />
              </article>
            ))}
          </div>
        )}
      </section>
    );
  }

  return null;
}

function TextList({ items, empty }: { items: string[]; empty: string }) {
  return items.length > 0
    ? <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
    : <p className="sg-empty-detail">{empty}</p>;
}

function ScopeConstraintBadges({ graph, selectedId }: { graph: SystemGraph; selectedId: string | null }) {
  const constraints = scopeAppliedConstraints(selectedId, graph);
  if (constraints.length === 0) return null;
  return (
    <section className="sg-scope-panel" aria-label="Constraints that apply by scope">
      <div className="sg-row-label">Applies by scope <span className="sg-row-count">{constraints.length}</span></div>
      <div className="sg-scope-badges">
        {constraints.map(({ node, scope }) => (
          <span className="sg-scope-badge" key={node.id}>
            <span>{scope}</span> {node.label}
          </span>
        ))}
      </div>
    </section>
  );
}

function Inspector({ graph, selectedId }: { graph: SystemGraph; selectedId: string | null }) {
  const node = (graph.nodes as GraphNode[]).find((n) => n.id === selectedId) ?? null;
  if (!node) {
    return (
      <aside className="sg-inspector" aria-label="Object inspector">
        <div className="sg-panel-title">Inspector</div>
        <p className="sg-muted">Select a card to inspect its attributes and relationships.</p>
      </aside>
    );
  }

  const gates = [...new Set([
    ...(node.gates ?? []),
    ...(node.reviewGate ? [node.reviewGate] : []),
    ...connectedNodes(node, graph, "constraint")
      .map((n) => n.reviewGate)
      .filter((gate): gate is string => !!gate),
  ])];
  const packets = activePacketsFor(node);
  const usage = usageLabel(node);
  const lastUsed = lastUsedLabel(node);
  const entryPoints = entryPointDetailsFor(node.id, graph);
  const scopedConstraints = scopeAppliedConstraints(node.id, graph);
  const bridges = bridgeReasonsFor(node.id, graph);
  const files = [...new Set([...(node.suggestedFiles ?? []), ...entryPoints.files])];
  const tests = [...new Set([...(node.suggestedTests ?? []), ...entryPoints.tests])];
  const flows = connectedNodes(node, graph, "flow").map((item) => item.label);
  const constraints = [...new Set([
    ...connectedNodes(node, graph, "constraint").map((item) => item.label),
    ...scopedConstraints.map((item) => `${item.node.label} (${item.scope} scope)`),
  ])];

  return (
    <aside className="sg-inspector" aria-label="Object inspector">
      <div className="sg-panel-title">Inspector</div>
      <h3>{node.label}</h3>
      <p className="sg-muted">{node.summary ?? "This model object scopes agent planning and review."}</p>
      <dl className="sg-facts">
        <div><dt>Type</dt><dd>{node.type}</dd></div>
        <div><dt>Risk</dt><dd>{node.risk ?? "not rated"}</dd></div>
        <div><dt>Freshness</dt><dd>{node.freshness}</dd></div>
        <div><dt>Domain</dt><dd>{node.domain ?? "Cross-cutting"}</dd></div>
        {usage && <div><dt>Usage</dt><dd>{usage}</dd></div>}
        {lastUsed && <div><dt>Last used</dt><dd>{lastUsed}</dd></div>}
      </dl>
      <section><h4>Gates</h4><TextList items={gates} empty="No gates." /></section>
      <section><h4>Active Packets</h4><TextList items={packets} empty="No active packets." /></section>
      <section><h4>Entry-point files</h4><PathRows paths={files} empty="No files mapped." /></section>
      <section><h4>Entry-point tests</h4><PathRows paths={tests} empty="No tests mapped." /></section>
      <section><h4>Related flows</h4><TextList items={flows} empty="No related flows." /></section>
      <section><h4>Related constraints</h4><TextList items={constraints} empty="No related constraints." /></section>
      <section><h4>Bridge reasons</h4><TextList items={bridges} empty="No cross-domain bridges." /></section>
    </aside>
  );
}

export function SystemGraphNodeRenderer({
  node,
  onUpdateData,
  onResize,
  onResizeStart,
  onResizeEnd,
  socketSend,
  socketSubscribe,
}: NodeRenderProps) {
  const data = asData(node.data);
  const [sessionKeyDraft, setSessionKeyDraft] = useState(data.sessionKey ?? "");
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const [graph, setGraph] = useState<SystemGraph>({ nodes: [], edges: [] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [primary, setPrimary] = useState<PrimaryType>("capability");
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [lens, setLens] = useState<LensId>("structure");
  const [relationEnabled, setRelationEnabled] = useState<Set<RelationType>>(
    () => new Set(ALL_RELATIONS),
  );

  useEffect(() => {
    setSessionKeyDraft(data.sessionKey ?? "");
  }, [data.sessionKey]);

  useEffect(() => {
    if (!socketSend || !socketSubscribe || !data.sessionKey) return;
    const id = requestId(node.id);
    setLoadState("loading");
    setError(null);
    setLoadErrors([]);
    const unsubscribe = subscribeSocketTopic(
      socketSubscribe,
      sessionTopic(data.sessionKey),
      (msg: unknown) => {
        const response = graphFromResponse(msg as ServerMessage);
        if (!response) return;
        const control = msg as Extract<ServerMessage, { type: "control_response" }>;
        if (control.sessionKey !== data.sessionKey || control.requestId !== id) return;
        if (!control.success) {
          setError(control.error ?? "System graph unavailable.");
          setLoadState("error");
          return;
        }
        const nextGraph = {
          nodes: response.graph?.nodes ?? [],
          edges: response.graph?.edges ?? [],
        };
        setGraph(nextGraph);
        setSelectedId((current) =>
          current && nextGraph.nodes.some((graphNode) => graphNode.id === current)
            ? current
            : null,
        );
        setLoadErrors(response.loadErrors ?? []);
        setLoadState("loaded");
      },
    );
    socketSend({ type: "get_system_graph", sessionKey: data.sessionKey, requestId: id });
    return unsubscribe;
  }, [socketSend, socketSubscribe, data.sessionKey, node.id]);

  const domains = useMemo(() => domainGroups(graph, lens), [graph, lens]);
  const visibleDomains = useMemo(
    () => selectedDomain ? domains.filter((group) => group.id === selectedDomain) : domains,
    [domains, selectedDomain],
  );
  const row = useMemo(
    () => visibleDomains.flatMap((group) => group.nodes.filter((item) => item.type === primary)),
    [visibleDomains, primary],
  );
  const selectedNode = useMemo(
    () => (graph.nodes as GraphNode[]).find((n) => n.id === selectedId) ?? null,
    [graph, selectedId],
  );
  const groups = useMemo(
    () => (selectedNode ? relatedGroups(selectedId, graph, relationEnabled) : []),
    [selectedNode, selectedId, graph, relationEnabled],
  );
  const selectedIsPrimary = selectedNode?.type === primary;
  const showsEntryPointDrillDown =
    selectedIsPrimary &&
    relationEnabled.has("entry_point") &&
    (primary === "capability" || primary === "surface");

  const changePrimary = (next: PrimaryType) => {
    setPrimary(next);
    setSelectedId((current) => {
      const stillPrimary = (graph.nodes as GraphNode[]).some(
        (n) => n.id === current && n.type === next,
      );
      return stillPrimary ? current : null;
    });
  };

  const changeDomain = (next: string | null) => {
    setSelectedDomain(next);
    setSelectedId((current) => {
      if (!current || !next) return current;
      const currentNode = (graph.nodes as GraphNode[]).find((item) => item.id === current);
      const currentDomain = currentNode?.domain ?? CROSS_CUTTING_DOMAIN;
      return currentDomain === next ? current : null;
    });
  };

  const toggleRelation = (relation: RelationType) => {
    setRelationEnabled((current) => {
      const nextSet = new Set(current);
      if (nextSet.has(relation)) nextSet.delete(relation);
      else nextSet.add(relation);
      return nextSet;
    });
  };

  const saveSessionKey = () => {
    const next = sessionKeyDraft.trim();
    onUpdateData({ ...data, sessionKey: next || null });
  };

  return (
    <div className="sg-node">
      {onResize && (
        <ResizeHandle
          currentSize={node.size}
          minWidth={520}
          minHeight={360}
          onResize={onResize}
          {...(onResizeStart ? { onResizeStart } : {})}
          {...(onResizeEnd ? { onResizeEnd } : {})}
          color="var(--accent)"
        />
      )}
      <header className="sg-header">
        <div>
          <div className="sg-title">System Model</div>
          <div className="sg-subtitle">
            {data.sessionKey ? `Session ${data.sessionKey}` : "No session selected"}
          </div>
        </div>
        <div className="sg-session-form">
          <input
            aria-label="Leader session key"
            value={sessionKeyDraft}
            onChange={(event) => setSessionKeyDraft(event.target.value)}
            onMouseDown={(event) => event.stopPropagation()}
            placeholder="leader session key"
          />
          <button type="button" onClick={saveSessionKey}>Load</button>
        </div>
      </header>

      <div className="sg-toolbar">
        <div className="sg-segment" role="group" aria-label="Primary row">
          {PRIMARY_TYPES.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={primary === option.id}
              onClick={() => changePrimary(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="sg-segment sg-segment-muted" role="group" aria-label="Lens filter">
          {LENSES.map((meta) => (
            <button
              key={meta.id}
              type="button"
              title={meta.description}
              aria-pressed={lens === meta.id}
              onClick={() => setLens(meta.id)}
            >
              {meta.label}
            </button>
          ))}
        </div>
      </div>

      {!data.sessionKey && (
        <div className="sg-state">Enter a leader session key to load the system model graph.</div>
      )}
      {data.sessionKey && loadState === "loading" && <div className="sg-state">Loading system model…</div>}
      {loadState === "error" && <div className="sg-state sg-state-error">{error}</div>}
      {loadState === "loaded" && graph.nodes.length === 0 && (
        <div className="sg-state">System model is off or empty for this session.</div>
      )}
      {loadState === "loaded" && graph.nodes.length > 0 && (
        <>
          {loadErrors.length > 0 && <div className="sg-warning">{loadErrors.join("; ")}</div>}
          <main className="sg-content">
            <div className="sg-board">
              <section className="sg-primary" aria-label={`${primary} row`}>
                <nav className="sg-domain-nav" aria-label="Domains">
                  <button
                    type="button"
                    aria-pressed={selectedDomain === null}
                    onClick={() => changeDomain(null)}
                  >
                    <span>All domains</span><small>{domains.reduce((total, group) => total + group.nodes.length, 0)}</small>
                  </button>
                  {domains.map((domain) => (
                    <button
                      type="button"
                      key={domain.id}
                      aria-pressed={selectedDomain === domain.id}
                      aria-label={`Browse ${domain.label}`}
                      onClick={() => changeDomain(domain.id)}
                    >
                      <span>{domain.label}</span><small>{domain.nodes.length}</small>
                    </button>
                  ))}
                </nav>
                <div className="sg-row-label">
                  {PRIMARY_TYPES.find((p) => p.id === primary)?.label}
                  <span className="sg-row-count">{row.length}</span>
                </div>
                {row.length > 0 ? (
                  <div className="sg-domain-groups">
                    {visibleDomains.map((domain) => {
                      const members = domain.nodes.filter((item) => item.type === primary);
                      if (members.length === 0) return null;
                      return (
                        <section className="sg-domain-group" key={domain.id} aria-label={`${domain.label} ${primary}`}>
                          <div className="sg-domain-heading"><span>{domain.label}</span><small>{members.length}</small></div>
                          <div className="sg-primary-row">
                            {members.map((item) => (
                              <Card
                                key={item.id}
                                node={item}
                                selected={selectedId === item.id}
                                onSelect={setSelectedId}
                                count={relatedCount(item.id, graph, relationEnabled)}
                              />
                            ))}
                          </div>
                        </section>
                      );
                    })}
                  </div>
                ) : (
                  <div className="sg-state">No {primary} objects match the current lens.</div>
                )}
              </section>

              <section className="sg-related" aria-label="Related objects">
                {!selectedIsPrimary ? (
                  <div className="sg-related-hint">
                    Select a {primary} above to reveal only the objects it relates to.
                  </div>
                ) : (
                  <>
                    <div className="sg-legend" role="group" aria-label="Relationship filter">
                      {RELATIONS.map((relation) => (
                        <button
                          key={relation.id}
                          type="button"
                          className={`sg-legend-item${relationEnabled.has(relation.id) ? "" : " sg-legend-item-off"}`}
                          title={relation.description}
                          aria-pressed={relationEnabled.has(relation.id)}
                          aria-label={`${relation.label} relationships`}
                          onClick={() => toggleRelation(relation.id)}
                        >
                          <span className={`sg-legend-swatch sg-swatch-${relation.id}`} aria-hidden="true" />
                          {relation.label}
                        </button>
                      ))}
                    </div>
                    <ScopeConstraintBadges graph={graph} selectedId={selectedId} />
                    {showsEntryPointDrillDown && selectedNode && (
                      <EntryPointDrillDown graph={graph} selected={selectedNode} primary={primary} />
                    )}
                    {groups.length > 0 ? (
                      <div className="sg-groups">
                        {groups.map((group) => (
                          <div key={group.relation} className={`sg-group sg-group-${group.relation}`}>
                            <div className="sg-group-head">
                              <span className={`sg-group-dot sg-swatch-${group.relation}`} aria-hidden="true" />
                              {group.meta.label}
                              <span className="sg-row-count">{group.nodes.length}</span>
                            </div>
                            <div className="sg-group-cards">
                              {group.items.map(({ node: related, summaries }) => (
                                <Card
                                  key={related.id}
                                  node={related}
                                  selected={selectedId === related.id}
                                  onSelect={setSelectedId}
                                  relation={group.relation}
                                  {...(group.relation === "bridge" && summaries.length > 0
                                    ? { reason: summaries.join("; ") }
                                    : {})}
                                />
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="sg-related-hint">
                        {selectedNode?.label} has no related objects in the enabled relationships.
                      </div>
                    )}
                  </>
                )}
              </section>
            </div>
            <Inspector graph={graph} selectedId={selectedId} />
          </main>
        </>
      )}
    </div>
  );
}

registerNodeType({
  type: "system-graph",
  label: "System Model",
  defaultSize: { width: 720, height: 540 },
  render: SystemGraphNodeRenderer,
  userCreatable: false,
});
