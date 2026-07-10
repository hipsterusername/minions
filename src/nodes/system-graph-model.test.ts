import { describe, expect, it } from "vitest";
import type { SystemGraph } from "../../shared/system-model/graph.ts";
import {
  cardBadge,
  LENSES,
  lensAttention,
  primaryNodes,
  RELATIONS,
  relatedCount,
  relatedGroups,
  type GraphNode,
} from "./system-graph-model.ts";

function node(partial: Partial<GraphNode> & { id: string; type: GraphNode["type"] }): GraphNode {
  return { label: partial.id, freshness: "unknown", ...partial } as GraphNode;
}

const graph: SystemGraph = {
  nodes: [
    node({ id: "capability.a", type: "capability", label: "Cap A", risk: "high", freshness: "stale" }),
    node({ id: "capability.b", type: "capability", label: "Cap B", risk: "low", freshness: "fresh" }),
    node({ id: "flow.b", type: "flow", label: "Flow B", risk: "low", freshness: "fresh" }),
    node({ id: "constraint.c", type: "constraint", label: "Constraint C", risk: "critical" }),
    node({ id: "risk.d", type: "risk", label: "Risk D", risk: "high" }),
  ],
  edges: [
    { id: "e-flow", source: "capability.a", target: "flow.b", relation: "linked_flow" },
    { id: "e-constraint", source: "capability.a", target: "constraint.c", relation: "constraint" },
    { id: "e-risk", source: "capability.a", target: "risk.d", relation: "risk" },
  ],
};

describe("relation + lens metadata", () => {
  it("declares all six relation types in legend order", () => {
    expect(RELATIONS.map((r) => r.id)).toEqual([
      "linked_flow",
      "capability",
      "constraint",
      "decision",
      "risk",
      "evidence",
    ]);
  });

  it("only structure lens matches every node", () => {
    expect(LENSES.find((l) => l.id === "structure")?.hasAttention).toBe(false);
  });
});

describe("lensAttention", () => {
  const high = node({ id: "x", type: "capability", risk: "high" });
  const low = node({ id: "y", type: "capability", risk: "low", freshness: "fresh" });
  it("structure flags everything", () => {
    expect(lensAttention(low, "structure")).toBe(true);
  });
  it("risk flags high/critical only", () => {
    expect(lensAttention(high, "risk")).toBe(true);
    expect(lensAttention(low, "risk")).toBe(false);
  });
  it("work flags nodes with active packets", () => {
    expect(lensAttention(node({ id: "w", type: "flow", activePackets: ["p1"] }), "work")).toBe(true);
    expect(lensAttention(low, "work")).toBe(false);
  });
});

describe("cardBadge", () => {
  it("prefers usage, falls back to non-unknown freshness", () => {
    expect(cardBadge(node({ id: "n", type: "capability", orphaned: true }))).toBe("orphaned");
    expect(cardBadge(node({ id: "n", type: "capability", freshness: "stale" }))).toBe("stale");
    expect(cardBadge(node({ id: "n", type: "capability", freshness: "unknown" }))).toBeNull();
  });
});

describe("primaryNodes", () => {
  it("returns only nodes of the chosen primary type", () => {
    expect(primaryNodes(graph, "capability").map((n) => n.id)).toEqual([
      "capability.a",
      "capability.b",
    ]);
    expect(primaryNodes(graph, "flow").map((n) => n.id)).toEqual(["flow.b"]);
  });

  it("applies the lens filter to the primary row", () => {
    expect(primaryNodes(graph, "capability", "risk").map((n) => n.id)).toEqual(["capability.a"]);
  });
});

describe("relatedGroups", () => {
  it("groups related objects by relation in legend order, skipping empties", () => {
    const groups = relatedGroups("capability.a", graph);
    expect(groups.map((g) => g.relation)).toEqual(["linked_flow", "constraint", "risk"]);
    expect(groups[0]!.nodes.map((n) => n.id)).toEqual(["flow.b"]);
    expect(groups[2]!.nodes.map((n) => n.id)).toEqual(["risk.d"]);
  });

  it("omits disabled relations", () => {
    const groups = relatedGroups("capability.a", graph, new Set(["linked_flow"]));
    expect(groups.map((g) => g.relation)).toEqual(["linked_flow"]);
  });

  it("returns nothing for a node with no edges or no selection", () => {
    expect(relatedGroups("capability.b", graph)).toEqual([]);
    expect(relatedGroups(null, graph)).toEqual([]);
  });

  it("counts distinct related objects", () => {
    expect(relatedCount("capability.a", graph)).toBe(3);
    expect(relatedCount("capability.a", graph, new Set(["linked_flow"]))).toBe(1);
  });
});
