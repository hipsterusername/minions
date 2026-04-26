/**
 * Pure-logic tests for the annotation rasterizer. The browser-side
 * canvas path (`rasterizeAnnotatedImage`) is intentionally NOT tested
 * here — jsdom doesn't implement canvas, and the equivalent path in
 * image-loader.ts also relies on browser trust. What we DO lock down:
 *
 *   1. `drawAnnotationOverlay` writes the right pixel-space calls for
 *      each annotation type — halo before mark, badge with the order
 *      number — so a future refactor doesn't silently break the visual
 *      contract the leader prompt now references.
 *   2. The fingerprint changes when geometry changes and stays the same
 *      when only ignored fields (note, color) move.
 *   3. The cache lookup returns null for non-empty annotations until a
 *      render is recorded against a matching fingerprint, so the
 *      attachment extractor's fallback path (raw src) is reachable.
 *   4. Empty annotations short-circuit `lookupRasterizedAnnotatedImage`
 *      to null — empty overlays must never round-trip through the
 *      cache.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  drawAnnotationOverlay,
  fingerprintAnnotations,
  lookupRasterizedAnnotatedImage,
  _resetRasterCacheForTests,
  type OverlayContext,
} from "./rasterize-annotations.ts";
import type { Annotation } from "../components/AnnotationLayer.tsx";

type CtxCall =
  | { op: "beginPath" }
  | { op: "arc"; x: number; y: number; r: number }
  | { op: "rect"; x: number; y: number; w: number; h: number }
  | { op: "stroke"; lineWidth: number; strokeStyle: string }
  | { op: "fill"; fillStyle: string }
  | { op: "fillText"; text: string; x: number; y: number; fillStyle: string }
  | { op: "font"; value: string };

function makeMockCtx(): { ctx: OverlayContext; calls: CtxCall[] } {
  const calls: CtxCall[] = [];
  const ctx: OverlayContext = {
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    font: "10px sans-serif",
    textBaseline: "alphabetic",
    textAlign: "start",
    beginPath() {
      calls.push({ op: "beginPath" });
    },
    arc(x, y, r) {
      calls.push({ op: "arc", x, y, r });
    },
    rect(x, y, w, h) {
      calls.push({ op: "rect", x, y, w, h });
    },
    stroke() {
      calls.push({ op: "stroke", lineWidth: this.lineWidth, strokeStyle: String(this.strokeStyle) });
    },
    fill() {
      calls.push({ op: "fill", fillStyle: String(this.fillStyle) });
    },
    fillText(text, x, y) {
      calls.push({ op: "fillText", text, x, y, fillStyle: String(this.fillStyle) });
    },
    measureText(text) {
      // Deterministic mock metrics: every glyph is 6px wide. Real canvas
      // metrics depend on the font; tests don't need that fidelity.
      return { width: text.length * 6 };
    },
  };
  // Capture every font assignment so layout regressions stand out.
  const proxy = new Proxy(ctx, {
    set(target, prop, value) {
      if (prop === "font") calls.push({ op: "font", value: String(value) });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (target as any)[prop] = value;
      return true;
    },
  });
  return { ctx: proxy, calls };
}

describe("drawAnnotationOverlay", () => {
  it("no-ops when annotations is empty", () => {
    const { ctx, calls } = makeMockCtx();
    drawAnnotationOverlay(ctx, [], 1000, 800);
    expect(calls).toEqual([]);
  });

  it("stamps a pin at the correct pixel coords with halo before mark", () => {
    const { ctx, calls } = makeMockCtx();
    const pin: Annotation = {
      id: "p1",
      kind: "pin",
      x: 0.5, // middle of 1000px = 500
      y: 0.25, // quarter of 800px = 200
      note: "ignored in raster",
      color: "#abcdef",
      order: 1,
    };
    drawAnnotationOverlay(ctx, [pin], 1000, 800);
    const arcs = calls.filter(
      (c): c is Extract<CtxCall, { op: "arc" }> => c.op === "arc",
    );
    expect(arcs.length).toBeGreaterThanOrEqual(2);
    expect(arcs[0]?.x).toBe(500);
    expect(arcs[0]?.y).toBe(200);
    expect(arcs[1]?.x).toBe(500);
    expect(arcs[1]?.y).toBe(200);

    // Halo (white, larger lineWidth) must precede mark (magenta, thinner).
    const strokes = calls.filter(
      (c): c is Extract<CtxCall, { op: "stroke" }> => c.op === "stroke",
    );
    const haloIdx = strokes.findIndex((s) => s.strokeStyle === "#ffffff");
    const markIdx = strokes.findIndex((s) => s.strokeStyle === "#ff00ff");
    expect(haloIdx).toBeGreaterThanOrEqual(0);
    expect(markIdx).toBeGreaterThanOrEqual(0);
    expect(haloIdx).toBeLessThan(markIdx);
    const haloWidth = strokes[haloIdx]?.lineWidth ?? 0;
    const markWidth = strokes[markIdx]?.lineWidth ?? 0;
    expect(haloWidth).toBeGreaterThan(markWidth);
  });

  it("renders the order number as a badge label", () => {
    const { ctx, calls } = makeMockCtx();
    const pin: Annotation = {
      id: "p7",
      kind: "pin",
      x: 0.1,
      y: 0.1,
      note: "",
      color: "#000",
      order: 7,
    };
    drawAnnotationOverlay(ctx, [pin], 800, 600);
    const labels = calls.filter(
      (c): c is Extract<CtxCall, { op: "fillText" }> => c.op === "fillText",
    );
    expect(labels.some((l) => l.text === "7")).toBe(true);
  });

  it("stamps a rect at correct pixel coords with badge anchored top-left", () => {
    const { ctx, calls } = makeMockCtx();
    const rect: Annotation = {
      id: "r1",
      kind: "rect",
      x: 0.1, // 100
      y: 0.2, // 160
      w: 0.3, // 300 wide
      h: 0.25, // 200 tall
      note: "",
      color: "#000",
      order: 3,
    };
    drawAnnotationOverlay(ctx, [rect], 1000, 800);
    const rects = calls.filter(
      (c): c is Extract<CtxCall, { op: "rect" }> => c.op === "rect",
    );
    // First two rect() calls are the halo + mark of the annotation
    // itself; the next pair are the badge box.
    expect(rects[0]).toMatchObject({ x: 100, y: 160, w: 300, h: 200 });
    expect(rects[1]).toMatchObject({ x: 100, y: 160, w: 300, h: 200 });
    // Badge sits at x=100 (top-left of rect), y above the rect.
    const badgeRect = rects[2];
    expect(badgeRect?.x).toBe(100);
    expect((badgeRect?.y ?? 999)).toBeLessThan(160);
    // Badge label "3" present.
    const labels = calls.filter(
      (c): c is Extract<CtxCall, { op: "fillText" }> => c.op === "fillText",
    );
    expect(labels.some((l) => l.text === "3")).toBe(true);
  });

  it("renders annotations sorted by order, regardless of array order", () => {
    const { ctx, calls } = makeMockCtx();
    const a: Annotation = {
      id: "p2", kind: "pin", x: 0.5, y: 0.5, note: "", color: "#000", order: 2,
    };
    const b: Annotation = {
      id: "p1", kind: "pin", x: 0.5, y: 0.5, note: "", color: "#000", order: 1,
    };
    drawAnnotationOverlay(ctx, [a, b], 200, 200);
    const labels = calls
      .filter((c): c is Extract<CtxCall, { op: "fillText" }> => c.op === "fillText")
      .map((l) => l.text);
    // The lower-order pin must be drawn first.
    expect(labels.indexOf("1")).toBeLessThan(labels.indexOf("2"));
  });

  it("scales mark sizes with image dimensions", () => {
    // Tiny image — small minDim should still produce a visible mark.
    const small = makeMockCtx();
    drawAnnotationOverlay(
      small.ctx,
      [{ id: "p", kind: "pin", x: 0.5, y: 0.5, note: "", color: "#000", order: 1 }],
      200,
      200,
    );
    const smallArc = small.calls.find(
      (c): c is Extract<CtxCall, { op: "arc" }> => c.op === "arc",
    );
    expect(smallArc?.r).toBeGreaterThanOrEqual(6);

    // Large image — radius should scale up. Use a min-dim well past
    // the 200px floor so the proportional term wins over the clamp.
    const large = makeMockCtx();
    drawAnnotationOverlay(
      large.ctx,
      [{ id: "p", kind: "pin", x: 0.5, y: 0.5, note: "", color: "#000", order: 1 }],
      2000,
      2000,
    );
    const largeArc = large.calls.find(
      (c): c is Extract<CtxCall, { op: "arc" }> => c.op === "arc",
    );
    expect(largeArc?.r ?? 0).toBeGreaterThan(smallArc?.r ?? 999);
  });
});

describe("fingerprintAnnotations", () => {
  it("returns '0' for empty input", () => {
    expect(fingerprintAnnotations([])).toBe("0");
  });

  it("changes when geometry changes", () => {
    const a: Annotation = {
      id: "p1", kind: "pin", x: 0.1, y: 0.1, note: "", color: "#000", order: 1,
    };
    const moved: Annotation = { ...a, x: 0.2 };
    expect(fingerprintAnnotations([a])).not.toBe(fingerprintAnnotations([moved]));
  });

  it("does NOT change when only note or color changes", () => {
    const a: Annotation = {
      id: "p1", kind: "pin", x: 0.1, y: 0.1, note: "first", color: "#000", order: 1,
    };
    const reworded: Annotation = { ...a, note: "second" };
    const recolored: Annotation = { ...a, color: "#fff" };
    expect(fingerprintAnnotations([a])).toBe(fingerprintAnnotations([reworded]));
    expect(fingerprintAnnotations([a])).toBe(fingerprintAnnotations([recolored]));
  });

  it("is stable across array reordering", () => {
    const a: Annotation = {
      id: "p1", kind: "pin", x: 0.1, y: 0.1, note: "", color: "#000", order: 1,
    };
    const b: Annotation = {
      id: "p2", kind: "pin", x: 0.5, y: 0.5, note: "", color: "#000", order: 2,
    };
    expect(fingerprintAnnotations([a, b])).toBe(fingerprintAnnotations([b, a]));
  });
});

describe("lookupRasterizedAnnotatedImage", () => {
  beforeEach(() => {
    _resetRasterCacheForTests();
  });

  it("returns null for empty annotations (no overlay needed)", () => {
    expect(lookupRasterizedAnnotatedImage("data:image/png;base64,xxx", [])).toBeNull();
  });

  it("returns null when nothing has been rasterized for src yet", () => {
    const a: Annotation = {
      id: "p1", kind: "pin", x: 0.1, y: 0.1, note: "", color: "#000", order: 1,
    };
    expect(
      lookupRasterizedAnnotatedImage("data:image/png;base64,xxx", [a]),
    ).toBeNull();
  });
});
