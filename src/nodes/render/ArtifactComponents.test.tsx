/**
 * Component tests for ImageRenderer and FilePreviewRenderer.
 *
 * Tests behavior at the component boundary: DOM structure, user interactions,
 * and edge-case rendering. No snapshot tests — we query by role/text.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, beforeAll } from "vitest";

import { ImageRenderer, FilePreviewRenderer } from "./ArtifactComponents.tsx";
import type { ImageComponent, FilePreviewComponent } from "../../../shared/render-artifacts.ts";

// jsdom doesn't ship ResizeObserver; provide a no-op so any child that
// uses it doesn't blow up.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

// ── ImageRenderer ─────────────────────────────────────────

describe("ImageRenderer", () => {
  const baseImage: ImageComponent = {
    id: "img-1",
    type: "image",
    src: "https://example.com/photo.jpg",
    alt: "Test photo",
  };

  it("renders an img tag with the correct src and alt", () => {
    render(<ImageRenderer c={baseImage} />);
    const img = screen.getAllByRole("img")[0];
    expect(img).toHaveAttribute("src", "https://example.com/photo.jpg");
    expect(img).toHaveAttribute("alt", "Test photo");
  });

  it("adds loading=lazy to the img", () => {
    render(<ImageRenderer c={baseImage} />);
    const img = screen.getAllByRole("img")[0];
    expect(img).toHaveAttribute("loading", "lazy");
  });

  it("renders caption text when provided", () => {
    const c: ImageComponent = { ...baseImage, caption: "Figure 1: Results" };
    render(<ImageRenderer c={c} />);
    expect(screen.getByText("Figure 1: Results")).toBeInTheDocument();
  });

  it("does not render a caption element when caption is absent", () => {
    render(<ImageRenderer c={baseImage} />);
    expect(screen.queryByText(/Figure/)).not.toBeInTheDocument();
  });

  it("opens a lightbox dialog when the image button is clicked", () => {
    render(<ImageRenderer c={baseImage} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const btn = screen.getByRole("button", { name: /open image lightbox/i });
    fireEvent.click(btn);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes the lightbox when Escape is pressed", () => {
    render(<ImageRenderer c={baseImage} />);
    const btn = screen.getByRole("button", { name: /open image lightbox/i });
    fireEvent.click(btn);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the lightbox when the overlay is clicked", () => {
    render(<ImageRenderer c={baseImage} />);
    fireEvent.click(screen.getByRole("button", { name: /open image lightbox/i }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();

    fireEvent.click(dialog);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

// ── FilePreviewRenderer — inline JSON ────────────────────

describe("FilePreviewRenderer: inline JSON", () => {
  const jsonComponent: FilePreviewComponent = {
    id: "fp-json",
    type: "file-preview",
    source: {
      kind: "inline",
      content: '{"name":"Alice","age":30,"active":true}',
      mime: "application/json",
    },
    filename: "user.json",
    view: "json",
    actions: [],
  };

  it("renders the JSON object keys", () => {
    render(<FilePreviewRenderer c={jsonComponent} />);
    expect(screen.getByText("name")).toBeInTheDocument();
    expect(screen.getByText("age")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("renders JSON string values", () => {
    render(<FilePreviewRenderer c={jsonComponent} />);
    expect(screen.getByText('"Alice"')).toBeInTheDocument();
  });

  it("shows the filename in the header", () => {
    render(<FilePreviewRenderer c={jsonComponent} />);
    expect(screen.getByText("user.json")).toBeInTheDocument();
  });

  it("shows Invalid JSON message for malformed input", () => {
    const bad: FilePreviewComponent = {
      id: "fp-bad",
      type: "file-preview",
      source: { kind: "inline", content: "{not: valid json}", mime: "application/json" },
      view: "json",
      actions: [],
    };
    render(<FilePreviewRenderer c={bad} />);
    expect(screen.getByText("Invalid JSON")).toBeInTheDocument();
  });
});

// ── FilePreviewRenderer — inline CSV ─────────────────────

describe("FilePreviewRenderer: inline CSV", () => {
  const csvContent = "Name,Age,City\nAlice,30,NYC\nBob,25,LA\nCarol,35,Chicago";
  const csvComponent: FilePreviewComponent = {
    id: "fp-csv",
    type: "file-preview",
    source: { kind: "inline", content: csvContent, mime: "text/csv" },
    filename: "people.csv",
    view: "csv",
    actions: [],
  };

  it("renders a table element", () => {
    render(<FilePreviewRenderer c={csvComponent} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("renders the header row columns", () => {
    render(<FilePreviewRenderer c={csvComponent} />);
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Age" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "City" })).toBeInTheDocument();
  });

  it("renders data rows", () => {
    render(<FilePreviewRenderer c={csvComponent} />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("NYC")).toBeInTheDocument();
  });

  it("auto-detects CSV from .csv filename", () => {
    const autoComponent: FilePreviewComponent = {
      id: "fp-csv-auto",
      type: "file-preview",
      source: { kind: "inline", content: "A,B\n1,2" },
      filename: "data.csv",
      actions: [],
    };
    render(<FilePreviewRenderer c={autoComponent} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
  });
});

// ── FilePreviewRenderer — inline text with maxBytes ───────

describe("FilePreviewRenderer: inline text with maxBytes truncation", () => {
  it("shows the truncation banner when content exceeds maxBytes", () => {
    const content = "A".repeat(200);
    const c: FilePreviewComponent = {
      id: "fp-trunc",
      type: "file-preview",
      source: { kind: "inline", content, mime: "text/plain" },
      view: "text",
      maxBytes: 100,
      actions: [],
    };
    render(<FilePreviewRenderer c={c} />);
    expect(screen.getByText(/Truncated at 100 bytes/)).toBeInTheDocument();
  });

  it("does not show the banner when content is within maxBytes", () => {
    const c: FilePreviewComponent = {
      id: "fp-no-trunc",
      type: "file-preview",
      source: { kind: "inline", content: "short text", mime: "text/plain" },
      view: "text",
      maxBytes: 1000,
      actions: [],
    };
    render(<FilePreviewRenderer c={c} />);
    expect(screen.queryByText(/Truncated/)).not.toBeInTheDocument();
  });

  it("does not show the banner when no maxBytes is set", () => {
    const c: FilePreviewComponent = {
      id: "fp-no-cap",
      type: "file-preview",
      source: { kind: "inline", content: "some text", mime: "text/plain" },
      view: "text",
      actions: [],
    };
    render(<FilePreviewRenderer c={c} />);
    expect(screen.queryByText(/Truncated/)).not.toBeInTheDocument();
  });

  it("renders truncated text (only the first maxBytes characters)", () => {
    const c: FilePreviewComponent = {
      id: "fp-trunc-text",
      type: "file-preview",
      source: { kind: "inline", content: "HELLO WORLD END", mime: "text/plain" },
      view: "text",
      maxBytes: 5,
      actions: [],
    };
    render(<FilePreviewRenderer c={c} />);
    // Only "HELLO" should be rendered in the pre block, not "WORLD"
    const pre = document.querySelector("pre");
    expect(pre?.textContent).toBe("HELLO");
  });
});

// ── FilePreviewRenderer — path source ────────────────────

describe("FilePreviewRenderer: path source placeholder", () => {
  const pathComponent: FilePreviewComponent = {
    id: "fp-path",
    type: "file-preview",
    source: { kind: "path", path: "/var/data/results.csv" },
    filename: "results.csv",
  };

  it("renders the filename in the header", () => {
    render(<FilePreviewRenderer c={pathComponent} />);
    expect(screen.getByText("results.csv")).toBeInTheDocument();
  });

  it("renders the placeholder message (no inline content available)", () => {
    render(<FilePreviewRenderer c={pathComponent} />);
    expect(screen.getByText(/File content not available client-side/)).toBeInTheDocument();
  });

  it("does not render a table (no CSV body for path sources)", () => {
    render(<FilePreviewRenderer c={pathComponent} />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("does not render a pre block (no text body for path sources)", () => {
    render(<FilePreviewRenderer c={pathComponent} />);
    expect(document.querySelector("pre")).toBeNull();
  });

  it("uses path as display name when no filename is provided", () => {
    const c: FilePreviewComponent = {
      id: "fp-path-noname",
      type: "file-preview",
      source: { kind: "path", path: "/tmp/output.txt" },
    };
    render(<FilePreviewRenderer c={c} />);
    expect(screen.getByText("/tmp/output.txt")).toBeInTheDocument();
  });

  it("renders a Download button", () => {
    render(<FilePreviewRenderer c={pathComponent} />);
    expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
  });
});
