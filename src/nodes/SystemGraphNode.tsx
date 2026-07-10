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
  cardBadge,
  connectedNodes,
  LENSES,
  lastUsedLabel,
  PRIMARY_TYPES,
  primaryNodes,
  RELATIONS,
  relatedCount,
  relatedGroups,
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
}: {
  node: GraphNode;
  selected?: boolean;
  dim?: boolean;
  onSelect: (id: string) => void;
  count?: number;
}) {
  const badge = cardBadge(node);
  const classes = [
    "sg-card",
    `sg-card-${node.type}`,
    selected ? "sg-card-selected" : "",
    dim ? "sg-card-dim" : "",
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
    </button>
  );
}

function Inspector({ graph, selectedId }: { graph: SystemGraph; selectedId: string | null }) {
  const node = (graph.nodes as GraphNode[]).find((n) => n.id === selectedId) ?? null;
  if (!node) {
    return (
      <aside className="sg-inspector">
        <div className="sg-panel-title">Inspector</div>
        <p className="sg-muted">Select a card to inspect its attributes and relationships.</p>
      </aside>
    );
  }

  const gates = [
    ...(node.gates ?? []),
    ...(node.reviewGate ? [node.reviewGate] : []),
    ...connectedNodes(node, graph, "constraint")
      .map((n) => n.reviewGate)
      .filter((gate): gate is string => !!gate),
  ];
  const packets = activePacketsFor(node);
  const usage = usageLabel(node);
  const lastUsed = lastUsedLabel(node);

  return (
    <aside className="sg-inspector">
      <div className="sg-panel-title">Inspector</div>
      <h3>{node.label}</h3>
      <p className="sg-muted">{node.summary ?? "This model object scopes agent planning and review."}</p>
      <dl className="sg-facts">
        <div><dt>Type</dt><dd>{node.type}</dd></div>
        {node.risk && <div><dt>Risk</dt><dd>{node.risk}</dd></div>}
        <div><dt>Freshness</dt><dd>{node.freshness}</dd></div>
        {usage && <div><dt>Usage</dt><dd>{usage}</dd></div>}
        {lastUsed && <div><dt>Last used</dt><dd>{lastUsed}</dd></div>}
      </dl>
      {gates.length > 0 && (
        <section>
          <h4>Gates</h4>
          <ul>{gates.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
      )}
      {packets.length > 0 && (
        <section>
          <h4>Active Packets</h4>
          <ul>{packets.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
      )}
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

  const row = useMemo(() => primaryNodes(graph, primary, lens), [graph, primary, lens]);
  const selectedNode = useMemo(
    () => (graph.nodes as GraphNode[]).find((n) => n.id === selectedId) ?? null,
    [graph, selectedId],
  );
  const groups = useMemo(
    () => (selectedNode ? relatedGroups(selectedId, graph, relationEnabled) : []),
    [selectedNode, selectedId, graph, relationEnabled],
  );

  const changePrimary = (next: PrimaryType) => {
    setPrimary(next);
    setSelectedId((current) => {
      const stillPrimary = (graph.nodes as GraphNode[]).some(
        (n) => n.id === current && n.type === next,
      );
      return stillPrimary ? current : null;
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

  const selectedIsPrimary = selectedNode?.type === primary;

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
                <div className="sg-row-label">
                  {PRIMARY_TYPES.find((p) => p.id === primary)?.label}
                  <span className="sg-row-count">{row.length}</span>
                </div>
                {row.length > 0 ? (
                  <div className="sg-primary-row">
                    {row.map((item) => (
                      <Card
                        key={item.id}
                        node={item}
                        selected={selectedId === item.id}
                        onSelect={setSelectedId}
                        count={relatedCount(item.id, graph, relationEnabled)}
                      />
                    ))}
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
                              {group.nodes.map((related) => (
                                <Card
                                  key={related.id}
                                  node={related}
                                  selected={selectedId === related.id}
                                  onSelect={setSelectedId}
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
