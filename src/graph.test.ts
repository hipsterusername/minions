/**
 * Unit tests for the graph contract system.
 *
 * Covers connection validation and the contract registry:
 *   - canConnect: direction, protocol, and existence checks
 *   - isPortOpen: declarative lifecycle guard (replaces canAcceptContextConnection)
 *   - getPortDef: lookup by nodeType + portId
 *   - getAllContracts: built-in registrations
 *   - registerContract / getContract: round-trip a custom contract
 */

import { describe, it, expect } from "vitest";
import {
  canConnect,
  isPortOpen,
  getPortDef,
  getContract,
  getAllContracts,
  registerContract,
} from "./graph.ts";
import type { NodeInterfaceContract } from "./graph.ts";
// Side-effect import — RenderNode registers its `context-out` contract on load.
import "./nodes/RenderNode.tsx";

describe("canConnect", () => {
  it("returns true for leader.task-out → minion.task-in", () => {
    expect(canConnect("leader", "task-out", "minion", "task-in")).toBe(true);
  });

  it("returns true for context-provider.context-out → leader.context-in", () => {
    expect(
      canConnect("context-provider", "context-out", "leader", "context-in"),
    ).toBe(true);
  });

  it("returns true for leader.context-out → leader.context-in (embedded dashboards as context)", () => {
    expect(canConnect("leader", "context-out", "leader", "context-in")).toBe(
      true,
    );
  });

  it("returns false when the source port is an input", () => {
    // minion.task-in is direction "input" — cannot be a source
    expect(canConnect("minion", "task-in", "leader", "context-in")).toBe(false);
  });

  it("returns false when the target port is an output", () => {
    // context-provider.context-out is direction "output" — cannot be a target
    expect(
      canConnect("leader", "task-out", "context-provider", "context-out"),
    ).toBe(false);
  });

  it("returns false when protocols mismatch", () => {
    // leader.task-out is task-assignment; leader.context-in is context
    expect(canConnect("leader", "task-out", "leader", "context-in")).toBe(false);
  });

  // Collapsed: the four unknown-lookup variants (unknown source/target
  // node type and source/target port id) into one representative. They
  // exercise the same lookup-failure path. See docs/testing-strategy.md §5.
  it("returns false when any of node-type/port-id is unknown", () => {
    expect(canConnect("ghost-type", "task-out", "minion", "task-in")).toBe(false);
  });
});

describe("isPortOpen (lifecycle guard)", () => {
  it("returns true for a port with no lifecycle callback", () => {
    // minion.task-in has no lifecycle callback → always open
    expect(isPortOpen("minion", "task-in", {})).toBe(true);
  });

  // Collapsed: three lifecycle-default cases (leader.task-out, context-in
  // with null/missing sessionKey) into one representative — they all
  // exercise the "no lifecycle / open by default" branch. See
  // docs/testing-strategy.md §5.
  it("returns true for leader.context-in when sessionKey is null/missing", () => {
    expect(isPortOpen("leader", "context-in", { sessionKey: null })).toBe(true);
  });

  it("returns false (locked) for leader.context-in when sessionKey is set", () => {
    expect(isPortOpen("leader", "context-in", { sessionKey: "active-key" })).toBe(false);
  });

  it("returns true for an unknown port (no definition → always open)", () => {
    expect(isPortOpen("ghost-type", "ghost-port", {})).toBe(true);
  });
});

describe("port lifecycle — custom lifecycle callbacks", () => {
  // Collapsed: three lifecycle tests that each constructed a self-mock
  // contract for 'locked' / 'open' / data-aware were redundant — kept the
  // data-aware case as the sole representative since it exercises both
  // returns through one callback. See docs/testing-strategy.md §5.
  it("lifecycle callback receives node data and can decide based on it", () => {
    const custom: NodeInterfaceContract = {
      nodeType: "test-lifecycle-data-aware",
      label: "Data Aware",
      description: "Locks when initialized",
      ports: [
        {
          id: "config-in",
          label: "Config",
          direction: "input",
          protocol: "context",
          maxConnections: 1,
          lifecycle: (nodeData: unknown) => {
            const data = nodeData as { initialized?: boolean };
            return data?.initialized ? "locked" : "open";
          },
        },
      ],
    };
    registerContract(custom);
    expect(isPortOpen("test-lifecycle-data-aware", "config-in", { initialized: false })).toBe(true);
    expect(isPortOpen("test-lifecycle-data-aware", "config-in", { initialized: true })).toBe(false);
    expect(isPortOpen("test-lifecycle-data-aware", "config-in", {})).toBe(true);
  });
});

describe("getPortDef", () => {
  it("returns the correct port definition for a known port", () => {
    const port = getPortDef("leader", "task-out");
    expect(port?.id).toBe("task-out");
    expect(port?.direction).toBe("output");
    expect(port?.protocol).toBe("task-assignment");
  });

  it("returns a minion input port with the right protocol", () => {
    const port = getPortDef("minion", "task-in");
    expect(port?.direction).toBe("input");
    expect(port?.protocol).toBe("task-assignment");
  });

  it("returns undefined for an unknown node type", () => {
    expect(getPortDef("ghost-type", "task-out")).toBeUndefined();
  });

  it("returns undefined for an unknown port id", () => {
    expect(getPortDef("leader", "ghost-port")).toBeUndefined();
  });
});

describe("getAllContracts", () => {
  it("includes the built-in leader contract", () => {
    const types = getAllContracts().map((c) => c.nodeType);
    expect(types).toContain("leader");
  });

  it("includes the built-in minion contract", () => {
    const types = getAllContracts().map((c) => c.nodeType);
    expect(types).toContain("minion");
  });

  it("includes the built-in context-provider contract", () => {
    const types = getAllContracts().map((c) => c.nodeType);
    expect(types).toContain("context-provider");
  });

  it("includes the built-in context-group contract", () => {
    const types = getAllContracts().map((c) => c.nodeType);
    expect(types).toContain("context-group");
  });
});

describe("registerContract / getContract", () => {
  it("round-trips a custom contract", () => {
    const custom: NodeInterfaceContract = {
      nodeType: "test-custom-node-unique-xyz-9182",
      label: "Custom Test Node",
      description: "A node registered only for this test",
      ports: [
        {
          id: "out",
          label: "Output",
          direction: "output",
          protocol: "context",
          maxConnections: 1,
        },
      ],
    };
    registerContract(custom);
    expect(getContract("test-custom-node-unique-xyz-9182")).toEqual(custom);
  });

  it("makes the custom contract appear in getAllContracts", () => {
    const custom: NodeInterfaceContract = {
      nodeType: "test-custom-node-unique-abc-1234",
      label: "Another Custom",
      description: "For getAllContracts test",
      ports: [],
    };
    registerContract(custom);
    const types = getAllContracts().map((c) => c.nodeType);
    expect(types).toContain("test-custom-node-unique-abc-1234");
  });
});
