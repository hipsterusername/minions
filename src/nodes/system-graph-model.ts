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
  /** Forward-compatible until constraint scope is included in the graph wire. */
  scope?: "global" | "domain" | "targeted";
  suggestedFiles?: string[];
  suggestedTests?: string[];
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
  { id: "implements", label: "implements", description: "Flow → primary capability" },
  { id: "depends_on", label: "depends on", description: "Capability → capability dependency" },
  { id: "guards", label: "guards", description: "Targeted constraint → capability or flow" },
  { id: "bridge", label: "bridge", description: "Reasoned cross-domain connection" },
  { id: "entry_point", label: "entry point", description: "Capability → surface entry point" },
  { id: "decision", label: "decision", description: "Decision governs a target" },
  { id: "risk", label: "risk", description: "Risk applies to a target" },
  { id: "evidence", label: "evidence", description: "Evidence supports a constraint" },
];

export const ALL_RELATIONS: RelationType[] = RELATIONS.map((relation) => relation.id);

// ── Primary axis (the top row) ────────────────────────────────────────────
export type PrimaryType = Exclude<GraphNode["type"], "domain">;

export const PRIMARY_TYPES: { id: PrimaryType; label: string }[] = [
  { id: "capability", label: "Capabilities" },
  { id: "flow", label: "Flows" },
  { id: "constraint", label: "Constraints" },
  { id: "decision", label: "Decisions" },
  { id: "risk", label: "Risks" },
  { id: "surface", label: "Surfaces" },
];

export const CROSS_CUTTING_DOMAIN = "cross-cutting";

export interface DomainGroup {
  id: string;
  label: string;
  nodes: GraphNode[];
}

/** Browseable objects grouped in declared-domain order, then Cross-cutting. */
export function domainGroups(graph: SystemGraph, lens: LensId = "structure"): DomainGroup[] {
  const nodes = graph.nodes as GraphNode[];
  const domains = nodes.filter((item) => item.type === "domain");
  const labels = new Map(domains.map((item) => [item.id, item.label]));
  const buckets = new Map<string, GraphNode[]>();

  for (const item of nodes) {
    if (item.type === "domain" || !lensAttention(item, lens)) continue;
    const domainId = item.domain ?? CROSS_CUTTING_DOMAIN;
    const bucket = buckets.get(domainId) ?? [];
    bucket.push(item);
    buckets.set(domainId, bucket);
  }

  const order = [
    ...domains.map((item) => item.id),
    ...[...buckets.keys()].filter((id) => id !== CROSS_CUTTING_DOMAIN && !labels.has(id)),
    CROSS_CUTTING_DOMAIN,
  ];
  return [...new Set(order)].flatMap((id) => {
    const grouped = buckets.get(id) ?? [];
    if (grouped.length === 0 && id === CROSS_CUTTING_DOMAIN) return [];
    return [{ id, label: id === CROSS_CUTTING_DOMAIN ? "Cross-cutting" : labels.get(id) ?? id, nodes: grouped }];
  });
}

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
  items: RelatedItem[];
}

export interface RelatedItem {
  node: GraphNode;
  summaries: string[];
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
  const buckets = new Map<RelationType, Map<string, RelatedItem>>();

  for (const edge of graph.edges) {
    if (edge.source !== selectedId && edge.target !== selectedId) continue;
    if (!enabled.has(edge.relation)) continue;
    const otherId = edge.source === selectedId ? edge.target : edge.source;
    const other = byId.get(otherId);
    if (!other || other.id === selectedId) continue;
    const bucket = buckets.get(edge.relation) ?? new Map<string, RelatedItem>();
    const existing = bucket.get(other.id) ?? { node: other, summaries: [] };
    if (edge.summary && !existing.summaries.includes(edge.summary)) existing.summaries.push(edge.summary);
    bucket.set(other.id, existing);
    buckets.set(edge.relation, bucket);
  }

  return RELATIONS.flatMap((meta) => {
    const bucket = buckets.get(meta.id);
    if (!bucket || bucket.size === 0) return [];
    const items = [...bucket.values()];
    return [{ relation: meta.id, meta, items, nodes: items.map((item) => item.node) }];
  });
}

export interface AppliedConstraint {
  node: GraphNode;
  scope: "global" | "domain";
  inferred: boolean;
}

/**
 * Non-edge constraints applicable to an object. Explicit wire scope wins. Until
 * scope lands on the wire, an unconnected same-domain constraint can only be
 * inferred as domain-scoped; global constraints cannot be inferred safely.
 */
export function scopeAppliedConstraints(
  selectedId: string | null,
  graph: SystemGraph,
): AppliedConstraint[] {
  if (!selectedId) return [];
  const nodes = graph.nodes as GraphNode[];
  const selected = nodes.find((item) => item.id === selectedId);
  if (!selected || selected.type === "constraint" || selected.type === "domain") return [];
  const edgedConstraintIds = new Set(graph.edges.flatMap((edge) => {
    if (edge.relation !== "guards") return [];
    return [edge.source, edge.target].filter((id) => nodes.find((item) => item.id === id)?.type === "constraint");
  }));

  return nodes.flatMap((item): AppliedConstraint[] => {
    if (item.type !== "constraint" || item.scope === "targeted" || edgedConstraintIds.has(item.id)) return [];
    if (item.scope === "global") return [{ node: item, scope: "global", inferred: false }];
    if (item.scope === "domain" && item.domain === selected.domain) {
      return [{ node: item, scope: "domain", inferred: false }];
    }
    if (!item.scope && selected.domain && item.domain === selected.domain) {
      return [{ node: item, scope: "domain", inferred: true }];
    }
    return [];
  });
}

export function bridgeReasonsFor(selectedId: string | null, graph: SystemGraph): string[] {
  if (!selectedId) return [];
  return [...new Set(graph.edges
    .filter((edge) => edge.relation === "bridge" && (edge.source === selectedId || edge.target === selectedId))
    .map((edge) => edge.summary)
    .filter((summary): summary is string => !!summary))];
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

// ── Capability ↔ surface entry-point lanes ────────────────────────────────
export interface SurfaceLane {
  edge: SystemGraphEdge;
  surface: GraphNode;
  capability: GraphNode;
  files: string[];
  tests: string[];
}

function entryPointLanes(graph: SystemGraph): SurfaceLane[] {
  const byId = new Map((graph.nodes as GraphNode[]).map((item) => [item.id, item]));
  return graph.edges.flatMap((edge) => {
    if (edge.relation !== "entry_point") return [];
    const capability = byId.get(edge.source);
    const surface = byId.get(edge.target);
    if (capability?.type !== "capability" || surface?.type !== "surface") return [];
    return [{
      edge,
      capability,
      surface,
      files: [...new Set(edge.files ?? [])],
      tests: [...new Set(edge.tests ?? [])],
    }];
  });
}

/** Entry points grouped as sibling surface lanes for one capability. */
export function surfaceLanesForCapability(
  capabilityId: string | null,
  graph: SystemGraph,
): SurfaceLane[] {
  if (!capabilityId) return [];
  return entryPointLanes(graph).filter((lane) => lane.capability.id === capabilityId);
}

/** Every capability entering through one surface, with its per-entry-point files. */
export function capabilityLanesForSurface(
  surfaceId: string | null,
  graph: SystemGraph,
): SurfaceLane[] {
  if (!surfaceId) return [];
  return entryPointLanes(graph).filter((lane) => lane.surface.id === surfaceId);
}

export interface EntryPointDetails {
  files: string[];
  tests: string[];
}

/** File/test traceability for all entry-point edges touching an object. */
export function entryPointDetailsFor(
  selectedId: string | null,
  graph: SystemGraph,
): EntryPointDetails {
  if (!selectedId) return { files: [], tests: [] };
  const edges = graph.edges.filter(
    (edge) =>
      edge.relation === "entry_point" &&
      (edge.source === selectedId || edge.target === selectedId),
  );
  return {
    files: [...new Set(edges.flatMap((edge) => edge.files ?? []))],
    tests: [...new Set(edges.flatMap((edge) => edge.tests ?? []))],
  };
}
