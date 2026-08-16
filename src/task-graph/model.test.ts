import { describe, expect, it } from "vitest";
import { createGraphFixture } from "./fixtures.ts";
import { filterNodes, getVirtualRange, MAX_TOPOLOGY_EDGES, MAX_TOPOLOGY_NODES, nodesForPlanItem, projectTopology, runtimeRole, whyNotRunning } from "./model.ts";

describe("task graph projections", () => {
  it("bounds topology independently of snapshot size", () => {
    const projected = projectTopology(createGraphFixture(1_000), "all", null);
    expect(projected.nodes.length).toBeLessThanOrEqual(MAX_TOPOLOGY_NODES);
    expect(projected.edges.length).toBeLessThanOrEqual(MAX_TOPOLOGY_EDGES);
    expect(projected.hiddenNodeCount).toBe(1_000 - MAX_TOPOLOGY_NODES);
  });

  it("bounds work queue ranges with overscan", () => {
    const range = getVirtualRange(1_000, 12_000, 348);
    expect(range.end - range.start).toBeLessThanOrEqual(15);
    expect(range.totalHeight).toBe(58_000);
  });

  it("provides canonical why-not-running explanations", () => {
    const snapshot = createGraphFixture(10);
    expect(whyNotRunning(snapshot.nodes[0]!)).toBe("Running now");
    expect(whyNotRunning(snapshot.nodes[5]!)).toBe("Waiting for operator input");
    expect(whyNotRunning(snapshot.nodes[3]!)).toBe("Ready; waiting for executor capacity");
  });

  it("maps plan items only by canonical task or session identity", () => {
    const snapshot = createGraphFixture(10);
    const byTask = nodesForPlanItem(snapshot.nodes, { taskId: "node-2", title: "Exact", status: "running", executor: "minion" });
    const bySession = nodesForPlanItem(snapshot.nodes, { taskId: "not-a-node", title: "Session", status: "running", executor: "minion", minionSessionKey: "session-3" });
    const byTitleOnly = nodesForPlanItem(snapshot.nodes, { taskId: "missing", title: "Task 4", status: "running", executor: "minion" });
    expect(byTask.map((node) => node.id)).toEqual(["node-2"]);
    expect(bySession.map((node) => node.id)).toEqual(["node-3"]);
    expect(byTitleOnly).toEqual([]);
    expect(runtimeRole(snapshot.nodes[2]!, [{ taskId: "node-2", title: "Exact", status: "running", executor: "leader" }])).toBe("leader");
  });

  it("offers active-path and attention projections without changing canonical nodes", () => {
    const snapshot = createGraphFixture(20);
    expect(filterNodes(snapshot.nodes, "active").some((node) => node.currentAttempt?.state === "running")).toBe(true);
    expect(filterNodes(snapshot.nodes, "attention").every((node) => node.currentAttempt?.state === "failed" || node.logicalState === "failed" || node.logicalState === "exhausted" || !!node.blocker || ["pending", "failed", "stale"].includes(node.verification.state))).toBe(true);
  });
});
