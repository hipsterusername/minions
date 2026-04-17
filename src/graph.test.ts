/**
 * Unit tests for the graph contract system.
 *
 * Covers connection validation and the contract registry:
 *   - canConnect: direction, protocol, and existence checks
 *   - canAcceptContextConnection: state-aware leader port guard
 *   - getPortDef: lookup by nodeType + portId
 *   - getAllContracts: built-in registrations
 *   - registerContract / getContract: round-trip a custom contract
 */

import { describe, it, expect } from "vitest";
import {
  canConnect,
  canAcceptContextConnection,
  getPortDef,
  getContract,
  getAllContracts,
  registerContract,
} from "./graph.ts";
import type { NodeInterfaceContract } from "./graph.ts";

describe("canConnect", () => {
  it("returns true for leader.task-out → minion.task-in", () => {
    expect(canConnect("leader", "task-out", "minion", "task-in")).toBe(true);
  });

  it("returns true for context-provider.context-out → leader.context-in", () => {
    expect(
      canConnect("context-provider", "context-out", "leader", "context-in"),
    ).toBe(true);
  });

  it("returns false when the source port is an input", () => {
    // minion.task-in is direction "input" — cannot be a source
    expect(canConnect("minion", "task-in", "leader", "context-in")).toBe(false);
  });

  it("returns false when the target port is an output", () => {
    // minion.status-out is direction "output" — cannot be a target
    expect(canConnect("leader", "task-out", "minion", "status-out")).toBe(false);
  });

  it("returns false when protocols mismatch", () => {
    // leader.task-out is task-assignment; leader.context-in is context
    expect(canConnect("leader", "task-out", "leader", "context-in")).toBe(false);
  });

  it("returns false when source node type is unknown", () => {
    expect(canConnect("ghost-type", "task-out", "minion", "task-in")).toBe(false);
  });

  it("returns false when source port id is unknown", () => {
    expect(canConnect("leader", "no-such-port", "minion", "task-in")).toBe(false);
  });

  it("returns false when target node type is unknown", () => {
    expect(canConnect("leader", "task-out", "ghost-type", "task-in")).toBe(false);
  });

  it("returns false when target port id is unknown", () => {
    expect(canConnect("leader", "task-out", "minion", "no-such-port")).toBe(false);
  });
});

describe("canAcceptContextConnection", () => {
  it("returns true for a non-leader node type", () => {
    expect(canAcceptContextConnection("minion", "context-in", {})).toBe(true);
  });

  it("returns true for a leader on a non-context-in port", () => {
    expect(
      canAcceptContextConnection("leader", "task-out", { sessionKey: "active" }),
    ).toBe(true);
  });

  it("returns true for leader.context-in when sessionKey is null", () => {
    expect(
      canAcceptContextConnection("leader", "context-in", { sessionKey: null }),
    ).toBe(true);
  });

  it("returns true for leader.context-in when sessionKey is missing", () => {
    expect(canAcceptContextConnection("leader", "context-in", {})).toBe(true);
  });

  it("returns false for leader.context-in when sessionKey is set", () => {
    expect(
      canAcceptContextConnection("leader", "context-in", {
        sessionKey: "active-key",
      }),
    ).toBe(false);
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

  it("returns undefined for a contract that was never registered", () => {
    expect(getContract("never-registered-zzz-0000")).toBeUndefined();
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
