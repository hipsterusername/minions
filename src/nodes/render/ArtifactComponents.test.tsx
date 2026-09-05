/**
 * Component tests for ImageRenderer, HtmlArtifactRenderer, and FilePreviewRenderer.
 *
 * Tests behavior at the component boundary: DOM structure, user interactions,
 * and edge-case rendering. No snapshot tests — we query by role/text.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, beforeAll, vi } from "vitest";

import { ImageRenderer, HtmlArtifactRenderer, FilePreviewRenderer } from "./ArtifactComponents.tsx";
import type { ImageComponent, FilePreviewComponent, HtmlArtifactComponent } from "../../../shared/render-dsl.ts";

// jsdom doesn't ship ResizeObserver; provide a no-op so any child that
// uses it doesn't blow up.
beforeAll(() => {
  // jsdom has no top layer. Stub only the native API; focus/inertness must
  // additionally be verified in a browser, not simulated as a passing test.
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
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
    src: "data:image/png;base64,AA==",
    alt: "Test photo",
  };

  it("renders an img tag with the correct src and alt", () => {
    render(<ImageRenderer c={baseImage} />);
    const img = screen.getAllByRole("img")[0];
    expect(img).toHaveAttribute("src", "data:image/png;base64,AA==");
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

  it("does not create a request-capable element for an unsafe restored URL", () => {
    const unsafe = { ...baseImage, src: "https://tracker.example/pixel.png" };
    render(<ImageRenderer c={unsafe} />);
    expect(screen.getByRole("alert")).toHaveTextContent("External image blocked");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open image lightbox/i })).not.toBeInTheDocument();
  });
});

// ── HtmlArtifactRenderer ─────────────────────────────────

describe("HtmlArtifactRenderer", () => {
  const html = "<!doctype html><html><head><title>Artifact</title></head><body><main>MARKER_CONTENT</main></body></html>";
  const baseArtifact: HtmlArtifactComponent = {
    id: "html-1",
    type: "html-artifact",
    html,
    title: "Report preview",
    height: 320,
  };

  function getIframes(): HTMLIFrameElement[] {
    return Array.from(document.querySelectorAll("iframe"));
  }

  it("renders preview HTML through iframe srcdoc only", () => {
    render(<HtmlArtifactRenderer c={baseArtifact} />);

    const iframe = getIframes()[0];
    expect(iframe).toBeDefined();
    expect(iframe?.getAttribute("srcdoc")).toContain("MARKER_CONTENT");
    expect(iframe?.getAttribute("sandbox")).toBe("");
    expect(iframe).toHaveAttribute("referrerPolicy", "no-referrer");
  });

  it("does not render artifact HTML as raw DOM text outside the iframe", () => {
    render(<HtmlArtifactRenderer c={baseArtifact} />);

    expect(document.body.textContent).not.toContain("MARKER_CONTENT");
    const iframesWithMarker = getIframes().filter((iframe) => iframe.getAttribute("srcdoc")?.includes("MARKER_CONTENT") === true);
    expect(iframesWithMarker).toHaveLength(1);
  });

  it("opens a sandboxed modal iframe and closes it with Escape", () => {
    render(<HtmlArtifactRenderer c={baseArtifact} />);
    expect(getIframes()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /expand/i }));

    expect(screen.getByRole("dialog", { name: /report preview lightbox/i })).toBeInTheDocument();
    const modalIframes = getIframes();
    expect(modalIframes).toHaveLength(2);
    expect(modalIframes[1]?.getAttribute("srcdoc")).toContain("MARKER_CONTENT");
    expect(modalIframes[1]?.getAttribute("sandbox")).toBe("");
    expect(modalIframes[1]).toHaveAttribute("referrerPolicy", "no-referrer");

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(getIframes()).toHaveLength(1);
  });

  it("closes the modal when the backdrop is clicked", () => {
    render(<HtmlArtifactRenderer c={baseArtifact} />);
    fireEvent.click(screen.getByRole("button", { name: /expand/i }));
    const dialog = screen.getByRole("dialog", { name: /report preview lightbox/i });

    fireEvent.click(dialog);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("portals the expand modal to document.body (escapes the node subtree)", () => {
    // The dashboard renders inside a canvas node whose ancestors are
    // CSS-transformed for pan/zoom. A position:fixed element nested in a
    // transformed ancestor is positioned relative to that ancestor, not the
    // viewport — so the modal must portal to document.body to take over the
    // full app screen instead of popping over / interacting with nodes.
    const { container } = render(<HtmlArtifactRenderer c={baseArtifact} />);
    fireEvent.click(screen.getByRole("button", { name: /expand/i }));

    const dialog = screen.getByRole("dialog", { name: /report preview lightbox/i });
    // Rendered outside the component's own container subtree…
    expect(container.contains(dialog)).toBe(false);
    // …and mounted directly under document.body.
    expect(dialog.parentElement).toBe(document.body);
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

describe("FilePreviewRenderer: unsafe inline content", () => {
  it("does not render SVG data as an image or open active HTML in a new tab", () => {
    const html: FilePreviewComponent = {
      id: "active-html",
      type: "file-preview",
      source: { kind: "inline", content: "<script>alert(1)</script>", mime: "text/html" },
      view: "image",
      actions: ["open"],
    };
    render(<FilePreviewRenderer c={html} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Unsafe image preview blocked");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
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

  it("renders the placeholder message and explains unsafe actions are disabled", () => {
    render(<FilePreviewRenderer c={pathComponent} />);
    expect(screen.getByText(/Open and download are disabled for untrusted paths/)).toBeInTheDocument();
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

  it("never opens a model-provided path as a browser target", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<FilePreviewRenderer c={pathComponent} />);
    expect(screen.queryByRole("button", { name: "Download" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });
});

it("moves image focus to Close and restores the trigger after button dismissal", () => {
  render(<ImageRenderer c={{ id: "i", type: "image", alt: "Sample", src: "data:image/png;base64,AA==" }} />);
  const trigger = screen.getByRole("button", { name: "Open image lightbox" });
  trigger.focus();
  fireEvent.click(trigger);
  const close = screen.getByRole("button", { name: "Close Image lightbox" });
  expect(document.activeElement).toBe(close);
  expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled();
  fireEvent.click(close);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
