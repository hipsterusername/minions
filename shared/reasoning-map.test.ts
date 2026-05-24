import { describe, expect, it } from "vitest";
import {
  applyReasoningOps,
  createReasoningMap,
  validateReasoningMap,
  type ReasoningMap,
} from "./reasoning-map.ts";

const now = "2026-05-23T12:00:00.000Z";

function baseMap(): ReasoningMap {
  return createReasoningMap({
    id: "map-1",
    title: "Debug checkout",
    now,
    outcome: {
      title: "Checkout works",
      summary: "Find and fix the checkout failure.",
      successSignal: "Checkout test passes.",
      basis: "user_confirmed",
      confidence: "medium",
    },
  });
}

describe("reasoning-map validation", () => {
  it("accepts a supported decision path", () => {
    const result = applyReasoningOps(baseMap(), [
      {
        op: "add_node",
        node: {
          id: "hyp-cache",
          type: "hypothesis",
          title: "Cache mismatch",
          summary: "A stale cache explains the checkout failure.",
          state: "active",
          basis: "inferred",
          confidence: "medium",
          falsifiedBy: "A clean cache still reproduces the failure.",
        },
      },
      {
        op: "add_node",
        node: {
          id: "ev-test",
          type: "evidence",
          title: "Failing test",
          summary: "Checkout integration fails before cache clear.",
          state: "validated",
          basis: "observed",
          confidence: "high",
          evidence: {
            source: "test_result",
            strength: "strong",
            summary: "pnpm test checkout failed.",
            handle: "pnpm test checkout",
          },
        },
      },
      {
        op: "add_edge",
        edge: {
          id: "edge-ev-hyp",
          sourceId: "ev-test",
          targetId: "hyp-cache",
          kind: "supports",
          polarity: 1,
          strength: "strong",
        },
      },
    ], { now });

    expect(result.validation.ok).toBe(true);
    expect(result.validation.findings).toEqual([]);
  });

  it("errors when a hypothesis has no falsification criterion", () => {
    const map = {
      ...baseMap(),
      nodes: [
        ...baseMap().nodes,
        {
          id: "hyp",
          type: "hypothesis",
          title: "Maybe",
          summary: "Maybe this explains it.",
          state: "active",
          basis: "assumed",
          confidence: "low",
          createdAt: now,
          updatedAt: now,
          falsifiedBy: "",
        },
      ],
    } as ReasoningMap;

    expect(validateReasoningMap(map, now).findings).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "hypothesis_missing_falsified_by",
        nodeId: "hyp",
      }),
    );
  });

  it("warns for high confidence with weak evidence", () => {
    const result = applyReasoningOps(baseMap(), [
      {
        op: "add_node",
        node: {
          id: "decision",
          type: "decision",
          title: "Patch cache layer",
          summary: "Change the cache invalidation logic.",
          state: "active",
          basis: "inferred",
          confidence: "high",
          rationale: "The failure appears cache-related.",
          reversible: true,
        },
      },
    ], { now });

    expect(result.validation.findings).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "high_confidence_weak_evidence",
        nodeId: "decision",
      }),
    );
  });

  it("warns when a decision is based only on assumptions", () => {
    const result = applyReasoningOps(baseMap(), [
      {
        op: "add_node",
        node: {
          id: "decision",
          type: "decision",
          title: "Rewrite checkout",
          summary: "Replace the checkout flow.",
          state: "active",
          basis: "assumed",
          confidence: "medium",
          rationale: "Assume the flow is too complex to patch.",
          reversible: false,
        },
      },
    ], { now });

    expect(result.validation.findings).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "decision_only_assumptions",
        nodeId: "decision",
      }),
    );
  });

  it("errors for contradictory evidence on an unresolved node", () => {
    const result = applyReasoningOps(baseMap(), [
      {
        op: "add_node",
        node: {
          id: "hyp",
          type: "hypothesis",
          title: "Cache mismatch",
          summary: "A stale cache explains the checkout failure.",
          state: "active",
          basis: "inferred",
          confidence: "medium",
          falsifiedBy: "Clean cache still fails.",
        },
      },
      {
        op: "add_node",
        node: {
          id: "ev-support",
          type: "evidence",
          title: "Supports",
          summary: "One test supports the cache theory.",
          state: "validated",
          basis: "observed",
          confidence: "high",
          evidence: { source: "test_result", strength: "moderate", summary: "support", handle: "test a" },
        },
      },
      {
        op: "add_node",
        node: {
          id: "ev-refute",
          type: "evidence",
          title: "Refutes",
          summary: "Another test refutes the cache theory.",
          state: "validated",
          basis: "observed",
          confidence: "high",
          evidence: { source: "test_result", strength: "moderate", summary: "refute", handle: "test b" },
        },
      },
      { op: "add_edge", edge: { id: "a", sourceId: "ev-support", targetId: "hyp", kind: "supports", polarity: 1 } },
      { op: "add_edge", edge: { id: "b", sourceId: "ev-refute", targetId: "hyp", kind: "supports", polarity: -1 } },
    ], { now });

    expect(result.validation.findings).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "contradictory_evidence",
        nodeId: "hyp",
      }),
    );
  });

  it("errors for circular unresolved dependencies", () => {
    const result = applyReasoningOps(baseMap(), [
      {
        op: "add_node",
        node: {
          id: "hyp-a",
          type: "hypothesis",
          title: "A",
          summary: "A depends on B.",
          state: "active",
          basis: "inferred",
          confidence: "medium",
          falsifiedBy: "A is false.",
        },
      },
      {
        op: "add_node",
        node: {
          id: "hyp-b",
          type: "hypothesis",
          title: "B",
          summary: "B depends on A.",
          state: "active",
          basis: "inferred",
          confidence: "medium",
          falsifiedBy: "B is false.",
        },
      },
      { op: "add_edge", edge: { id: "dep-a", sourceId: "hyp-a", targetId: "hyp-b", kind: "depends_on" } },
      { op: "add_edge", edge: { id: "dep-b", sourceId: "hyp-b", targetId: "hyp-a", kind: "depends_on" } },
    ], { now });

    expect(result.validation.findings).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "circular_unresolved_dependency",
      }),
    );
  });
});
