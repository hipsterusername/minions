import { describe, expect, it } from "vitest";
import { systemGraphSchema } from "./graph.ts";

describe("systemGraphSchema", () => {
  it("validates graph wire format", () => {
    const graph = systemGraphSchema.parse({
      nodes: [{ id: "capability.workspace", type: "capability", label: "Workspace" }],
      edges: [],
    });
    expect(graph.nodes[0]?.freshness).toBe("unknown");
  });

  it("accepts surface nodes and entry-point provenance", () => {
    const graph = systemGraphSchema.parse({
      nodes: [{ id: "surface.mobile", type: "surface", label: "Mobile" }],
      edges: [{
        id: "capability.workspace->entry_point->surface.mobile",
        source: "capability.workspace",
        target: "surface.mobile",
        relation: "entry_point",
        files: ["src/mobile/**"],
        tests: ["src/mobile/app.test.ts"],
        summary: "Mobile workspace",
      }],
    });
    expect(graph.edges[0]?.files).toEqual(["src/mobile/**"]);
  });

  it("accepts domains and tight typed relations", () => {
    const graph = systemGraphSchema.parse({
      nodes: [
        { id: "domain.workspace", type: "domain", label: "Workspace" },
        { id: "capability.workspace", type: "capability", label: "Workspace", domain: "domain.workspace" },
      ],
      edges: [{
        id: "capability.workspace->bridge->flow.sync",
        source: "capability.workspace",
        target: "flow.sync",
        relation: "bridge",
        summary: "Coordinates durable synchronization.",
      }],
    });
    expect(graph.nodes[1]?.domain).toBe("domain.workspace");
    expect(graph.edges[0]?.relation).toBe("bridge");
  });
});
