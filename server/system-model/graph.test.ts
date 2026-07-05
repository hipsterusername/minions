import { describe, expect, it } from "vitest";
import path from "path";
import { loadSystemModel } from "./load.ts";
import { systemModelToGraph } from "./graph.ts";

describe("systemModelToGraph", () => {
  it("builds nodes and linked-object edges", () => {
    const { model } = loadSystemModel(path.resolve("tests/fixtures/system-model/valid"));
    const graph = systemModelToGraph(model!);
    expect(graph.nodes.map((node) => node.id)).toContain("capability.workspace_management");
    expect(graph.edges.some((edge) => edge.relation === "constraint")).toBe(true);
  });
});
