/**
 * Dashboard grid layout tests for `gridColumnFor`.
 *
 * The dashboard packs components into a `columns`-wide CSS grid. Some
 * component types are intrinsically full-width and must span every column
 * (`gridColumn: "1 / -1"`) so they fill the horizontal space instead of
 * being squeezed into a single narrow column.
 *
 * Regression: `html-artifact` (the `publish_html` sandboxed iframe) was
 * missing from the full-width set, so it rendered in a single column at
 * half width — wasting horizontal space and squishing the fixed-height
 * iframe into a poor aspect ratio. Its sibling artifact types (`image`,
 * `file-preview`) were already full-width; this pins that `html-artifact`
 * joins them.
 */

import { describe, it, expect } from "vitest";
import { gridColumnFor } from "./RenderNode.tsx";
import type { RenderComponent } from "../../shared/render-dsl.ts";

const COLUMNS = 2;

describe("gridColumnFor — full-width artifact components", () => {
  it("spans an html-artifact across all columns", () => {
    const c: RenderComponent = {
      id: "viz",
      type: "html-artifact",
      html: "<p>ok</p>",
    };
    expect(gridColumnFor(c, COLUMNS)).toBe("1 / -1");
  });

  it("spans image and file-preview artifacts across all columns", () => {
    const image: RenderComponent = {
      id: "img",
      type: "image",
      src: "data:image/png;base64,AA==",
      alt: "x",
    };
    const filePreview: RenderComponent = {
      id: "fp",
      type: "file-preview",
      source: { kind: "inline", content: "hi" },
    };
    expect(gridColumnFor(image, COLUMNS)).toBe("1 / -1");
    expect(gridColumnFor(filePreview, COLUMNS)).toBe("1 / -1");
  });

  it("leaves a plain metric to auto-placement (not full width)", () => {
    const metric: RenderComponent = {
      id: "m",
      type: "metric",
      label: "Count",
      value: "3",
    };
    expect(gridColumnFor(metric, COLUMNS)).toBeUndefined();
  });

  it("honors an explicit narrow span override on an html-artifact", () => {
    const c: RenderComponent = {
      id: "viz",
      type: "html-artifact",
      html: "<p>ok</p>",
      span: 1,
    };
    // span (1) < columns (2) and not >= columns, so not forced full-width.
    expect(gridColumnFor(c, COLUMNS)).toBeUndefined();
  });
});
