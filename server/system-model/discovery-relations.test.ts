import { describe, expect, it } from "vitest";
import { loadSystemModel } from "./load.ts";
import { copyValidFixtureWithSurfaces } from "./load.test.ts";
import { discoveryEdges, DISCOVERY_RELATIONSHIPS } from "./discovery-relations.ts";

function fixture() {
  const model = loadSystemModel(copyValidFixtureWithSurfaces()).model!;
  const capability = model.capabilities[0]!;
  const flow = model.flows[0]!;
  const constraint = model.constraints[0]!;
  const decision = model.decisions[0]!;
  const risk = model.risks[0]!;
  capability.dependsOn = [capability.id];
  capability.constraints = [constraint.id];
  capability.decisions = [decision.id];
  capability.risks = [risk.id];
  capability.bridges = [{ to: flow.id, reason: "Explicit bridge" }];
  flow.constraints = [constraint.id];
  flow.decisions = [decision.id];
  flow.risks = [risk.id];
  flow.bridges = [{ to: capability.id, reason: "Return bridge" }];
  constraint.guards = [capability.id];
  constraint.evidence = [decision.id, "test/file.ts"];
  constraint.appliesTo = { capabilities: [capability.id], flows: [flow.id], surfaces: ["surface.mobile"], files: ["server/**"] };
  decision.evidence = [capability.id, "README.md"];
  risk.appliesTo = { capabilities: [capability.id], flows: [flow.id], surfaces: ["surface.mobile"], files: ["server/**"] };
  return { model, capability, flow, constraint, decision, risk };
}

describe("declared discovery relationships", () => {
  it("covers every relationship family and retains parallel field provenance", () => {
    const { model, capability, flow, constraint, decision, risk } = fixture();
    const edges = discoveryEdges(model);
    expect(new Set(edges.map((edge) => edge.relation))).toEqual(new Set(DISCOVERY_RELATIONSHIPS));
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: capability.id, target: constraint.id, relation: "constraint", field: "constraints[0]" }),
      expect.objectContaining({ source: flow.id, target: capability.id, relation: "primary_capability" }),
      expect.objectContaining({ source: capability.id, target: flow.id, relation: "bridge", reason: "Explicit bridge" }),
      expect.objectContaining({ source: capability.id, target: flow.id, relation: "entry_point", field: "entryPoints[0].flows[0]" }),
      expect.objectContaining({ source: capability.id, target: flow.id, relation: "entry_point", field: "entryPoints[1].flows[0]" }),
      expect.objectContaining({ source: decision.id, target: capability.id, relation: "evidence" }),
      expect.objectContaining({ source: risk.id, target: "surface.mobile", relation: "applies_to" }),
      expect.objectContaining({ source: constraint.id, target: "surface.mobile", relation: "applies_to" }),
    ]));
    expect(edges.some((edge) => edge.target === "test/file.ts" || edge.target === "README.md" || edge.target === "server/**")).toBe(false);
  });

  it("requires a bridge for cross-domain edges and does not invent scope edges", () => {
    const { model, capability, flow, constraint } = fixture();
    flow.domain = "domain.other";
    capability.bridges = [];
    flow.bridges = [];
    expect(discoveryEdges(model).some((edge) => edge.source === flow.id && edge.target === capability.id)).toBe(false);
    capability.bridges = [{ to: flow.id, reason: "Cross-domain behavior" }];
    expect(discoveryEdges(model)).toContainEqual(expect.objectContaining({ source: flow.id, target: capability.id, relation: "primary_capability" }));
    const global = { ...constraint, id: "constraint.global", scope: "global" as const, guards: [], evidence: [],
      appliesTo: { capabilities: [], flows: [], surfaces: [], files: [] } };
    model.objectsById.set(global.id, global);
    expect(discoveryEdges(model).filter((edge) => edge.source === global.id).map((edge) => edge.relation)).toEqual(["domain"]);
    expect(discoveryEdges(model).some((edge) => edge.target === global.id)).toBe(false);
  });
});
