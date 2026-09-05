import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CanvasNodeComponent } from "./CanvasNode.tsx";
import { registerNodeType } from "./node-registry.ts";
import type { CanvasNode, NodeRenderProps } from "./types.ts";

registerNodeType({
  type: "leader",
  label: "Leader",
  defaultSize: { width: 240, height: 160 },
  render: ({
    onDuplicateLeaderSetup,
    onOpenSystemModel,
    onSaveLeaderPreset,
  }: NodeRenderProps) => (
    <div>
      <div data-testid="leader-body">Leader body</div>
      <input aria-label="Leader title" />
      <button onClick={onDuplicateLeaderSetup}>Duplicate</button>
      <button onClick={onOpenSystemModel}>Open system model</button>
      <button onClick={() => onSaveLeaderPreset?.({ name: "Saved leader" })}>
        Save preset
      </button>
    </div>
  ),
});

function renderNode(props: Partial<Parameters<typeof CanvasNodeComponent>[0]> = {}) {
  const node: CanvasNode = {
    id: "leader-1",
    type: "leader",
    position: { x: 20, y: 30 },
    size: { width: 240, height: 160 },
    data: {},
  };

  const baseProps: Parameters<typeof CanvasNodeComponent>[0] = {
    node,
    isSelected: false,
    onSelect: vi.fn(),
    onMove: vi.fn(),
    onUpdateData: vi.fn(),
    ...props,
  };

  return render(<CanvasNodeComponent {...baseProps} />);
}

describe("CanvasNodeComponent leader focusing", () => {
  it("only condenses after a drag threshold and restores the same live draft on drop", () => {
    const onDragStart = vi.fn();
    const onDragEnd = vi.fn();
    renderNode({ onDragStart, onDragEnd });
    const input = screen.getByLabelText("Leader title");
    fireEvent.change(input, { target: { value: "Unsent draft" } });
    const body = screen.getByTestId("leader-body");
    fireEvent.mouseDown(body, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 101, clientY: 101 });
    expect(screen.queryByRole("status")).toBeNull();
    expect(onDragStart).not.toHaveBeenCalled();
    fireEvent.mouseMove(window, { clientX: 120, clientY: 120 });
    expect(screen.getByRole("status")).toHaveTextContent("Release to place on canvas");
    expect(body).not.toBeVisible();
    expect(body.closest(".canvas-node-card")).toHaveStyle({ width: "240px", height: "160px" });
    expect(input).toBeInTheDocument();
    fireEvent.mouseUp(window, { clientX: 120, clientY: 120 });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByLabelText("Leader title")).toBe(input);
    expect(input).toBeVisible();
    expect(input).toHaveValue("Unsent draft");
    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(onDragEnd).toHaveBeenCalledTimes(1);
  });

  it.each(["Escape", "blur"])("cancels with %s and clears the card and document drag styles", cancellation => {
    const onMove = vi.fn();
    renderNode({ onMove, dragZoneName: "Release prep" });
    fireEvent.mouseDown(screen.getByTestId("leader-body"), { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 150, clientY: 170 });
    expect(screen.getByRole("status")).toHaveTextContent("Release into Release prep");
    if (cancellation === "Escape") fireEvent.keyDown(window, { key: "Escape" });
    else fireEvent.blur(window);
    expect(onMove).toHaveBeenLastCalledWith("leader-1", { x: 20, y: 30 }, true);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId("leader-body")).toBeVisible();
    expect(document.body.style.userSelect).not.toBe("none");
    expect(document.body.style.cursor).not.toBe("grabbing");
  });

  it("focuses a leader node on double-click", () => {
    const onFocusNode = vi.fn();
    renderNode({ onFocusNode });

    fireEvent.doubleClick(screen.getByTestId("leader-body"));

    expect(onFocusNode).toHaveBeenCalledTimes(1);
    expect(onFocusNode).toHaveBeenCalledWith("leader-1");
  });

  it("does not focus when double-clicking an interactive child", () => {
    const onFocusNode = vi.fn();
    renderNode({ onFocusNode });

    fireEvent.doubleClick(screen.getByLabelText("Leader title"));

    expect(onFocusNode).not.toHaveBeenCalled();
  });

  it("binds leader actions to the rendered node id", () => {
    const onDuplicateLeaderSetup = vi.fn();
    const onOpenSystemModel = vi.fn();
    const onSaveLeaderPreset = vi.fn(() => true);
    renderNode({
      onDuplicateLeaderSetup,
      onOpenSystemModel,
      onSaveLeaderPreset,
    });

    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    fireEvent.click(screen.getByRole("button", { name: "Open system model" }));
    fireEvent.click(screen.getByRole("button", { name: "Save preset" }));

    expect(onDuplicateLeaderSetup).toHaveBeenCalledWith("leader-1");
    expect(onOpenSystemModel).toHaveBeenCalledWith("leader-1");
    expect(onSaveLeaderPreset).toHaveBeenCalledWith("leader-1", {
      name: "Saved leader",
    });
  });
});
