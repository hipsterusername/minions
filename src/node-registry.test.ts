import { describe, expect, it } from "vitest";
import { getUserCreatableNodeTypes } from "./node-registry.ts";
// Importing the node modules triggers their registerNodeType side effects.
import "./nodes/ImageNode.tsx";
import "./nodes/ContextGroupNode.tsx";
import "./nodes/SystemGraphNode.tsx";

describe("getUserCreatableNodeTypes", () => {
  it("excludes image, context-group, and system-graph from the creatable menu", () => {
    const creatableTypes = getUserCreatableNodeTypes().map((def) => def.type);
    expect(creatableTypes).not.toContain("image");
    expect(creatableTypes).not.toContain("context-group");
    expect(creatableTypes).not.toContain("system-graph");
  });
});
