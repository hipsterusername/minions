// Pure, render-free logic for the System Model view.
//
// The panel is a "primary row + scoped relations" board: the user picks whether
// the top row shows Capabilities or Flows, selects one, and sees ONLY the cards
// related to it — grouped by relationship type. All grouping/filtering lives
// here so it can be unit-tested without mounting React.

import type {
  SystemGraph,
  SystemGraphNode as BaseSystemGraphNode,
  SystemGraphEdge,
} from "../../shared/system-model/graph.ts";

export type GraphNode = BaseSystemGraphNode & {
  constraints?: string[];
  gates?: string[];
  reviewGate?: string;
  activePackets?: string[];
  activeWorkPackets?: string[];
  packets?: string[];
  usage?: {
    lastUsedAt?: number | null;
    recentPacketCount?: number;
    unusedInLastPackets?: number;
  };
  lastUsedAt?: number | null;
  recentPacketCount?: number;
  unusedInLastPackets?: number;
  orphaned?: boolean;
};

export type RelationType = SystemGraphEdge["relation"];

// ── Relationship vocabulary — one hue per relation type. ──────────────────
export interface RelationMeta {
  id: RelationType;
  label: string;
  description: string;
}

export const RELATIONS: RelationMeta[] = [
  { id: "linked_flow", label: "Flow link", description: "Capability ↔ Flow" },
  { id: "capability", label: "Capability", description: "Object → Capability it serves" },
  { id: "constraint", label: "Constraint", description: "Constraint applies to a target" },
  { id: "decision", label: "Decision", description: "Decision governs a target" },
  { id: "risk", label: "Risk", description: "Risk applies to a target" },
  { id: "evidence", label: "Evidence", description: "Evidence supports a constraint" },
];

export const ALL_RELATIONS: RelationType[] = RELATIONS.map((relation) => relation.id);

// ── Primary axis (the top row) ────────────────────────────────────────────
export type PrimaryType = "capability" | "flow";

export const PRIMARY_TYPES: { id: PrimaryType; label: string }[] = [
  { id: "capability", label: "Capabilities" },
  { id: "flow", label: "Flows" },
];

// ── Lenses (filter the primary row by a concern) ──────────────────────────
export type LensId = "structure" | "risk" | "freshness" | "usage" | "work";

export interface LensMeta {
  id: LensId;
  label: string;
  description: string;
  hasAttention: boolean;
}

export const LENSES: LensMeta[] = [
  { id: "structure", label: "All", description: "Every object", hasAttention: false },
  { id: "risk", label: "Risk", description: "High / critical risk objects", hasAttention: true },
  { id: "freshness", label: "Freshness", description: "Objects not verified fresh", hasAttention: true },
  { id: "usage", label: "Usage", description: "Orphaned or unused objects", hasAttention: true },
  { id: "work", label: "Work", description: "Objects with active packets", hasAttention: true },
];

const HIGH_RISK = new Set(["high", "critical"]);

// ── Node signal helpers ───────────────────────────────────────────────────
export function activePacketsFor(node: GraphNode): string[] {
  return [
    ...new Set(
      [
        ...(node.activePackets ?? []),
        ...(node.activeWorkPackets ?? []),
        ...(node.packets ?? []),
      ].filter(Boolean),
    ),
  ];
}

export function isElevatedRisk(node: GraphNode): boolean {
  return !!node.risk && HIGH_RISK.has(node.risk);
}

export function needsFreshnessAttention(node: GraphNode): boolean {
  return node.freshness !== "fresh";
}

export function needsUsageAttention(node: GraphNode): boolean {
  return (
    !!node.orphaned ||
    (node.usage?.recentPacketCount ?? node.recentPacketCount ?? 1) === 0 ||
    (node.usage?.unusedInLastPackets ?? node.unusedInLastPackets ?? 0) > 0
  );
}

export function usageLabel(node: GraphNode): string | null {
  if (node.orphaned) return "orphaned";
  const unusedWindow = node.usage?.unusedInLastPackets ?? node.unusedInLastPackets;
  if (unusedWindow && unusedWindow > 0) return `unused ${unusedWindow}`;
  const recent = node.usage?.recentPacketCount ?? node.recentPacketCount;
  if (recent !== undefined) return recent === 0 ? "unused" : `used ${recent}`;
  return null;
}

export function lastUsedLabel(node: GraphNode): string | null {
  const lastUsedAt = node.usage?.lastUsedAt ?? node.lastUsedAt;
  return typeof lastUsedAt === "number" ? new Date(lastUsedAt).toLocaleString() : null;
}

/** True when a node is flagged by the given lens ("structure" flags all). */
export function lensAttention(node: GraphNode, lens: LensId): boolean {
  switch (lens) {
    case "risk":
      return isElevatedRisk(node);
    case "freshness":
      return needsFreshnessAttention(node);
    case "usage":
      return needsUsageAttention(node);
    case "work":
      return activePacketsFor(node).length > 0;
    case "structure":
    default:
      return true;
  }
}

/** Short attribute chip for a card, e.g. "high" / "stale" / "orphaned". */
export function cardBadge(node: GraphNode): string | null {
  return usageLabel(node) ?? (node.freshness && node.freshness !== "unknown" ? node.freshness : null);
}

// ── Primary row ────────────────────────────────────────────────────────────
/** Nodes of the chosen primary type, optionally filtered by a lens. */
export function primaryNodes(
  graph: SystemGraph,
  primary: PrimaryType,
  lens: LensId = "structure",
): GraphNode[] {
  return (graph.nodes as GraphNode[]).filter(
    (node) => node.type === primary && lensAttention(node, lens),
  );
}

// ── Scoped relations for the selected primary node ─────────────────────────
export interface RelatedGroup {
  relation: RelationType;
  meta: RelationMeta;
  nodes: GraphNode[];
}

/**
 * The objects related to `selectedId`, grouped by relationship type and
 * returned in RELATIONS order. Empty and disabled-relation groups are omitted,
 * so callers render exactly the relevant cards — nothing else.
 */
export function relatedGroups(
  selectedId: string | null,
  graph: SystemGraph,
  enabled: Set<RelationType> = new Set(ALL_RELATIONS),
): RelatedGroup[] {
  if (!selectedId) return [];
  const byId = new Map((graph.nodes as GraphNode[]).map((n) => [n.id, n]));
  const buckets = new Map<RelationType, Map<string, GraphNode>>();

  for (const edge of graph.edges) {
    if (edge.source !== selectedId && edge.target !== selectedId) continue;
    if (!enabled.has(edge.relation)) continue;
    const otherId = edge.source === selectedId ? edge.target : edge.source;
    const other = byId.get(otherId);
    if (!other || other.id === selectedId) continue;
    const bucket = buckets.get(edge.relation) ?? new Map<string, GraphNode>();
    bucket.set(other.id, other);
    buckets.set(edge.relation, bucket);
  }

  return RELATIONS.flatMap((meta) => {
    const bucket = buckets.get(meta.id);
    if (!bucket || bucket.size === 0) return [];
    return [{ relation: meta.id, meta, nodes: [...bucket.values()] }];
  });
}

/** Count of distinct related objects for a node (across enabled relations). */
export function relatedCount(
  selectedId: string | null,
  graph: SystemGraph,
  enabled: Set<RelationType> = new Set(ALL_RELATIONS),
): number {
  const ids = new Set<string>();
  for (const group of relatedGroups(selectedId, graph, enabled)) {
    for (const node of group.nodes) ids.add(node.id);
  }
  return ids.size;
}

export function connectedNodes(
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
