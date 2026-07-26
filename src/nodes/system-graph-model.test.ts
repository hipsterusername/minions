import { describe, expect, it } from "vitest";
import type { SystemGraph } from "../../shared/system-model/graph.ts";
import {
  cardBadge,
  bridgeReasonsFor,
  capabilityLanesForSurface,
  entryPointDetailsFor,
  domainGroups,
  LENSES,
  lensAttention,
  primaryNodes,
  RELATIONS,
  relatedCount,
  relatedGroups,
  scopeAppliedConstraints,
  surfaceLanesForCapability,
  type GraphNode,
} from "./system-graph-model.ts";

function node(partial: Partial<GraphNode> & { id: string; type: GraphNode["type"] }): GraphNode {
  return { label: partial.id, freshness: "unknown", ...partial } as GraphNode;
}

const graph: SystemGraph = {
  nodes: [
    node({ id: "domain.alpha", type: "domain", label: "Alpha" }),
    node({ id: "domain.beta", type: "domain", label: "Beta" }),
    node({ id: "capability.a", type: "capability", domain: "domain.alpha", label: "Cap A", risk: "high", freshness: "stale" }),
    node({ id: "capability.b", type: "capability", domain: "domain.beta", label: "Cap B", risk: "low", freshness: "fresh" }),
    node({ id: "flow.b", type: "flow", domain: "domain.alpha", label: "Flow B", risk: "low", freshness: "fresh" }),
    node({ id: "constraint.c", type: "constraint", domain: "domain.alpha", scope: "targeted", label: "Constraint C", risk: "critical" }),
    node({ id: "constraint.global", type: "constraint", domain: "domain.alpha", scope: "global", label: "Global constraint" }),
    node({ id: "constraint.domain", type: "constraint", domain: "domain.alpha", scope: "domain", label: "Alpha constraint" }),
    node({ id: "risk.d", type: "risk", domain: "domain.alpha", label: "Risk D", risk: "high" }),
    node({ id: "surface.canvas", type: "surface", label: "Canvas", freshness: "fresh" }),
    node({ id: "decision.ui", type: "decision", label: "UI decision" }),
  ],
  edges: [
    { id: "e-flow", source: "flow.b", target: "capability.a", relation: "implements" },
    { id: "e-constraint", source: "constraint.c", target: "capability.a", relation: "guards" },
    { id: "e-bridge", source: "capability.a", target: "capability.b", relation: "bridge", summary: "Shares a cross-domain contract." },
    { id: "e-risk", source: "capability.a", target: "risk.d", relation: "risk" },
    {
      id: "e-entry",
      source: "capability.a",
      target: "surface.canvas",
      relation: "entry_point",
      files: ["src/Canvas.tsx"],
      tests: ["src/Canvas.test.tsx"],
    },
  ],
};

describe("relation + lens metadata", () => {
  it("declares entry points with the relationship vocabulary", () => {
    expect(RELATIONS.map((r) => r.id)).toEqual([
      "implements",
      "depends_on",
      "guards",
      "bridge",
      "entry_point",
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
    expect(primaryNodes(graph, "surface").map((n) => n.id)).toEqual(["surface.canvas"]);
  });

  it("applies the lens filter to the primary row", () => {
    expect(primaryNodes(graph, "capability", "risk").map((n) => n.id)).toEqual(["capability.a"]);
  });
});

describe("domainGroups", () => {
  it("groups domain-owned objects under domain labels and unowned objects as Cross-cutting", () => {
    const groups = domainGroups(graph);
    expect(groups.map((group) => group.label)).toEqual(["Alpha", "Beta", "Cross-cutting"]);
    expect(groups.find((group) => group.label === "Alpha")?.nodes.map((item) => item.id))
      .toContain("capability.a");
    expect(groups.find((group) => group.label === "Cross-cutting")?.nodes.map((item) => item.id))
      .toEqual(["surface.canvas", "decision.ui"]);
  });
});

describe("relatedGroups", () => {
  it("groups related objects by relation in legend order, skipping empties", () => {
    const groups = relatedGroups("capability.a", graph);
    expect(groups.map((g) => g.relation)).toEqual(["implements", "guards", "bridge", "entry_point", "risk"]);
    expect(groups[0]!.nodes.map((n) => n.id)).toEqual(["flow.b"]);
    expect(groups[2]!.items[0]?.summaries).toEqual(["Shares a cross-domain contract."]);
    expect(groups[4]!.nodes.map((n) => n.id)).toEqual(["risk.d"]);
  });

  it("omits disabled relations", () => {
    const groups = relatedGroups("capability.a", graph, new Set(["implements"]));
    expect(groups.map((g) => g.relation)).toEqual(["implements"]);
  });

  it("returns nothing for a node with no edges or no selection", () => {
    expect(relatedGroups("decision.ui", graph)).toEqual([]);
    expect(relatedGroups(null, graph)).toEqual([]);
  });

  it("counts distinct related objects", () => {
    expect(relatedCount("capability.a", graph)).toBe(5);
    expect(relatedCount("capability.a", graph, new Set(["implements"]))).toBe(1);
  });
});

describe("scope and bridge details", () => {
  it("injects global and same-domain domain constraints without graph edges", () => {
    expect(scopeAppliedConstraints("capability.a", graph).map(({ node, scope }) => [node.id, scope]))
      .toEqual([
        ["constraint.global", "global"],
        ["constraint.domain", "domain"],
      ]);
    expect(scopeAppliedConstraints("capability.b", graph).map(({ node }) => node.id))
      .toEqual(["constraint.global"]);
  });

  it("returns bridge reasons for either endpoint", () => {
    expect(bridgeReasonsFor("capability.b", graph)).toEqual(["Shares a cross-domain contract."]);
  });
});

describe("entry-point lanes", () => {
  it("derives a capability's surface lane with edge-specific files and tests", () => {
    const lanes = surfaceLanesForCapability("capability.a", graph);
    expect(lanes.map((lane) => lane.surface.id)).toEqual(["surface.canvas"]);
    expect(lanes[0]?.files).toEqual(["src/Canvas.tsx"]);
    expect(lanes[0]?.tests).toEqual(["src/Canvas.test.tsx"]);
  });

  it("derives the inverse capability lanes for a surface", () => {
    expect(capabilityLanesForSurface("surface.canvas", graph).map((lane) => lane.capability.id))
      .toEqual(["capability.a"]);
  });

  it("collects deduplicated entry-point traceability for either endpoint", () => {
    expect(entryPointDetailsFor("surface.canvas", graph)).toEqual({
      files: ["src/Canvas.tsx"],
      tests: ["src/Canvas.test.tsx"],
    });
    expect(entryPointDetailsFor(null, graph)).toEqual({ files: [], tests: [] });
  });
});
