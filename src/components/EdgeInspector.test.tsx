/**
 * Component tests for EdgeInspector's context-mode control.
 *
 * Covers:
 *   1. The mode control is absent unless a `contextMode` prop is supplied.
 *   2. When supplied, all three modes render and the current one is pressed.
 *   3. Clicking a different mode calls onChange with that mode.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EdgeInspector } from "./EdgeInspector.tsx";
import type { GraphEdge } from "../graph.ts";

const edge: GraphEdge = {
  id: "e1",
  sourceNodeId: "leader-a",
  sourcePortId: "context-out",
  targetNodeId: "leader-b",
  targetPortId: "context-in",
  protocol: "context",
};

function baseProps() {
  return {
    edge,
    screenX: 100,
    screenY: 100,
    sourceLabel: "leader",
    targetLabel: "leader",
    onDelete: vi.fn(),
    onFocusSource: vi.fn(),
    onFocusTarget: vi.fn(),
    onClose: vi.fn(),
  };
}

describe("EdgeInspector context-mode control", () => {
  it("does not render the mode control when contextMode is absent", () => {
    render(<EdgeInspector {...baseProps()} />);
    expect(screen.queryByTestId("edge-inspector-mode")).toBeNull();
  });

  it("renders all three modes and marks the current one pressed", () => {
    render(
      <EdgeInspector
        {...baseProps()}
        contextMode={{ current: "lean", onChange: vi.fn() }}
      />,
    );
    expect(screen.getByTestId("edge-inspector-mode")).toBeInTheDocument();
    expect(
      screen.getByTestId("edge-inspector-mode-dashboard"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("edge-inspector-mode-full")).toBeInTheDocument();

    const lean = screen.getByTestId("edge-inspector-mode-lean");
    expect(lean.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen
        .getByTestId("edge-inspector-mode-dashboard")
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("calls onChange with the clicked mode", () => {
    const onChange = vi.fn();
    render(
      <EdgeInspector
        {...baseProps()}
        contextMode={{ current: "dashboard", onChange }}
      />,
    );
    fireEvent.click(screen.getByTestId("edge-inspector-mode-full"));
    expect(onChange).toHaveBeenCalledWith("full");
  });
});

describe("EdgeInspector delivery status", () => {
  it("does not render a delivery row when staleness is absent", () => {
    render(<EdgeInspector {...baseProps()} />);
    expect(screen.queryByTestId("edge-inspector-delivery")).toBeNull();
  });

  it("shows an up-to-date status with the relative delivery time", () => {
    render(
      <EdgeInspector
        {...baseProps()}
        staleness={{
          stale: false,
          pendingBlocks: 0,
          deliveredAt: Date.now() - 3 * 60 * 1_000,
        }}
      />,
    );
    expect(screen.getByTestId("edge-inspector-delivery")).toHaveTextContent(
      "DeliveryUp to date · delivered 3m ago",
    );
  });

  it("shows the pending upstream turn count for a stale transcript", () => {
    render(
      <EdgeInspector
        {...baseProps()}
        staleness={{ stale: true, pendingBlocks: 2, deliveredAt: 1_000 }}
      />,
    );
    expect(screen.getByTestId("edge-inspector-delivery")).toHaveTextContent(
      "2 new turns upstream · sent with your next message",
    );
  });

  it("shows a generic changed-upstream status when no turn count applies", () => {
    render(
      <EdgeInspector
        {...baseProps()}
        staleness={{ stale: true, pendingBlocks: null, deliveredAt: 1_000 }}
      />,
    );
    expect(screen.getByTestId("edge-inspector-delivery")).toHaveTextContent(
      "Changed upstream · sent with your next message",
    );
  });

  it("prioritizes never-delivered status over a pending turn count", () => {
    render(
      <EdgeInspector
        {...baseProps()}
        staleness={{ stale: true, pendingBlocks: 2, deliveredAt: null }}
      />,
    );
    expect(screen.getByTestId("edge-inspector-delivery")).toHaveTextContent(
      "Not yet delivered · sent with your next message",
    );
  });
});
