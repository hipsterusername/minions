/**
 * Tests for shared/render-artifacts.ts — schema parse + format helpers.
 */

import { describe, it, expect } from "vitest";
import {
  imageComponentSchema,
  filePreviewComponentSchema,
  htmlArtifactComponentSchema,
  formatImage,
  formatFilePreview,
  formatHtmlArtifact,
  toSafeEmbeddedRasterDataUrl,
  type ImageComponent,
  type FilePreviewComponent,
  type HtmlArtifactComponent,
} from "./render-artifacts.ts";

describe("embedded raster URL policy", () => {
  it("builds request-free raster URLs and rejects active image formats", () => {
    expect(toSafeEmbeddedRasterDataUrl("image/webp", "AA==")).toBe("data:image/webp;base64,AA==");
    expect(toSafeEmbeddedRasterDataUrl("image/svg+xml", "PHN2Zy8+")).toBeNull();
    expect(toSafeEmbeddedRasterDataUrl("text/html", "PGgxPng8L2gxPg==")).toBeNull();
  });
});

// ── imageComponentSchema ───────────────────────────────────

describe("imageComponentSchema", () => {
  it("parses a minimal valid image component", () => {
    const result = imageComponentSchema.safeParse({
      id: "img-1",
      type: "image",
      src: "data:image/png;base64,AA==",
      alt: "A photo",
    });
    expect(result.success).toBe(true);
  });

  it("parses all optional fields", () => {
    const result = imageComponentSchema.safeParse({
      id: "img-2",
      type: "image",
      src: "data:image/jpeg;base64,AA==",
      alt: "Local file",
      caption: "A caption",
      width: 800,
      height: 600,
      fit: "cover",
      span: "full",
    });
    expect(result.success).toBe(true);
  });

  it("accepts all fit values", () => {
    for (const fit of ["contain", "cover", "actual"] as const) {
      const result = imageComponentSchema.safeParse({
        id: "img-fit",
        type: "image",
        src: "data:image/png;base64,AA==",
        alt: "test",
        fit,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an unknown fit value", () => {
    const result = imageComponentSchema.safeParse({
      id: "img-3",
      type: "image",
      src: "data:image/png;base64,AA==",
      alt: "test",
      fit: "stretch",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required alt field", () => {
    const result = imageComponentSchema.safeParse({
      id: "img-4",
      type: "image",
      src: "data:image/png;base64,AA==",
    });
    expect(result.success).toBe(false);
  });

  it("rejects wrong type literal", () => {
    const result = imageComponentSchema.safeParse({
      id: "img-5",
      type: "photo",
      src: "data:image/png;base64,AA==",
      alt: "test",
    });
    expect(result.success).toBe(false);
  });

  it.each([
    "https://tracker.example/pixel.png",
    "file:///workspace/secret.png",
    "javascript:alert(1)",
    "data:image/svg+xml,<svg/>",
  ])("rejects unsafe model-generated source %s", (src) => {
    expect(imageComponentSchema.safeParse({ id: "unsafe", type: "image", src, alt: "x" }).success).toBe(false);
  });
});

// ── filePreviewComponentSchema ─────────────────────────────

describe("filePreviewComponentSchema", () => {
  it("parses a minimal path source", () => {
    const result = filePreviewComponentSchema.safeParse({
      id: "fp-1",
      type: "file-preview",
      source: { kind: "path", path: "/workspace/file.txt" },
    });
    expect(result.success).toBe(true);
  });

  it("parses an inline source with mime", () => {
    const result = filePreviewComponentSchema.safeParse({
      id: "fp-2",
      type: "file-preview",
      source: { kind: "inline", content: "hello", mime: "text/plain" },
    });
    expect(result.success).toBe(true);
  });

  it("parses an inline source without mime", () => {
    const result = filePreviewComponentSchema.safeParse({
      id: "fp-3",
      type: "file-preview",
      source: { kind: "inline", content: "data" },
    });
    expect(result.success).toBe(true);
  });

  it("parses all optional top-level fields", () => {
    const result = filePreviewComponentSchema.safeParse({
      id: "fp-4",
      type: "file-preview",
      source: { kind: "inline", content: '{"key":"val"}', mime: "application/json" },
      view: "json",
      maxBytes: 1024,
      actions: ["open", "download", "copy-path"],
      filename: "data.json",
      span: 2,
    });
    expect(result.success).toBe(true);
  });

  it("accepts all view enum values", () => {
    for (const view of ["auto", "text", "json", "csv", "image", "hex"] as const) {
      const result = filePreviewComponentSchema.safeParse({
        id: "fp-view",
        type: "file-preview",
        source: { kind: "inline", content: "x" },
        view,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an unknown source kind", () => {
    const result = filePreviewComponentSchema.safeParse({
      id: "fp-5",
      type: "file-preview",
      source: { kind: "url", href: "https://example.com/file.txt" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown view value", () => {
    const result = filePreviewComponentSchema.safeParse({
      id: "fp-6",
      type: "file-preview",
      source: { kind: "inline", content: "data" },
      view: "binary",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown action value", () => {
    const result = filePreviewComponentSchema.safeParse({
      id: "fp-7",
      type: "file-preview",
      source: { kind: "inline", content: "data" },
      actions: ["share"],
    });
    expect(result.success).toBe(false);
  });
});

// ── htmlArtifactComponentSchema ────────────────────────────

describe("htmlArtifactComponentSchema", () => {
  it("parses a minimal valid html-artifact component", () => {
    const result = htmlArtifactComponentSchema.safeParse({
      id: "html-1",
      type: "html-artifact",
      html: "<div>hello</div>",
    });
    expect(result.success).toBe(true);
  });

  it("parses all optional fields", () => {
    const result = htmlArtifactComponentSchema.safeParse({
      id: "html-2",
      type: "html-artifact",
      html: "<section><h1>Report</h1></section>",
      title: "Weekly report",
      height: 480,
      artifactId: "a1b2c3",
      span: "full",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing html field", () => {
    const result = htmlArtifactComponentSchema.safeParse({
      id: "html-3",
      type: "html-artifact",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-string html field", () => {
    const result = htmlArtifactComponentSchema.safeParse({
      id: "html-4",
      type: "html-artifact",
      html: { not: "a string" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a wrong type literal", () => {
    const result = htmlArtifactComponentSchema.safeParse({
      id: "html-5",
      type: "html",
      html: "<div></div>",
    });
    expect(result.success).toBe(false);
  });
});

// ── formatHtmlArtifact ─────────────────────────────────────

describe("formatHtmlArtifact", () => {
  it("summarizes with the title, byte count, and a visualization-only note", () => {
    const c: HtmlArtifactComponent = {
      id: "html-1",
      type: "html-artifact",
      html: "<div>hi</div>",
      title: "My chart",
    };
    const result = formatHtmlArtifact(c);
    expect(result).toContain("My chart");
    expect(result).toContain(`${c.html.length} bytes`);
    expect(result).toContain("visualization only");
  });

  it("falls back to a generic label when no title", () => {
    const c: HtmlArtifactComponent = {
      id: "html-2",
      type: "html-artifact",
      html: "<p>x</p>",
    };
    expect(formatHtmlArtifact(c)).toContain("HTML artifact");
  });

  it("does not inline the raw HTML markup", () => {
    const c: HtmlArtifactComponent = {
      id: "html-3",
      type: "html-artifact",
      html: "<strong>secret markup</strong>",
    };
    expect(formatHtmlArtifact(c)).not.toContain("<strong>");
  });
});

// ── formatImage ────────────────────────────────────────────

describe("formatImage", () => {
  it("produces a markdown image without caption", () => {
    const c: ImageComponent = {
      id: "img-1",
      type: "image",
      src: "data:image/png;base64,AA==",
      alt: "A photo",
    };
    expect(formatImage(c)).toBe("![A photo](data:image/png;base64,AA==)");
  });

  it("appends italic caption on next line when provided", () => {
    const c: ImageComponent = {
      id: "img-2",
      type: "image",
      src: "data:image/png;base64,AA==",
      alt: "Figure 1",
      caption: "Performance over time",
    };
    const result = formatImage(c);
    expect(result).toContain("![Figure 1](data:image/png;base64,AA==)");
    expect(result).toContain("\n*Performance over time*");
  });

  it("uses data: URI as-is", () => {
    const c: ImageComponent = {
      id: "img-3",
      type: "image",
      src: "data:image/png;base64,abc",
      alt: "embedded",
    };
    expect(formatImage(c)).toBe("![embedded](data:image/png;base64,abc)");
  });
});

// ── formatFilePreview ──────────────────────────────────────

describe("formatFilePreview", () => {
  it("formats a path source as a markdown link using the path", () => {
    const c: FilePreviewComponent = {
      id: "fp-1",
      type: "file-preview",
      source: { kind: "path", path: "/workspace/data.csv" },
    };
    const result = formatFilePreview(c);
    expect(result).toMatch(/^\[File:/);
    expect(result).toContain("/workspace/data.csv");
  });

  it("uses the filename override instead of path in the link label", () => {
    const c: FilePreviewComponent = {
      id: "fp-2",
      type: "file-preview",
      source: { kind: "path", path: "/var/tmp/abc123" },
      filename: "report.txt",
    };
    const result = formatFilePreview(c);
    expect(result).toContain("report.txt");
    expect(result).toContain("/var/tmp/abc123");
  });

  it("formats an inline source with byte count and mime", () => {
    const content = "hello world";
    const c: FilePreviewComponent = {
      id: "fp-3",
      type: "file-preview",
      source: { kind: "inline", content, mime: "text/plain" },
      filename: "notes.txt",
    };
    const result = formatFilePreview(c);
    expect(result).toContain("notes.txt");
    expect(result).toContain(`${content.length} bytes`);
    expect(result).toContain("text/plain");
  });

  it("falls back to 'inline content' label when no filename", () => {
    const c: FilePreviewComponent = {
      id: "fp-4",
      type: "file-preview",
      source: { kind: "inline", content: "raw data" },
    };
    expect(formatFilePreview(c)).toContain("inline content");
  });

  it("falls back to 'unknown type' when no mime", () => {
    const c: FilePreviewComponent = {
      id: "fp-5",
      type: "file-preview",
      source: { kind: "inline", content: "raw" },
    };
    expect(formatFilePreview(c)).toContain("unknown type");
  });
});
