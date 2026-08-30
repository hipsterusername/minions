import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CanvasNode, NodeRenderProps } from "../types.ts";

vi.mock("../api.ts", () => ({
  getAuthToken: vi.fn().mockResolvedValue("test-token"),
}));

import { getNodeType } from "../node-registry.ts";
import "./FileViewerNode.tsx";

function renderFileViewer(content: string, filePath = "README.md") {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      content,
      size: content.length,
      truncated: false,
    }),
  });
  vi.stubGlobal("fetch", fetchMock);

  const Render = getNodeType("file-viewer")?.render;
  if (!Render) throw new Error("file-viewer node type was not registered");

  const node: CanvasNode = {
    id: "file-viewer-1",
    type: "file-viewer",
    position: { x: 0, y: 0 },
    size: { width: 480, height: 420 },
    data: { filePath, collapsed: false },
  };

  const props: NodeRenderProps = {
    node,
    isSelected: false,
    onUpdateData: vi.fn(),
    projectPath: "/workspace/project",
  };

  return {
    fetchMock,
    ...render(<Render {...props} />),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FileViewerNode markdown rendering", () => {
  it("renders markdown through React elements without injecting quote-based attributes", async () => {
    const payload = '[x](" onmouseover=alert(1))';
    const { container } = renderFileViewer(payload);

    await waitFor(() => {
      expect(screen.getByText(payload)).toBeInTheDocument();
    });

    expect(container.querySelector("[onmouseover]")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector(".file-viewer-markdown")).not.toBeNull();
  });

  it("treats javascript markdown links as text, not navigable anchors", async () => {
    const payload = "[run](javascript:alert(1))";
    const { container } = renderFileViewer(payload);

    await waitFor(() => {
      expect(screen.getByText(payload)).toBeInTheDocument();
    });

    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });

  it("still renders shared markdown block affordances", async () => {
    const content = [
      "# Heading",
      "",
      "- item",
      "> quote",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");
    const { container } = renderFileViewer(content);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Heading" })).toBeInTheDocument();
    });

    expect(container.querySelector(".md-list li")).toHaveTextContent("item");
    expect(container.querySelector(".md-blockquote")).toHaveTextContent("quote");
    expect(container.querySelector(".md-code-block code")).toHaveTextContent("const x = 1;");
  });
});
