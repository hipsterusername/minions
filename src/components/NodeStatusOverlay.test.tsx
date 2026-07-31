import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NodeStatusOverlay, getOverlayNodes, resolveLeaderTitle } from "./NodeStatusOverlay.tsx";
import type { CanvasNode, CanvasTransform } from "../types.ts";
import type { WorkItemSnapshot } from "../../shared/work-item-contracts.ts";

const TRANSFORM: CanvasTransform = { x: 20, y: 30, scale: 0.5 };

function workItem(over: Partial<WorkItemSnapshot> = {}): WorkItemSnapshot {
  return {
    id: "work-1", projectId: "project", projectPath: "/repo", title: "Task",
    lifecycle: { runtimeState: "inactive", outcome: "completed", resolution: "open",
      changeMode: "live", integrationState: "live_clean", lifecycleRevision: 2 },
    waitKind: null, currentRunKey: "run-1", iteration: 1,
    lastTransitionAt: 2,
    createdAt: 1, updatedAt: 2, ...over,
  };
}

function node(
  overrides: Partial<CanvasNode> & Pick<CanvasNode, "id" | "type">,
): CanvasNode {
  return {
    position: { x: 100, y: 200 },
    size: { width: 300, height: 180 },
    data: {},
    ...overrides,
  };
}

describe("NodeStatusOverlay helpers", () => {
  it("returns only leader and minion nodes", () => {
    const nodes = [
      node({ id: "leader-1", type: "leader" }),
      node({ id: "minion-1", type: "minion" }),
      node({ id: "markdown-1", type: "markdown" }),
    ];

    expect(getOverlayNodes(nodes).map((overlayNode) => overlayNode.id)).toEqual([
      "leader-1",
      "minion-1",
    ]);
  });

  it("resolves a leader title from its own task name", () => {
    const leader = node({
      id: "leader-1",
      type: "leader",
      data: { taskName: "Ship overlay" },
    });

    expect(resolveLeaderTitle(leader, new Map([[leader.id, leader]]))).toBe(
      "Ship overlay",
    );
  });

  it("resolves a minion title from its owning leader", () => {
    const leader = node({
      id: "leader-1",
      type: "leader",
      data: { taskName: "Owning leader" },
    });
    const minion = node({
      id: "minion-1",
      type: "minion",
      data: { leaderId: "leader-1" },
    });

    expect(
      resolveLeaderTitle(
        minion,
        new Map([
          [leader.id, leader],
          [minion.id, minion],
        ]),
      ),
    ).toBe("Owning leader");
  });

  it("falls back to Leader when a minion owner is missing", () => {
    const minion = node({
      id: "minion-1",
      type: "minion",
      data: { leaderId: "missing" },
    });

    expect(resolveLeaderTitle(minion, new Map([[minion.id, minion]]))).toBe(
      "Leader",
    );
  });
});

describe("NodeStatusOverlay", () => {
  it("renders nothing when hidden", () => {
    render(
      <NodeStatusOverlay
        nodes={[node({ id: "leader-1", type: "leader" })]}
        transform={TRANSFORM}
        visible={false}
      />,
    );

    expect(screen.queryByTestId("node-status-overlay")).toBeNull();
  });

  it("renders one overlay item per leader and minion node only", () => {
    render(
      <NodeStatusOverlay
        nodes={[
          node({ id: "leader-1", type: "leader", data: { status: "running" } }),
          node({ id: "minion-1", type: "minion", data: { status: "idle" } }),
          node({ id: "image-1", type: "image", data: { status: "running" } }),
        ]}
        transform={TRANSFORM}
        visible={true}
      />,
    );

    expect(screen.getByTestId("node-status-overlay-item-leader-1")).toBeInTheDocument();
    expect(screen.getByTestId("node-status-overlay-item-minion-1")).toBeInTheDocument();
    expect(screen.queryByTestId("node-status-overlay-item-image-1")).toBeNull();
  });

  it("shows a leader node's own task name", () => {
    render(
      <NodeStatusOverlay
        nodes={[
          node({
            id: "leader-1",
            type: "leader",
            data: { status: "completed", taskName: "Prepare release" },
          }),
        ]}
        transform={TRANSFORM}
        visible={true}
      />,
    );

    expect(screen.getByText("Prepare release")).toBeInTheDocument();
  });

  it("shows a minion node's owning leader task name", () => {
    render(
      <NodeStatusOverlay
        nodes={[
          node({
            id: "leader-1",
            type: "leader",
            data: { status: "running", taskName: "Parent task" },
          }),
          node({
            id: "minion-1",
            type: "minion",
            data: { status: "waiting", leaderId: "leader-1" },
          }),
        ]}
        transform={TRANSFORM}
        visible={true}
      />,
    );

    expect(screen.getAllByText("Parent task")).toHaveLength(2);
  });

  it("falls back to Leader for a minion when the owner title is missing", () => {
    render(
      <NodeStatusOverlay
        nodes={[
          node({
            id: "minion-1",
            type: "minion",
            data: { status: "waiting", leaderId: "missing" },
          }),
        ]}
        transform={TRANSFORM}
        visible={true}
      />,
    );

    expect(screen.getByText("Leader")).toBeInTheDocument();
  });

  it("shows the status label text", () => {
    render(
      <NodeStatusOverlay
        nodes={[
          node({
            id: "leader-1",
            type: "leader",
            data: { status: "error", taskName: "Broken task" },
          }),
        ]}
        transform={TRANSFORM}
        visible={true}
      />,
    );

    expect(screen.getByText("ERROR")).toBeInTheDocument();
  });

  it("derives a leader's status from its work-item snapshot, not raw data.status", () => {
    // The LeaderNode header shows a work-item-snapshot-derived `displayStatus`.
    // When a snapshot is present the overlay must show the same value (1:1),
    // even if the raw `data.status` field lags behind.
    render(
      <NodeStatusOverlay
        nodes={[
          node({
            id: "leader-1",
            type: "leader",
            data: {
              status: "idle",
              taskName: "Canonical run",
              workItemSnapshot: workItem({
                lifecycle: {
                  runtimeState: "working", outcome: "none", resolution: "open",
                  changeMode: "live", integrationState: "live_clean", lifecycleRevision: 3,
                },
              }),
            },
          }),
        ]}
        transform={TRANSFORM}
        visible={true}
      />,
    );

    expect(screen.getByText("RUNNING")).toBeInTheDocument();
    expect(screen.queryByText("IDLE")).toBeNull();
  });

  it("falls back to raw data.status for a leader without a work-item snapshot", () => {
    render(
      <NodeStatusOverlay
        nodes={[
          node({
            id: "leader-1",
            type: "leader",
            data: { status: "running", taskName: "Bare session" },
          }),
        ]}
        transform={TRANSFORM}
        visible={true}
      />,
    );

    expect(screen.getByText("RUNNING")).toBeInTheDocument();
  });

  it("positions an item using the canvas transform", () => {
    render(
      <NodeStatusOverlay
        nodes={[
          node({
            id: "leader-1",
            type: "leader",
            position: { x: 120, y: 80 },
            size: { width: 400, height: 200 },
            data: { status: "idle" },
          }),
        ]}
        transform={{ x: 10, y: 15, scale: 0.25 }}
        visible={true}
      />,
    );

    const item = screen.getByTestId("node-status-overlay-item-leader-1");
    expect(item.style.left).toBe("40px");
    expect(item.style.top).toBe("35px");
    expect(item.style.width).toBe("100px");
    expect(item.style.height).toBe("50px");
  });
});
