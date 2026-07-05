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
});
