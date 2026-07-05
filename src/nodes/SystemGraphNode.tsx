import { useEffect, useMemo, useState } from "react";
import { sessionTopic } from "../../shared/ws-envelope.ts";
import type {
  SystemGraph,
  SystemGraphEdge,
  SystemGraphNode as BaseSystemGraphNode,
} from "../../shared/system-model/graph.ts";
import { registerNodeType } from "../node-registry.ts";
import type { NodeRenderProps } from "../types.ts";
import { subscribeSocketTopic } from "../use-socket.ts";
import type { ServerMessage } from "../use-socket.ts";
import "../system-graph.css";

type RiskFilter = "all" | "elevated";
type FreshnessFilter = "all" | "attention";
type PacketFilter = "all" | "active";
type LoadState = "idle" | "loading" | "loaded" | "error";

type GraphNode = BaseSystemGraphNode & {
  constraints?: string[];
  gates?: string[];
  reviewGate?: string;
  activePackets?: string[];
  activeWorkPackets?: string[];
  packets?: string[];
};

interface GraphResponse {
  graph?: { nodes?: GraphNode[]; edges?: SystemGraphEdge[] };
  loadErrors?: string[];
}

interface SystemGraphNodeData {
  sessionKey?: string | null;
}

interface PositionedNode {
  node: GraphNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

const REQUEST_PREFIX = "system-graph";
const HIGH_RISK = new Set(["high", "critical"]);
const COLUMN_X: Record<string, number> = {
  capability: 42,
  flow: 236,
  support: 430,
};

function asData(data: unknown): SystemGraphNodeData {
  return data && typeof data === "object" ? (data as SystemGraphNodeData) : {};
}

function requestId(nodeId: string): string {
  return `${REQUEST_PREFIX}-${nodeId}-${Date.now().toString(36)}`;
}

function activePacketsFor(node: GraphNode): string[] {
  return [
    ...(node.activePackets ?? []),
    ...(node.activeWorkPackets ?? []),
    ...(node.packets ?? []),
  ].filter(Boolean);
}

function isElevatedRisk(node: GraphNode): boolean {
  return !!node.risk && HIGH_RISK.has(node.risk);
}

function needsFreshnessAttention(node: GraphNode): boolean {
  return node.freshness !== "fresh";
}

function nodeColumn(type: GraphNode["type"]): string {
  if (type === "capability") return "capability";
  if (type === "flow") return "flow";
  return "support";
}

function graphFromResponse(msg: ServerMessage): GraphResponse | null {
  if (msg.type !== "control_response" || msg.command !== "get_system_graph") {
    return null;
  }
  return msg as ServerMessage & GraphResponse;
}

function filterGraph(
  graph: SystemGraph,
  riskFilter: RiskFilter,
  freshnessFilter: FreshnessFilter,
  packetFilter: PacketFilter,
): SystemGraph {
  const nodes = (graph.nodes as GraphNode[]).filter((node) => {
    if (riskFilter === "elevated" && !isElevatedRisk(node)) return false;
    if (freshnessFilter === "attention" && !needsFreshnessAttention(node)) return false;
    if (packetFilter === "active" && activePacketsFor(node).length === 0) return false;
    return true;
  });
  const visibleIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter(
    (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
  );
  return { nodes, edges };
}

function layoutNodes(nodes: GraphNode[]): PositionedNode[] {
  const grouped = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const column = nodeColumn(node.type);
    grouped.set(column, [...(grouped.get(column) ?? []), node]);
  }
  return ["capability", "flow", "support"].flatMap((column) =>
    (grouped.get(column) ?? []).map((node, index) => ({
      node,
      x: COLUMN_X[column] ?? COLUMN_X["support"]!,
      y: 42 + index * 74,
      width: 148,
      height: 48,
    })),
  );
}

function connectedNodes(
  node: GraphNode,
  graph: SystemGraph,
  type?: GraphNode["type"],
): GraphNode[] {
  const nodes = new Map((graph.nodes as GraphNode[]).map((n) => [n.id, n]));
  const ids = graph.edges
    .filter((edge) => edge.source === node.id || edge.target === node.id)
    .map((edge) => (edge.source === node.id ? edge.target : edge.source));
  return ids
    .map((id) => nodes.get(id))
    .filter((n): n is GraphNode => !!n && (!type || n.type === type));
}

function SvgGraph({
  graph,
  selectedId,
  onSelect,
}: {
  graph: SystemGraph;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const positioned = layoutNodes(graph.nodes as GraphNode[]);
  const byId = new Map(positioned.map((entry) => [entry.node.id, entry]));

  return (
    <svg className="sg-svg" viewBox="0 0 620 360" role="img" aria-label="System model graph">
      <text x="42" y="22" className="sg-column-label">Capability</text>
      <text x="236" y="22" className="sg-column-label">Flow</text>
      <text x="430" y="22" className="sg-column-label">Model Area</text>
      {graph.edges.map((edge) => {
        const source = byId.get(edge.source);
        const target = byId.get(edge.target);
        if (!source || !target) return null;
        const x1 = source.x + source.width;
        const y1 = source.y + source.height / 2;
        const x2 = target.x;
        const y2 = target.y + target.height / 2;
        const mid = (x1 + x2) / 2;
        return (
          <path
            key={edge.id}
            className={`sg-edge sg-edge-${edge.relation}`}
            d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
          />
        );
      })}
      {positioned.map(({ node, x, y, width, height }) => {
        const selected = selectedId === node.id;
        return (
          <g
            key={node.id}
            role="button"
            tabIndex={0}
            aria-label={`Inspect ${node.label}`}
            className={`sg-graph-node ${selected ? "sg-graph-node-selected" : ""}`}
            onClick={() => onSelect(node.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") onSelect(node.id);
            }}
          >
            <rect x={x} y={y} width={width} height={height} rx="6" />
            <text x={x + 10} y={y + 18} className="sg-node-type">
              {node.type}
            </text>
            <text x={x + 10} y={y + 36} className="sg-node-label">
              {node.label.slice(0, 22)}
            </text>
            {node.risk && <circle cx={x + width - 14} cy={y + 14} r="5" className={`sg-risk-dot sg-risk-${node.risk}`} />}
          </g>
        );
      })}
    </svg>
  );
}

function Inspector({ graph, selectedId }: { graph: SystemGraph; selectedId: string | null }) {
  const node = (graph.nodes as GraphNode[]).find((n) => n.id === selectedId) ?? null;
  if (!node) {
    return (
      <aside className="sg-inspector">
        <div className="sg-panel-title">Inspector</div>
        <p className="sg-muted">Select a graph node to inspect execution impact.</p>
      </aside>
    );
  }

  const constraints = [
    ...(node.constraints ?? []),
    ...connectedNodes(node, graph, "constraint").map((n) => n.label),
  ];
  const gates = [
    ...(node.gates ?? []),
    ...(node.reviewGate ? [node.reviewGate] : []),
    ...connectedNodes(node, graph, "constraint")
      .map((n) => n.reviewGate)
      .filter((gate): gate is string => !!gate),
  ];
  const packets = activePacketsFor(node);
  const related = connectedNodes(node, graph).filter((n) => n.type !== "constraint");

  return (
    <aside className="sg-inspector">
      <div className="sg-panel-title">Inspector</div>
      <h3>{node.label}</h3>
      <p className="sg-muted">{node.summary ?? "This model object scopes agent planning and review."}</p>
      <dl className="sg-facts">
        <div><dt>Type</dt><dd>{node.type}</dd></div>
        {node.risk && <div><dt>Risk</dt><dd>{node.risk}</dd></div>}
        <div><dt>Freshness</dt><dd>{node.freshness}</dd></div>
      </dl>
      {constraints.length > 0 && (
        <section>
          <h4>Constraints</h4>
          <ul>{constraints.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
      )}
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
      {related.length > 0 && (
        <section>
          <h4>Touches</h4>
          <ul>{related.slice(0, 5).map((item) => <li key={item.id}>{item.label}</li>)}</ul>
        </section>
      )}
    </aside>
  );
}

export function SystemGraphNodeRenderer({
  node,
  onUpdateData,
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
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("all");
  const [freshnessFilter, setFreshnessFilter] = useState<FreshnessFilter>("all");
  const [packetFilter, setPacketFilter] = useState<PacketFilter>("all");

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
            : (nextGraph.nodes[0]?.id ?? null),
        );
        setLoadErrors(response.loadErrors ?? []);
        setLoadState("loaded");
      },
    );
    socketSend({ type: "get_system_graph", sessionKey: data.sessionKey, requestId: id });
    return unsubscribe;
  }, [socketSend, socketSubscribe, data.sessionKey, node.id]);

  const visibleGraph = useMemo(
    () => filterGraph(graph, riskFilter, freshnessFilter, packetFilter),
    [graph, riskFilter, freshnessFilter, packetFilter],
  );

  useEffect(() => {
    if (selectedId && !visibleGraph.nodes.some((graphNode) => graphNode.id === selectedId)) {
      setSelectedId(visibleGraph.nodes[0]?.id ?? null);
    }
  }, [selectedId, visibleGraph]);

  const saveSessionKey = () => {
    const next = sessionKeyDraft.trim();
    onUpdateData({ ...data, sessionKey: next || null });
  };

  return (
    <div className="sg-node">
      <header className="sg-header">
        <div>
          <div className="sg-title">System Model</div>
          <div className="sg-subtitle">{data.sessionKey ? `Session ${data.sessionKey}` : "No session selected"}</div>
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
      <div className="sg-filters" aria-label="System graph filters">
        <button
          type="button"
          aria-pressed={riskFilter === "elevated"}
          onClick={() => setRiskFilter((current) => (current === "all" ? "elevated" : "all"))}
        >
          Risk
        </button>
        <button
          type="button"
          aria-pressed={freshnessFilter === "attention"}
          onClick={() => setFreshnessFilter((current) => (current === "all" ? "attention" : "all"))}
        >
          Freshness
        </button>
        <button
          type="button"
          aria-pressed={packetFilter === "active"}
          onClick={() => setPacketFilter((current) => (current === "all" ? "active" : "all"))}
        >
          Active Packet
        </button>
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
          {loadErrors.length > 0 && (
            <div className="sg-warning">{loadErrors.join("; ")}</div>
          )}
          <main className="sg-content">
            <div className="sg-graph-wrap">
              {visibleGraph.nodes.length > 0 ? (
                <SvgGraph graph={visibleGraph} selectedId={selectedId} onSelect={setSelectedId} />
              ) : (
                <div className="sg-state">No graph nodes match the active filters.</div>
              )}
            </div>
            <Inspector graph={visibleGraph} selectedId={selectedId} />
          </main>
        </>
      )}
    </div>
  );
}

registerNodeType({
  type: "system-graph",
  label: "System Model",
  defaultSize: { width: 640, height: 480 },
  render: SystemGraphNodeRenderer,
  userCreatable: true,
});
