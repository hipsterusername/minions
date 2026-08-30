// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { getUserCreatableNodeTypes } from "./node-registry.ts";
import { FLAG_DIALECTIC, resetFeatureFlags, setFeatureFlag } from "./feature-flags.ts";
// Importing the node modules triggers their registerNodeType side effects.
import "./nodes/ImageNode.tsx";
import "./nodes/ContextGroupNode.tsx";
import "./nodes/SystemGraphNode.tsx";
import "./nodes/DialecticNode.tsx";

describe("getUserCreatableNodeTypes", () => {
  afterEach(() => resetFeatureFlags());

  it("excludes image, context-group, and system-graph from the creatable menu", () => {
    const creatableTypes = getUserCreatableNodeTypes().map((def) => def.type);
    expect(creatableTypes).not.toContain("image");
    expect(creatableTypes).not.toContain("context-group");
    expect(creatableTypes).not.toContain("system-graph");
  });

  it("hides flag-gated node types until their flag is enabled", () => {
    // Dialectic is gated behind FLAG_DIALECTIC (default off).
    expect(getUserCreatableNodeTypes().map((d) => d.type)).not.toContain("dialectic");
    setFeatureFlag(FLAG_DIALECTIC, true);
    expect(getUserCreatableNodeTypes().map((d) => d.type)).toContain("dialectic");
  });
});
