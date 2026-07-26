import { describe, expect, it } from "vitest";
import { expandScope } from "./compile-scope.ts";
import { loadSystemModel } from "./load.ts";
import { copyValidFixtureWithSurfaces } from "./load.test.ts";

describe("expandScope", () => {
  it("stops after one typed hop instead of pulling sibling flows", () => {
    const model = loadSystemModel(copyValidFixtureWithSurfaces()).model!;
    const sibling = {
      ...model.flows[0]!,
      id: "flow.sibling",
      name: "Sibling flow",
      primaryCapability: "capability.workspace_management",
    };
    model.flows.push(sibling);
    model.objectsById.set(sibling.id, sibling);

    const scope = expandScope(model, ["flow.approve_changes"]);

    expect(scope.capabilities.map((item) => item.id)).toEqual(["capability.workspace_management"]);
    expect(scope.flows.map((item) => item.id)).toEqual(["flow.approve_changes"]);
    expect(scope.surfaces.map((item) => item.id)).toEqual([]);
  });

  it.each([
    "constraint.bus_only",
    "decision.bus_architecture",
    "risk.merge_bypass",
    "surface.mobile",
  ])("maps a %s seed into its linked capability closure", (seed) => {
    const model = loadSystemModel(copyValidFixtureWithSurfaces()).model!;
    expect(expandScope(model, [seed]).capabilities.map((item) => item.id)).toEqual([
      "capability.workspace_management",
    ]);
  });

  it("injects global and matched-domain constraints by scope", () => {
    const model = loadSystemModel(copyValidFixtureWithSurfaces()).model!;
    const base = model.constraints[0]!;
    const global = { ...base, id: "constraint.global", scope: "global" as const, guards: [], appliesTo: { capabilities: [], flows: [], surfaces: [], files: [] } };
    const domain = { ...base, id: "constraint.domain", scope: "domain" as const, guards: [], appliesTo: { capabilities: [], flows: [], surfaces: [], files: [] } };
    model.constraints.push(global, domain);
    model.objectsById.set(global.id, global);
    model.objectsById.set(domain.id, domain);

    expect(expandScope(model, ["capability.workspace_management"]).constraints.map((item) => item.id)).toEqual([
      "constraint.bus_only", "constraint.domain", "constraint.global",
    ]);
  });
});
