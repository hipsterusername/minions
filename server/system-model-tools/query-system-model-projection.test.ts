import { describe, expect, it } from "vitest";
import { loadSystemModel } from "../system-model/load.ts";
import { copyValidFixtureWithSurfaces } from "../system-model/load.test.ts";
import { FACETS } from "./query-system-model-schema.ts";
import { objectFacets, preview, readFacets } from "./query-system-model-projection.ts";

const model = loadSystemModel(copyValidFixtureWithSurfaces()).model!;
const expected = {
  domain: ["summary", "behavior"], capability: [...FACETS],
  flow: ["summary", "files", "tests", "behavior", "decisions", "constraints"],
  surface: ["summary", "files", "tests", "behavior"], constraint: ["summary", "files", "tests", "behavior"],
  decision: ["summary", "files", "behavior"], risk: ["summary", "files", "behavior"],
};

describe("model detail projections", () => {
  it.each([...model.objectsById.values()])("advertises and reads supported facets for $id", (object) => {
    const fields = expected[object.type].filter((facet) => facet !== "files" || object.type !== "decision" || Boolean(object.file));
    expect(preview(object, 420).availableFacets).toEqual(fields);
    const read = readFacets(object, [...FACETS]);
    for (const facet of FACETS) {
      expect(read[facet]).toMatchObject(fields.includes(facet) ? { status: "ok" } : { status: "unavailable", reason: "not_modeled" });
    }
  });

  it("retains flow steps, declared references and entry-point file/test groups", () => {
    const capability = model.capabilities[0]!;
    const flow = model.flows[0]!;
    expect(objectFacets(capability).constraints).toEqual(capability.constraints);
    expect(objectFacets(capability).entryPoints).toEqual(capability.entryPoints);
    expect(objectFacets(capability).files).toEqual({ suggestedFiles: capability.suggestedFiles,
      entryPoints: capability.entryPoints.map(({ surface, files }) => ({ surface, files })) });
    expect(objectFacets(capability).tests).toEqual({ suggestedTests: capability.suggestedTests,
      entryPoints: capability.entryPoints.map(({ surface, tests }) => ({ surface, tests })) });
    expect(objectFacets(flow).behavior).toMatchObject({ steps: flow.steps, primaryCapability: flow.primaryCapability });
    expect(readFacets({ ...capability, constraints: [] }, ["constraints"]).constraints).toEqual({ status: "ok", value: [] });
  });

  it("keeps constraint applicability and instruction distinct and decision files honest", () => {
    const constraint = model.constraints[0]!;
    expect(objectFacets(constraint).behavior).toMatchObject({ statement: constraint.statement, appliesTo: constraint.appliesTo, scope: constraint.scope });
    expect(objectFacets(constraint).summary).toBe(constraint.agentInstruction ?? constraint.statement);
    const decision = { ...model.decisions[0]!, file: undefined };
    expect(readFacets(decision, ["files"]).files).toEqual({ status: "unavailable", reason: "not_modeled" });
    expect(readFacets({ ...decision, file: "decisions/custom.md" }, ["files"]).files).toEqual({ status: "ok", value: { documentFile: "decisions/custom.md" } });
  });
});
