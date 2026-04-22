/**
 * Contract — ImageNode exposes a `context-out` port on protocol "context"
 * and appears in the node registry as a context-providing node.
 *
 * Anchors the visual-context plan (docs/visual-context-plan.md) Phase 3
 * requirement: ImageNode connects to a Leader's context-in port.
 */
import { describe, expect, it } from "vitest";

// Side-effect imports register the contract and node type.
import "../../src/nodes/ImageNode.tsx";

import { getContract, canConnect, LEADER_CONTRACT } from "../../src/graph.ts";
import { getNodeType } from "../../src/node-registry.ts";

describe("contract: ImageNode", () => {
  it("registers a graph contract with a context-out port", () => {
    const contract = getContract("image");
    expect(contract).toBeDefined();
    expect(contract!.nodeType).toBe("image");

    const ctxOut = contract!.ports.find((p) => p.id === "context-out");
    expect(ctxOut).toBeDefined();
    expect(ctxOut!.direction).toBe("output");
    expect(ctxOut!.protocol).toBe("context");
  });

  it("connects to a Leader's context-in port", () => {
    const leaderCtxIn = LEADER_CONTRACT.ports.find((p) => p.id === "context-in");
    expect(leaderCtxIn).toBeDefined();
    expect(canConnect("image", "context-out", "leader", "context-in")).toBe(true);
  });

  it("is registered as a context-providing node type", () => {
    const def = getNodeType("image");
    expect(def).toBeDefined();
    expect(def!.providesContext).toBe(true);
    expect(typeof def!.extractContent).toBe("function");
  });
});
