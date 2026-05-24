import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RenderNodeRenderer, type RenderNodeData } from "./RenderNode.tsx";
import type { CanvasNode, NodeRenderProps } from "../types.ts";

function Probe({
  data,
  onAddContentNode,
}: {
  data: RenderNodeData;
  onAddContentNode?: ((content: string) => void) | undefined;
}) {
  const node: CanvasNode = {
    id: "render-test",
    type: "render",
    position: { x: 0, y: 0 },
    size: { width: 500, height: 420 },
    data,
  };
  const props: NodeRenderProps = {
    node,
    isSelected: false,
    onUpdateData: () => {
      /* no-op */
    },
    onAddContentNode,
  };
  return <RenderNodeRenderer {...props} />;
}

function makeData(): RenderNodeData {
  return {
    leaderSessionKey: "leader-1",
    leaderId: "leader-node",
    renderState: {
      layout: { title: "Build Dashboard", columns: 2, gap: 12 },
      components: [
        {
          id: "metric-1",
          type: "metric",
          label: "Open issues",
          value: "12",
          detail: "3 critical",
        },
        {
          id: "table-1",
          type: "table",
          title: "Files",
          headers: ["Path", "Status"],
          rows: [["src/app.ts", "changed"]],
          span: "full",
        },
      ],
    },
  };
}

describe("RenderNode dashboard context selection", () => {
  it("copies selected component context using component-aware formatting", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<Probe data={makeData()} />);

    fireEvent.click(screen.getAllByTitle("Add component to context selection")[0]!);
    fireEvent.click(screen.getByTitle("Copy selected dashboard context"));

    expect(writeText).toHaveBeenCalledWith("**Open issues**: 12 — 3 critical");
  });

  it("adds selected dashboard context as a markdown node", () => {
    const onAddContentNode = vi.fn();

    render(<Probe data={makeData()} onAddContentNode={onAddContentNode} />);

    fireEvent.click(screen.getAllByTitle("Add component to context selection")[1]!);
    fireEvent.click(screen.getByTitle("Add selected dashboard context as node"));

    expect(onAddContentNode).toHaveBeenCalledWith(
      [
        "### Files",
        "| Path | Status |",
        "| --- | --- |",
        "| src/app.ts | changed |",
      ].join("\n"),
    );
  });

  it("copies the full dashboard context from selection mode", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<Probe data={makeData()} />);

    fireEvent.click(screen.getAllByTitle("Add component to context selection")[0]!);
    fireEvent.click(screen.getByTitle("Copy full dashboard context"));

    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("# Build Dashboard"),
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("| src/app.ts | changed |"),
    );
  });
});
