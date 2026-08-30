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
