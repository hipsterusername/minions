/**
 * ImageNode — content extractor (the context-protocol flattening),
 * empty-state rendering, and registered defaults. The AnnotationLayer
 * and MarkupToolbar have their own behavior tests colocated.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, beforeAll } from "vitest";
import { useState } from "react";

import {
  ImageNodeRenderer,
  extractImageNodeContent,
  createImageNodeDefaultData,
  type ImageNodeData,
} from "./ImageNode.tsx";
import type { CanvasNode, NodeRenderProps } from "../types.ts";
import type { Annotation } from "../components/AnnotationLayer.tsx";

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

function Probe({ initial }: { initial: ImageNodeData }) {
  const [data, setData] = useState<ImageNodeData>(initial);
  const node: CanvasNode = {
    id: "img-test",
    type: "image",
    position: { x: 0, y: 0 },
    size: { width: 480, height: 420 },
    data,
  };
  const props: NodeRenderProps = {
    node,
    isSelected: false,
    onUpdateData: (next) => setData(next as ImageNodeData),
  };
  return <ImageNodeRenderer {...props} />;
}

describe("ImageNode defaults", () => {
  it("createImageNodeDefaultData starts with no image and no annotations", () => {
    const data = createImageNodeDefaultData();
    expect(data.src).toBeNull();
    expect(data.annotations).toEqual([]);
    expect(data.selectedTool).toBe("pin");
    expect(typeof data.defaultColor).toBe("string");
  });
});

describe("ImageNode extractContent", () => {
  it("returns null when no image is present", () => {
    expect(extractImageNodeContent(createImageNodeDefaultData())).toBeNull();
  });

  it("renders a text block with filename, dimensions, and sorted numbered annotations", () => {
    const pin: Annotation = {
      id: "p1", kind: "pin", x: 0.2, y: 0.4, note: "Fix this button", color: "#000", order: 1,
    };
    const rect: Annotation = {
      id: "r1", kind: "rect", x: 0.1, y: 0.3, w: 0.4, h: 0.2, note: "Align with header", color: "#000", order: 2,
    };
    const data: ImageNodeData = {
      ...createImageNodeDefaultData(),
      src: "data:image/png;base64,xxxx",
      naturalWidth: 1600,
      naturalHeight: 900,
      filename: "mock.png",
      annotations: [rect, pin], // out of order — extractor sorts
    };
    const text = extractImageNodeContent(data);
    expect(text).toContain("[Image: mock.png, 1600×900]");
    expect(text).toContain("0–1 normalized");
    expect(text).toContain("1. Pin at (0.200, 0.400)");
    expect(text).toContain(`"Fix this button"`);
    expect(text).toContain("2. Rect from (0.100, 0.300) to (0.500, 0.500)");
    expect(text).toContain(`"Align with header"`);
    expect(text?.indexOf("1. Pin")).toBeLessThan(text!.indexOf("2. Rect"));
  });

  it("marks pins without notes as '(no note)'", () => {
    const data: ImageNodeData = {
      ...createImageNodeDefaultData(),
      src: "data:image/png;base64,xxxx",
      filename: "a.png",
      annotations: [
        { id: "p1", kind: "pin", x: 0, y: 0, note: "", color: "#000", order: 1 },
      ],
    };
    expect(extractImageNodeContent(data)).toContain("(no note)");
  });

  it("handles missing dimensions", () => {
    const data: ImageNodeData = {
      ...createImageNodeDefaultData(),
      src: "data:image/png;base64,xxxx",
      filename: "a.png",
    };
    const text = extractImageNodeContent(data);
    expect(text).toContain("unknown size");
  });
});

describe("ImageNode rendering", () => {
  it("shows the empty-state affordance when no src is set", () => {
    render(<Probe initial={createImageNodeDefaultData()} />);
    expect(
      screen.queryByText(/Drop an image, paste, or click to pick/i),
    ).not.toBeNull();
  });

  it("renders the image and toolbar once a src is set", () => {
    render(
      <Probe
        initial={{
          ...createImageNodeDefaultData(),
          src: "data:image/png;base64,xxxx",
          naturalWidth: 200,
          naturalHeight: 100,
          filename: "hello.png",
        }}
      />,
    );
    expect(screen.queryByAltText("hello.png")).not.toBeNull();
    expect(screen.queryByTestId("markup-toolbar")).not.toBeNull();
    expect(screen.queryByText("200×100")).not.toBeNull();
  });
});
