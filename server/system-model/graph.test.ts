import { describe, expect, it } from "vitest";
import path from "path";
import { loadSystemModel } from "./load.ts";
import { systemModelToGraph } from "./graph.ts";
import { copyValidFixtureWithSurfaces } from "./load.test.ts";

describe("systemModelToGraph", () => {
  it("builds nodes and linked-object edges", () => {
    const { model } = loadSystemModel(path.resolve("tests/fixtures/system-model/valid"));
    const graph = systemModelToGraph(model!);
    expect(graph.nodes).toContainEqual(expect.objectContaining({ id: "domain.workspace", type: "domain" }));
    expect(graph.nodes).toContainEqual(expect.objectContaining({
      id: "capability.workspace_management", domain: "domain.workspace",
    }));
    expect(graph.edges).toContainEqual(expect.objectContaining({
      source: "flow.approve_changes", target: "capability.workspace_management", relation: "implements",
    }));
    expect(graph.edges).toContainEqual(expect.objectContaining({
      source: "constraint.bus_only", target: "capability.workspace_management", relation: "guards",
    }));
  });

  it("emits surface nodes and entry-point metadata edges", () => {
    const model = loadSystemModel(copyValidFixtureWithSurfaces()).model!;
    const graph = systemModelToGraph(model);
    expect(graph.nodes).toContainEqual(expect.objectContaining({
      id: "surface.mobile", type: "surface",
      suggestedFiles: ["src/mobile/**"],
    }));
    expect(graph.edges).toContainEqual(expect.objectContaining({
      source: "capability.workspace_management",
      target: "surface.mobile",
      relation: "entry_point",
      files: ["src/mobile/**"],
      tests: ["src/mobile/app.test.ts"],
    }));
  });
});
