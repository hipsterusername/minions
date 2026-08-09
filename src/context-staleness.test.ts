import { describe, it, expect } from "vitest";
import {
  computeContextEdgeStaleness,
  findContextEdgeStaleness,
} from "./context-staleness.ts";
import { seedContextDelivery } from "./context-delivery.ts";
import { resolveLeaderContextItem } from "./leader-context-mode.ts";
import type { CanvasNode } from "./types.ts";
import type { GraphEdge } from "./graph.ts";

const T0 = 1_000;

function node(id: string, type: string, data: unknown): CanvasNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    data,
  } as CanvasNode;
}

function leaderSource(id: string, contents: string[]): CanvasNode {
  return node(id, "leader", {
    taskName: "Upstream Task",
    messages: contents.map((content, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content,
      timestamp: i,
    })),
  });
}

function leaderTarget(
  id: string,
  opts: { sessionKey?: string | null; deliveredFrom?: CanvasNode[]; mode?: "lean" | "full" } = {},
): CanvasNode {
  const items = (opts.deliveredFrom ?? [])
    .map((src) => resolveLeaderContextItem(src, opts.mode ?? "lean"))
    .filter((i): i is NonNullable<typeof i> => i != null);
  return node(id, "leader", {
    sessionKey: opts.sessionKey === undefined ? "leader-xyz" : opts.sessionKey,
    messages: [],
    contextDelivery: items.length > 0 ? seedContextDelivery(items, T0) : {},
  });
}

function contextEdge(
  sourceNodeId: string,
  targetNodeId: string,
  contextMode?: "dashboard" | "lean" | "full",
): GraphEdge {
  return {
    id: `${sourceNodeId}->${targetNodeId}`,
    sourceNodeId,
    sourcePortId: "out",
    targetNodeId,
    targetPortId: "in",
    protocol: "context",
    ...(contextMode ? { contextMode } : {}),
  } as GraphEdge;
}

describe("computeContextEdgeStaleness", () => {
  it("returns null for non-context edges", () => {
    const edge = { ...contextEdge("a", "b", "lean"), protocol: "task-assignment" } as GraphEdge;
    const result = computeContextEdgeStaleness(edge, leaderSource("a", ["hi"]), leaderTarget("b"));
    expect(result).toBeNull();
  });

  it("returns null when the target has no session yet (nothing deliverable)", () => {
    const source = leaderSource("a", ["hi"]);
    const target = leaderTarget("b", { sessionKey: null });
    expect(computeContextEdgeStaleness(contextEdge("a", "b", "lean"), source, target)).toBeNull();
  });

  it("returns null when the source currently contributes no context", () => {
    const source = leaderSource("a", []); // no forwardable messages
    const target = leaderTarget("b");
    expect(computeContextEdgeStaleness(contextEdge("a", "b", "lean"), source, target)).toBeNull();
  });

  it("marks a never-delivered source as stale with a pending count", () => {
    const source = leaderSource("a", ["hi", "hello"]);
    const target = leaderTarget("b"); // empty ledger
    const result = computeContextEdgeStaleness(contextEdge("a", "b", "lean"), source, target);
    expect(result).toEqual({ stale: true, pendingBlocks: 2, deliveredAt: null });
  });

  it("reports fresh when the delivered transcript is current", () => {
    const source = leaderSource("a", ["hi", "hello"]);
    const target = leaderTarget("b", { deliveredFrom: [source] });
    const result = computeContextEdgeStaleness(contextEdge("a", "b", "lean"), source, target);
    expect(result).toEqual({ stale: false, pendingBlocks: 0, deliveredAt: T0 });
  });

  it("counts pending transcript blocks when the upstream leader progressed", () => {
    const delivered = leaderSource("a", ["hi", "hello"]);
    const target = leaderTarget("b", { deliveredFrom: [delivered] });
    const source = leaderSource("a", ["hi", "hello", "do X", "done"]);
    const result = computeContextEdgeStaleness(contextEdge("a", "b", "lean"), source, target);
    expect(result).toEqual({ stale: true, pendingBlocks: 2, deliveredAt: T0 });
  });

  it("marks changed non-transcript sources stale with pendingBlocks null", () => {
    const deliveredItem = {
      nodeId: "md",
      nodeType: "markdown",
      label: "Spec",
      content: "v1",
    };
    const target = node("b", "leader", {
      sessionKey: "leader-xyz",
      messages: [],
      contextDelivery: seedContextDelivery([deliveredItem], T0),
    });
    const source = node("md", "markdown", { title: "Spec", content: "v2", viewMode: "view" });
    const result = computeContextEdgeStaleness(contextEdge("md", "b"), source, target);
    expect(result).toMatchObject({ stale: true, pendingBlocks: null, deliveredAt: T0 });
  });
});

describe("findContextEdgeStaleness", () => {
  it("resolves endpoints from the node list and delegates", () => {
    const source = leaderSource("a", ["hi"]);
    const target = leaderTarget("b");
    const edge = contextEdge("a", "b", "lean");
    expect(findContextEdgeStaleness(edge, [target, source])).toEqual(
      computeContextEdgeStaleness(edge, source, target),
    );
  });

  it("returns null when either endpoint is missing", () => {
    const source = leaderSource("a", ["hi"]);
    const target = leaderTarget("b");
    const edge = contextEdge("a", "b", "lean");
    expect(findContextEdgeStaleness(edge, [source])).toBeNull();
    expect(findContextEdgeStaleness(edge, [target])).toBeNull();
    expect(findContextEdgeStaleness(edge, [])).toBeNull();
  });
});
