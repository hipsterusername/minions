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
    const content = "x".repeat(128 * 1024);
    expect(() => assertPlanningContextLimits([
      source("one", "shared", content), source("two", "shared", content),
    ])).not.toThrow();
  });
});
