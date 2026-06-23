import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CanvasNodeComponent } from "./CanvasNode.tsx";
import { registerNodeType } from "./node-registry.ts";
import type { CanvasNode } from "./types.ts";

registerNodeType({
  type: "leader",
  label: "Leader",
  defaultSize: { width: 240, height: 160 },
  render: () => (
    <div>
      <div data-testid="leader-body">Leader body</div>
      <input aria-label="Leader title" />
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
});
