/**
 * ImageNode — content extractor (the context-protocol flattening),
 * empty-state rendering, and registered defaults. The AnnotationLayer
 * and AnnotationSidebar have their own behavior tests colocated.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, beforeAll, vi } from "vitest";
import { useState } from "react";

import {
  ImageNodeRenderer,
  extractImageNodeAttachments,
  extractImageNodeContent,
  createImageNodeDefaultData,
  type ImageNodeData,
} from "./ImageNode.tsx";
import type { CanvasNode, NodeRenderProps } from "../types.ts";
import type { Annotation } from "../components/AnnotationLayer.tsx";
import {
  _resetRasterCacheForTests,
  _seedRasterCacheForTests,
} from "./rasterize-annotations.ts";

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
  // jsdom reports zeros for getBoundingClientRect. The ImageNode's stage
  // sizer gates the annotation overlay on a real measurement, so stub
  // getBoundingClientRect to return a sensible fallback when the element
  // otherwise reports no size.
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    const r = original.call(this);
    if (r.width === 0 && r.height === 0) {
      return { x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 300, width: 400, height: 300, toJSON: () => "" } as DOMRect;
    }
    return r;
  };
  // jsdom also reports 0 for clientWidth/clientHeight on layout-less DOMs.
  // ImageNode now uses these (intentionally — they ignore CSS transforms,
  // unlike getBoundingClientRect, which is the canvas-zoom bug fix). Stub
  // them so the stage sizer sees a non-zero box in tests too.
  Object.defineProperty(Element.prototype, "clientWidth", {
    configurable: true,
    get(): number {
      const stub = (this as Element).getBoundingClientRect();
      return Math.round(stub.width);
    },
  });
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true,
    get(): number {
      const stub = (this as Element).getBoundingClientRect();
      return Math.round(stub.height);
    },
  });
  // jsdom doesn't implement pointer capture.
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function () {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = function () {};
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = function (): boolean { return false; };
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

describe("ImageNode extractAttachments", () => {
  /**
   * The attachment extractor is what actually carries image bytes to
   * the leader's first user turn. The contract: prefer a rasterized
   * (annotation-baked-in) render when one is cached for the current
   * geometry; fall back to the raw source otherwise. Annotations are
   * never silently dropped — at minimum the textual list still rides
   * via extractContent.
   */
  beforeAll(() => {
    _resetRasterCacheForTests();
  });

  it("returns null when no src is set", () => {
    expect(extractImageNodeAttachments(createImageNodeDefaultData())).toBeNull();
  });

  it("returns the raw source when there are no annotations", () => {
    const data: ImageNodeData = {
      ...createImageNodeDefaultData(),
      src: "data:image/png;base64,RAWPIXELS",
      naturalWidth: 100,
      naturalHeight: 100,
      filename: "shot.png",
    };
    const attachments = extractImageNodeAttachments(data);
    expect(attachments).not.toBeNull();
    expect(attachments).toHaveLength(1);
    expect(attachments?.[0]?.kind).toBe("image");
    expect(attachments?.[0]?.mediaType).toBe("image/png");
    expect(attachments?.[0]?.data).toBe("RAWPIXELS");
    expect(attachments?.[0]?.filename).toBe("shot.png");
  });

  it("falls back to the raw source when annotations exist but no raster is cached yet", () => {
    _resetRasterCacheForTests();
    const data: ImageNodeData = {
      ...createImageNodeDefaultData(),
      src: "data:image/png;base64,RAWPIXELS",
      naturalWidth: 100,
      naturalHeight: 100,
      annotations: [
        { id: "p1", kind: "pin", x: 0.5, y: 0.5, note: "x", color: "#000", order: 1 },
      ],
    };
    const attachments = extractImageNodeAttachments(data);
    // We sent SOMETHING — the extractor must never return null just
    // because the background rasterize hasn't completed yet.
    expect(attachments?.[0]?.data).toBe("RAWPIXELS");
  });

  it("uses the rasterized PNG bytes when a fresh render is cached", () => {
    _resetRasterCacheForTests();
    const annotations: Annotation[] = [
      { id: "p1", kind: "pin", x: 0.5, y: 0.5, note: "x", color: "#000", order: 1 },
    ];
    const src = "data:image/png;base64,RAWPIXELS";
    _seedRasterCacheForTests(src, annotations, "data:image/png;base64,WITHMARKS");
    const data: ImageNodeData = {
      ...createImageNodeDefaultData(),
      src,
      naturalWidth: 100,
      naturalHeight: 100,
      annotations,
    };
    const attachments = extractImageNodeAttachments(data);
    expect(attachments?.[0]?.data).toBe("WITHMARKS");
  });

  it("falls back when annotations have changed since the cached render", () => {
    _resetRasterCacheForTests();
    const cached: Annotation[] = [
      { id: "p1", kind: "pin", x: 0.5, y: 0.5, note: "", color: "#000", order: 1 },
    ];
    const src = "data:image/png;base64,RAWPIXELS";
    _seedRasterCacheForTests(src, cached, "data:image/png;base64,STALE");

    // User has since added a second pin — fingerprint no longer matches,
    // lookup must return null and the extractor falls back.
    const updated: Annotation[] = [
      ...cached,
      { id: "p2", kind: "pin", x: 0.1, y: 0.1, note: "", color: "#000", order: 2 },
    ];
    const data: ImageNodeData = {
      ...createImageNodeDefaultData(),
      src,
      naturalWidth: 100,
      naturalHeight: 100,
      annotations: updated,
    };
    const attachments = extractImageNodeAttachments(data);
    expect(attachments?.[0]?.data).toBe("RAWPIXELS");
  });
});

describe("ImageNode rendering", () => {
  it("shows the empty-state affordance when no src is set", () => {
    render(<Probe initial={createImageNodeDefaultData()} />);
    // Headline + the three input methods live in the empty state.
    expect(screen.queryByText(/Add an image/i)).not.toBeNull();
    expect(screen.queryByText(/drop/i)).not.toBeNull();
    expect(screen.queryByText(/paste/i)).not.toBeNull();
    expect(screen.queryByText(/click to pick/i)).not.toBeNull();
  });

  it("renders the image and sidebar once a src is set", () => {
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
    expect(screen.queryByTestId("annotation-sidebar")).not.toBeNull();
    expect(screen.queryByText("200×100")).not.toBeNull();
  });

  it("renders the image stage and the sidebar side-by-side (row flex)", () => {
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
    const body = screen.getByTestId("image-node-body");
    expect(body.getAttribute("style")).toMatch(/flex-direction:\s*row/);
    // Stage flexes, sidebar has fixed width.
    expect(screen.getByTestId("image-stage").getAttribute("style")).toMatch(/flex:\s*1/);
  });
});

describe("ImageNode drag gesture", () => {
  /**
   * The outer Canvas starts node drags from a mousedown listener on a parent
   * wrapper. If ImageNode stops propagation, drag is silently broken. These
   * tests lock in the contract:
   *
   *   - mousedown on the node root must bubble so CanvasNode can pick it up.
   *   - the AnnotationLayer and AnnotationSidebar carry `data-no-drag` so their
   *     own gestures don't double-fire as a node-drag.
   */
  function renderWithParentListener(initial: ImageNodeData) {
    const handler = vi.fn();
    const utils = render(
      <div data-testid="parent" onMouseDown={handler}>
        <Probe initial={initial} />
      </div>,
    );
    return { handler, ...utils };
  }

  it("mousedown on the image-node root bubbles to the canvas drag wrapper", () => {
    const { handler } = renderWithParentListener(createImageNodeDefaultData());
    const node = screen.getByTestId("image-node");
    fireEvent.mouseDown(node, { button: 0 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("sidebar and annotation layer opt out of drag via data-no-drag", () => {
    renderWithParentListener({
      ...createImageNodeDefaultData(),
      src: "data:image/png;base64,xxxx",
      naturalWidth: 200,
      naturalHeight: 100,
      filename: "hello.png",
    });
    expect(screen.getByTestId("annotation-sidebar").hasAttribute("data-no-drag")).toBe(true);
    expect(screen.getByTestId("annotation-layer").hasAttribute("data-no-drag")).toBe(true);
  });

  it("uses the defined --border-default token, not the phantom --border-subtle", () => {
    renderWithParentListener(createImageNodeDefaultData());
    const node = screen.getByTestId("image-node");
    // Inline style references resolve to the raw CSS string — we only need
    // to verify we're not reaching for a token that was never defined.
    expect(node.getAttribute("style")).toContain("--border-default");
    expect(node.getAttribute("style")).not.toContain("--border-subtle");
  });
});

describe("ImageNode annotation overlay", () => {
  /**
   * The AnnotationLayer used to span the full flex container, so clicks
   * near the image (but on the letterbox) created pins that appeared
   * floating off the image — users read this as "nothing is applying".
   * The overlay must sit exactly on the rendered image box.
   */
  it("positions the annotation overlay using object-fit:contain math", () => {
    // 400×300 stage (from the beforeAll stub) + 200×100 image =>
    // image is wider (2:1) than stage (4:3), so the overlay is constrained
    // by width: 400×200, letterboxed 50px top/bottom.
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
    const overlay = screen.getByTestId("annotation-overlay");
    const style = overlay.getAttribute("style") ?? "";
    // width === stage width (400), height === 400 / (200/100) = 200.
    expect(style).toMatch(/width:\s*400px/);
    expect(style).toMatch(/height:\s*200px/);
    // Letterbox top = (300 - 200) / 2 = 50.
    expect(style).toMatch(/top:\s*50px/);
    expect(style).toMatch(/left:\s*0px/);
  });

  it("nests <img> and AnnotationLayer in the SAME overlay box for structural alignment", () => {
    // Regression: pinnable area drifted from the visible image whenever
    // the <img> and the SVG were independently sized — sub-pixel
    // rounding, canvas zoom, and the previous max-width-only sizing all
    // produced subtle but real mismatches. The fix puts both children
    // inside one parent sized to imgBox; they cannot disagree.
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
    const overlay = screen.getByTestId("annotation-overlay");
    const img = screen.getByAltText("hello.png");
    const layer = screen.getByTestId("annotation-layer");
    // Both children must live inside the overlay; the overlay's pixel
    // bounds therefore double as the rendered-image bounds.
    expect(overlay.contains(img)).toBe(true);
    expect(overlay.contains(layer)).toBe(true);
    // The img fills the overlay AND uses object-fit:contain — the
    // overlay aspect already matches the image's natural aspect, so
    // contain is a no-op visually, but it is a hard guarantee that the
    // image content can NEVER exceed the overlay's pixel bounds.
    const imgStyle = img.getAttribute("style") ?? "";
    expect(imgStyle).toMatch(/width:\s*100%/);
    expect(imgStyle).toMatch(/height:\s*100%/);
    expect(imgStyle).toMatch(/object-fit:\s*contain/);
    // No more legacy max-width/max-height-only sizing.
    expect(imgStyle).not.toMatch(/max-width:\s*100%/);
    expect(imgStyle).not.toMatch(/max-height:\s*100%/);
    // The overlay clips its content so nothing can leak into the rest
    // of the node, even at sub-pixel rounding edges.
    const overlayStyle = overlay.getAttribute("style") ?? "";
    expect(overlayStyle).toMatch(/overflow:\s*hidden/);
  });

  it("clicking at the very top edge of the overlay places a pin at y=0", () => {
    // The user-reported bug: pins couldn't be placed at the top of an
    // image because the pinnable region was misaligned from the visible
    // image. With the structural fix (img and SVG nested in one overlay
    // box) a click at the overlay's top-left ought to land at exactly
    // (0, 0) in normalized coords.
    function HarnessTop() {
      const [data, setData] = useState<ImageNodeData>({
        ...createImageNodeDefaultData(),
        src: "data:image/png;base64,xxxx",
        naturalWidth: 200,
        naturalHeight: 100,
        filename: "hello.png",
      });
      const node: CanvasNode = {
        id: "img-test",
        type: "image",
        position: { x: 0, y: 0 },
        size: { width: 480, height: 420 },
        data,
      };
      return (
        <>
          <ImageNodeRenderer
            node={node}
            isSelected={false}
            onUpdateData={(next) => setData(next as ImageNodeData)}
          />
          <span data-testid="pins">
            {data.annotations.map((a) => `${a.x.toFixed(2)},${a.y.toFixed(2)}`).join("|")}
          </span>
        </>
      );
    }
    render(<HarnessTop />);
    const layer = screen.getByTestId("annotation-layer");
    vi.spyOn(layer, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200,
      x: 0, y: 0, toJSON: () => "",
    } as DOMRect);
    act(() => {
      // Click at the very top-left corner of the overlay.
      fireEvent.pointerDown(layer, { clientX: 0, clientY: 0, pointerId: 1 });
    });
    expect(screen.getByTestId("pins").textContent).toBe("0.00,0.00");
  });

  it("clicking inside the overlay with the pin tool creates a pin (integration)", () => {
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
    const layer = screen.getByTestId("annotation-layer");
    // Stub the SVG's bounding rect so normalized-coord math is deterministic.
    vi.spyOn(layer, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200,
      x: 0, y: 0, toJSON: () => "",
    } as DOMRect);
    act(() => {
      fireEvent.pointerDown(layer, { clientX: 100, clientY: 50, pointerId: 1 });
    });
    // After one pin is created, the toolbar should advertise "1 mark".
    expect(screen.queryByText(/1 mark/i)).not.toBeNull();
  });

  it("uses the stage's unscaled clientWidth/clientHeight, not getBoundingClientRect", () => {
    // Regression: the canvas applies a CSS transform for zoom, which makes
    // getBoundingClientRect return scaled-up/scaled-down values. The
    // imgBox calc fed those numbers into CSS top/left/width/height, so the
    // overlay drifted off the actual image whenever the user zoomed —
    // pinnable area appeared misaligned and bigger/smaller than the image.
    // Reading clientWidth/clientHeight (layout pixels, unaffected by CSS
    // transforms) keeps the overlay locked to the image at any zoom.
    const stageGets: { gbcr: number; client: number } = { gbcr: 0, client: 0 };
    const realGBCR = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      const el = this as Element;
      if (el.getAttribute && el.getAttribute("data-testid") === "image-stage") {
        stageGets.gbcr += 1;
      }
      const r = realGBCR.call(el);
      if (r.width === 0 && r.height === 0) {
        return { x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 300, width: 400, height: 300, toJSON: () => "" } as DOMRect;
      }
      return r;
    };
    const realCW = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!;
    Object.defineProperty(Element.prototype, "clientWidth", {
      configurable: true,
      get(): number {
        const el = this as Element;
        if (el.getAttribute && el.getAttribute("data-testid") === "image-stage") {
          stageGets.client += 1;
        }
        return realCW.get!.call(el);
      },
    });

    try {
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
      // Overlay must still position correctly — i.e. the stage size came
      // from a non-zero source.
      const overlay = screen.getByTestId("annotation-overlay");
      expect(overlay.getAttribute("style")).toMatch(/width:\s*400px/);
      // The stage sizer must read clientWidth at least once. Reading
      // getBoundingClientRect on the stage *for sizing* would re-introduce
      // the zoom drift bug.
      expect(stageGets.client).toBeGreaterThan(0);
    } finally {
      Element.prototype.getBoundingClientRect = realGBCR;
      Object.defineProperty(Element.prototype, "clientWidth", realCW);
    }
  });

  it("does not render the overlay before natural dimensions are known", () => {
    render(
      <Probe
        initial={{
          ...createImageNodeDefaultData(),
          src: "data:image/png;base64,xxxx",
          // naturalWidth/Height intentionally omitted
          filename: "pending.png",
        }}
      />,
    );
    expect(screen.queryByTestId("annotation-overlay")).toBeNull();
    expect(screen.queryByTestId("annotation-layer")).toBeNull();
  });
});

describe("ImageNode clear-all", () => {
  it("Clear requires two clicks to fire and preserves the image", () => {
    const data: ImageNodeData = {
      ...createImageNodeDefaultData(),
      src: "data:image/png;base64,xxxx",
      naturalWidth: 200,
      naturalHeight: 100,
      filename: "hello.png",
      annotations: [
        { id: "p1", kind: "pin", x: 0.2, y: 0.4, note: "", color: "#f00", order: 1 },
        { id: "p2", kind: "pin", x: 0.8, y: 0.6, note: "", color: "#0f0", order: 2 },
      ],
    };
    render(<Probe initial={data} />);
    const clearBtn = screen.getByRole("button", { name: /clear all annotations/i });
    expect(clearBtn).not.toBeNull();
    expect(screen.queryByAltText("hello.png")).not.toBeNull();

    // First click arms but does not wipe.
    fireEvent.click(clearBtn);
    expect(screen.queryByText(/2 marks/i)).not.toBeNull();
    expect(screen.queryByRole("button", { name: /confirm clear all annotations/i })).not.toBeNull();

    // Second click fires.
    fireEvent.click(
      screen.getByRole("button", { name: /confirm clear all annotations/i }),
    );
    expect(screen.queryByRole("button", { name: /clear all annotations/i })).toBeNull();
    expect(screen.queryByAltText("hello.png")).not.toBeNull();
    expect(screen.queryByText(/no marks/i)).not.toBeNull();
  });

  it("Clear button is not rendered when there are no annotations", () => {
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
    expect(screen.queryByRole("button", { name: /clear all annotations/i })).toBeNull();
  });
});

describe("ImageNode multi-mark editing", () => {
  function makeData(annotations: Annotation[], selectedId: string | null = null): ImageNodeData {
    return {
      ...createImageNodeDefaultData(),
      src: "data:image/png;base64,xxxx",
      naturalWidth: 200,
      naturalHeight: 100,
      filename: "hello.png",
      selectedTool: "pin",
      annotations,
      selectedAnnotationId: selectedId,
    };
  }

  it("palette click recolours the selected annotation, not the defaultColor", () => {
    const pin: Annotation = {
      id: "p1", kind: "pin", x: 0.3, y: 0.3, note: "", color: "#111111", order: 1,
    };
    // Render with pin selected
    function Harness() {
      const [data, setData] = useState<ImageNodeData>(makeData([pin], "p1"));
      const node: CanvasNode = {
        id: "img-test", type: "image", position: { x: 0, y: 0 },
        size: { width: 480, height: 420 }, data,
      };
      return (
        <>
          <ImageNodeRenderer
            node={node}
            isSelected={false}
            onUpdateData={(next) => setData(next as ImageNodeData)}
          />
          <span data-testid="pin-color">{(data.annotations[0] as Annotation).color}</span>
          <span data-testid="default-color">{data.defaultColor ?? ""}</span>
        </>
      );
    }
    render(<Harness />);
    const red = screen.getByLabelText("Red");
    const prevDefault = screen.getByTestId("default-color").textContent;
    fireEvent.click(red);
    // Selected pin's color updated.
    expect(screen.getByTestId("pin-color").textContent).toBe("#ef4444");
    // Default color untouched.
    expect(screen.getByTestId("default-color").textContent).toBe(prevDefault);
  });

  it("palette click sets defaultColor when no annotation is selected", () => {
    function Harness() {
      const [data, setData] = useState<ImageNodeData>(makeData([]));
      const node: CanvasNode = {
        id: "img-test", type: "image", position: { x: 0, y: 0 },
        size: { width: 480, height: 420 }, data,
      };
      return (
        <>
          <ImageNodeRenderer
            node={node}
            isSelected={false}
            onUpdateData={(next) => setData(next as ImageNodeData)}
          />
          <span data-testid="default-color">{data.defaultColor ?? ""}</span>
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByLabelText("Amber"));
    expect(screen.getByTestId("default-color").textContent).toBe("#f59e0b");
  });

  it("deleting one of several annotations does NOT renumber the rest", () => {
    const pins: Annotation[] = [
      { id: "p1", kind: "pin", x: 0.1, y: 0.1, note: "", color: "#000", order: 1 },
      { id: "p2", kind: "pin", x: 0.2, y: 0.2, note: "", color: "#000", order: 2 },
      { id: "p3", kind: "pin", x: 0.3, y: 0.3, note: "", color: "#000", order: 3 },
    ];
    function Harness() {
      const [data, setData] = useState<ImageNodeData>(makeData(pins));
      const node: CanvasNode = {
        id: "img-test", type: "image", position: { x: 0, y: 0 },
        size: { width: 480, height: 420 }, data,
      };
      return (
        <>
          <ImageNodeRenderer
            node={node}
            isSelected={false}
            onUpdateData={(next) => setData(next as ImageNodeData)}
          />
          <span data-testid="orders">
            {data.annotations.map((a) => a.order).join(",")}
          </span>
        </>
      );
    }
    render(<Harness />);
    // Click the row for p2 to select, then delete via the row's × button.
    fireEvent.click(screen.getByLabelText("Delete pin 2"));
    // Remaining marks keep their original labels (1 and 3), not 1 and 2.
    expect(screen.getByTestId("orders").textContent).toBe("1,3");
  });

  it("renders the annotation list with one row per mark", () => {
    const anns: Annotation[] = [
      { id: "p1", kind: "pin", x: 0.1, y: 0.1, note: "click target", color: "#000", order: 1 },
      { id: "r1", kind: "rect", x: 0.2, y: 0.2, w: 0.3, h: 0.3, note: "", color: "#111", order: 2 },
    ];
    render(<Probe initial={makeData(anns)} />);
    const list = screen.getByTestId("annotation-list");
    expect(list).not.toBeNull();
    expect(screen.queryByTestId("annotation-row-p1")).not.toBeNull();
    expect(screen.queryByTestId("annotation-row-r1")).not.toBeNull();
    expect(screen.queryByText("click target")).not.toBeNull();
    expect(screen.queryByText("(unnamed rect)")).not.toBeNull();
  });

  it("clicking a list row selects that annotation", () => {
    const anns: Annotation[] = [
      { id: "p1", kind: "pin", x: 0.1, y: 0.1, note: "", color: "#000", order: 1 },
      { id: "p2", kind: "pin", x: 0.2, y: 0.2, note: "", color: "#000", order: 2 },
    ];
    function Harness() {
      const [data, setData] = useState<ImageNodeData>(makeData(anns));
      const node: CanvasNode = {
        id: "img-test", type: "image", position: { x: 0, y: 0 },
        size: { width: 480, height: 420 }, data,
      };
      return (
        <>
          <ImageNodeRenderer
            node={node}
            isSelected={false}
            onUpdateData={(next) => setData(next as ImageNodeData)}
          />
          <span data-testid="selected-id">{data.selectedAnnotationId ?? ""}</span>
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByTestId("annotation-row-p2"));
    expect(screen.getByTestId("selected-id").textContent).toBe("p2");
  });
});
