import "./test-helpers.ts";
import { describe, expect, it } from "vitest";
import {
  assertPlanningContextLimits,
  MAX_PLANNING_NODE_CONTEXT_BYTES,
  MAX_PLANNING_SOURCE_BYTES,
} from "./planning-context-limits.ts";

function source(nodeId: string, sourceId: string, content: string) {
  return { sourceSnapshotId: "snapshot", nodeId, sourceId,
    contentHash: `hash:${sourceId}`, content };
}

describe("planning context limits", () => {
  it("rejects an oversized individual source", () => {
    expect(() => assertPlanningContextLimits([
      source("node", "large", "x".repeat(MAX_PLANNING_SOURCE_BYTES + 1)),
    ])).toThrow("256 KiB");
  });

  it("rejects excessive aggregate context for one task", () => {
    const half = Math.floor(MAX_PLANNING_NODE_CONTEXT_BYTES / 2);
    expect(() => assertPlanningContextLimits([
      source("node", "one", "x".repeat(half)),
      source("node", "two", "x".repeat(half)),
      source("node", "three", "x"),
    ])).toThrow("512 KiB");
  });

  it("does not double-count one frozen source routed to multiple nodes", () => {
    const content = "x".repeat(MAX_PLANNING_SOURCE_BYTES);
    const shared = Array.from({ length: 9 }, (_, index) =>
      source(`node-${index}`, "shared", content));
    // Counting each routing edge would exceed the 2 MiB snapshot budget.
    expect(() => assertPlanningContextLimits(shared)).not.toThrow();
  });

  it("rejects distinct frozen sources exceeding the snapshot budget", () => {
    const content = "x".repeat(MAX_PLANNING_SOURCE_BYTES);
    const distinct = Array.from({ length: 9 }, (_, index) =>
      source(`node-${index}`, `source-${index}`, content));
    expect(() => assertPlanningContextLimits(distinct.slice(0, 8))).not.toThrow();
    expect(() => assertPlanningContextLimits(distinct)).toThrow("2 MiB");
  });
});
