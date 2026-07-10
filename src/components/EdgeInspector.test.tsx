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
