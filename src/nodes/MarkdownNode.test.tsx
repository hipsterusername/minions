/**
 * Regression test for the markdown save → unauthorized bug.
 *
 * The `/api/files/save` endpoint requires `Authorization: Bearer <token>`
 * (see `server/index.ts` authMiddleware). Earlier versions of the save
 * fetches in MarkdownNode omitted the header and the server rejected the
 * request with 401. This test pins down that both save paths
 * (handleQuickSave and SaveDialog.handleSave) include the header.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownNodeRenderer } from "./MarkdownNode.tsx";
import { clearAuthToken } from "../api.ts";
import type { CanvasNode, NodeRenderProps } from "../types.ts";

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

interface MarkdownData {
  title: string;
  content: string;
  viewMode: "edit" | "preview" | "split";
  savedPath?: string | null;
  savedContentHash?: string | null;
  splitRatio?: number;
}

function Probe({
  initial,
  onCreateKanbanCardFromMarkdown,
  onData,
}: {
  initial: MarkdownData;
  onCreateKanbanCardFromMarkdown?: NodeRenderProps["onCreateKanbanCardFromMarkdown"];
  /** Callback fired whenever the node's data changes (for assertions). */
  onData?: (next: MarkdownData) => void;
}) {
  const [data, setData] = useState<MarkdownData>(initial);
  const node: CanvasNode = {
    id: "md-test",
    type: "markdown",
    position: { x: 0, y: 0 },
    size: { width: 480, height: 360 },
    data: data as unknown as Record<string, unknown>,
  };
  const props: NodeRenderProps = {
    node,
    isSelected: false,
    onUpdateData: (next) => {
      const typed = next as MarkdownData;
      setData(typed);
      onData?.(typed);
    },
    onResize: () => {},
    projectPath: "/tmp/fake-project",
    onCreateKanbanCardFromMarkdown,
  };
  return <MarkdownNodeRenderer {...props} />;
}

const TEST_TOKEN = "test-token-123";

function mockFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/auth/token")) {
      return new Response(JSON.stringify({ token: TEST_TOKEN }), { status: 200 });
    }
    if (url.includes("/api/files/save")) {
      return new Response(
        JSON.stringify({ ok: true, relativePath: "notes/test.md" }),
        { status: 200 },
      );
    }
    if (url.includes("/api/files/list-dirs")) {
      return new Response(
        JSON.stringify({ dirs: [], currentPath: ".", projectRoot: "fake" }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ error: "unmatched" }), { status: 404 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function authHeaderOf(call: unknown[]): string | undefined {
  const init = call[1] as RequestInit | undefined;
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers["Authorization"];
}

describe("MarkdownNode save", () => {
  beforeEach(() => {
    clearAuthToken();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes Bearer auth header on quick-save (status-bar save button with savedPath)", async () => {
    // We click the status-bar quick-save button rather than firing a
    // synthetic Cmd+S keydown: CodeMirror owns its own contenteditable
    // surface, and jsdom-synthesized key events don't reliably traverse
    // its keymap. The button takes the same `handleQuickSave` codepath.
    const fetchMock = mockFetch();

    render(
      <Probe
        initial={{
          title: "Test",
          content: "edited content",
          viewMode: "edit",
          savedPath: "notes/test.md",
          // Different from current content so hasUnsavedChanges = true
          savedContentHash: "stale",
        }}
      />,
    );

    const quickSave = await screen.findByTitle("Save to notes/test.md");

    await act(async () => {
      fireEvent.click(quickSave);
      // let microtasks resolve so getAuthToken() and the save fetch settle
      await Promise.resolve();
      await Promise.resolve();
    });

    const saveCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/api/files/save"),
    );
    expect(saveCall).toBeDefined();
    expect(authHeaderOf(saveCall!)).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it("includes Bearer auth header on Save-As dialog save", async () => {
    const fetchMock = mockFetch();

    render(
      <Probe
        initial={{
          title: "Test",
          content: "fresh content",
          viewMode: "edit",
        }}
      />,
    );

    // Open save dialog via the "Save" button in status bar
    const saveAs = await screen.findByTitle("Save to project…");
    await act(async () => {
      fireEvent.click(saveAs);
    });

    // Click the confirm "Save" button inside the dialog
    const confirm = await screen.findByText("Save", { selector: "button.md-save-confirm-btn" });
    await act(async () => {
      fireEvent.click(confirm);
      await Promise.resolve();
      await Promise.resolve();
    });

    const saveCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/api/files/save"),
    );
    expect(saveCall).toBeDefined();
    expect(authHeaderOf(saveCall!)).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it("prompts inline for a title and creates a Kanban card from markdown content", async () => {
    const onCreateKanbanCardFromMarkdown = vi.fn();

    render(
      <Probe
        initial={{
          title: "Draft title",
          content: "Implement this task\n\n- Keep the action quiet",
          viewMode: "edit",
        }}
        onCreateKanbanCardFromMarkdown={onCreateKanbanCardFromMarkdown}
      />,
    );

    const cardButton = await screen.findByTitle("Save as Kanban card");
    await act(async () => {
      fireEvent.click(cardButton);
    });

    const titleInput = await screen.findByLabelText("Card title");
    expect(titleInput).toHaveValue("Draft title");

    await act(async () => {
      fireEvent.change(titleInput, { target: { value: "Ship markdown cards" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });

    expect(onCreateKanbanCardFromMarkdown).toHaveBeenCalledWith({
      nodeId: "md-test",
      title: "Ship markdown cards",
      content: "Implement this task\n\n- Keep the action quiet",
    });
    expect(await screen.findByText("Card added")).toBeInTheDocument();
  });
});

describe("MarkdownNode header drag affordance", () => {
  // Regression: the title <input> used to occupy the entire header
  // with `flex: 1`, leaving only ~6px of padding gaps as actual
  // draggable area (every other header element — chevron, mode pills,
  // fullscreen button — is interactive and stops drag propagation in
  // CanvasNode). Users complained the markdown header was hard to
  // grab. The fix is a leading drag-grip span and a flex spacer
  // beside the title; both are plain (non-interactive) DOM so the
  // canvas drag handler picks them up.
  it("renders a leading drag grip with an accessible move hint", () => {
    render(
      <Probe initial={{ title: "T", content: "x", viewMode: "edit" }} />,
    );
    // `findByTitle` resolves through the accessible name path — this
    // is the same query shape used elsewhere in this file for the
    // save buttons, so it isn't presentation coupling.
    const grip = screen.getByTitle("Drag to move");
    expect(grip.tagName.toLowerCase()).toBe("span");
  });

  it("renders a spacer beside the title so the header always has a drag region", () => {
    const { container } = render(
      <Probe
        initial={{
          // Long title — the old layout would have stretched the
          // input across the entire header. The spacer guarantees
          // we still have a drag target.
          title: "A really long markdown note title that wants to grow",
          content: "x",
          viewMode: "edit",
        }}
      />,
    );
    const spacer = container.querySelector(".md-header-spacer");
    expect(spacer).not.toBeNull();
  });
});

describe("MarkdownNode scroll capture & mode behaviour", () => {
  it("marks both the editor host and the preview with data-scroll-capture", () => {
    // Regression: the canvas wheel handler routes scroll to native only
    // when an ancestor carries `data-scroll-capture`. Without this
    // attribute, wheel events over a markdown card pan the canvas.
    const { container } = render(
      <Probe
        initial={{
          title: "Scroll test",
          content: "# Heading\n\nSome body text",
          viewMode: "split",
        }}
      />,
    );

    const captures = container.querySelectorAll("[data-scroll-capture]");
    // Split mode renders both editor and preview, so we expect at least
    // two scroll-capture surfaces.
    expect(captures.length).toBeGreaterThanOrEqual(2);
  });

  it("renders editor + preview side by side in split mode", () => {
    const { container } = render(
      <Probe
        initial={{
          title: "Split test",
          content: "**hello** world",
          viewMode: "split",
        }}
      />,
    );

    // Editor host (CodeMirror wrapper) is present.
    expect(container.querySelector(".md-editor-host")).not.toBeNull();
    // Preview pane is present.
    expect(container.querySelector(".md-preview")).not.toBeNull();
    // Divider between them is present.
    expect(container.querySelector(".md-split-divider")).not.toBeNull();
  });

  it("hides preview in pure edit mode and editor in pure read mode", () => {
    const { container: editOnly } = render(
      <Probe
        initial={{ title: "T", content: "x", viewMode: "edit" }}
      />,
    );
    expect(editOnly.querySelector(".md-editor-host")).not.toBeNull();
    expect(editOnly.querySelector(".md-preview")).toBeNull();

    const { container: readOnly } = render(
      <Probe
        initial={{ title: "T", content: "x", viewMode: "preview" }}
      />,
    );
    expect(readOnly.querySelector(".md-editor-host")).toBeNull();
    expect(readOnly.querySelector(".md-preview")).not.toBeNull();
  });

  it("clicking Split toggles viewMode to split", async () => {
    render(
      <Probe
        initial={{ title: "T", content: "x", viewMode: "edit" }}
      />,
    );

    const splitButton = await screen.findByRole("button", { name: "Split" });
    expect(splitButton).toHaveAttribute("data-active", "false");

    await act(async () => {
      fireEvent.click(splitButton);
    });

    // After click, the same button reports active and the preview is now
    // rendered alongside the editor.
    expect(splitButton).toHaveAttribute("data-active", "true");
    expect(document.querySelector(".md-preview")).not.toBeNull();
  });
});

describe("MarkdownNode focus mode (fullscreen overlay)", () => {
  // testing-library's auto-cleanup unmounts the rendered tree between
  // tests, which in turn tears down the portal and runs the body-scroll
  // useEffect cleanup. Doing any manual DOM clobbering here (e.g.
  // `document.body.innerHTML = ""`) races React's unmount and produces
  // a `NotFoundError` from the portal cleanup path — so don't.

  it("does not render an overlay by default", () => {
    render(
      <Probe initial={{ title: "T", content: "x", viewMode: "edit" }} />,
    );
    expect(document.querySelector(".md-fullscreen-overlay")).toBeNull();
    expect(document.querySelector(".md-fullscreen-stub")).toBeNull();
  });

  it("clicking the focus-mode button portals the node into a fullscreen overlay", async () => {
    render(
      <Probe initial={{ title: "T", content: "hello", viewMode: "edit" }} />,
    );

    const btn = await screen.findByRole("button", { name: "Enter focus mode" });
    expect(btn).toHaveAttribute("aria-pressed", "false");

    await act(async () => {
      fireEvent.click(btn);
    });

    // Overlay is created, attached at the body level (not nested in the
    // canvas card), and the in-canvas card is replaced by a stub.
    const overlay = document.querySelector(".md-fullscreen-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay?.parentElement).toBe(document.body);
    expect(document.querySelector(".md-fullscreen-stub")).not.toBeNull();

    // The button (now living inside the portaled copy) flips state.
    const exitBtn = await screen.findByRole("button", { name: "Exit focus mode" });
    expect(exitBtn).toHaveAttribute("aria-pressed", "true");

    // Body scroll lock is engaged while the overlay is up.
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("Esc exits focus mode and restores body scroll", async () => {
    render(
      <Probe initial={{ title: "T", content: "x", viewMode: "edit" }} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enter focus mode" }));
    });
    expect(document.querySelector(".md-fullscreen-overlay")).not.toBeNull();

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });

    expect(document.querySelector(".md-fullscreen-overlay")).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("Cmd+Shift+F toggles focus mode when the node owns focus", async () => {
    render(
      <Probe initial={{ title: "T", content: "x", viewMode: "edit" }} />,
    );

    // Move focus inside the card so the keyboard shortcut applies to it.
    const title = screen.getByPlaceholderText("Untitled") as HTMLInputElement;
    title.focus();

    await act(async () => {
      fireEvent.keyDown(window, { key: "f", metaKey: true, shiftKey: true });
    });
    expect(document.querySelector(".md-fullscreen-overlay")).not.toBeNull();

    await act(async () => {
      fireEvent.keyDown(window, { key: "f", metaKey: true, shiftKey: true });
    });
    expect(document.querySelector(".md-fullscreen-overlay")).toBeNull();
  });

  it("renders both editor and preview inside the overlay in Split mode", async () => {
    render(
      <Probe initial={{ title: "T", content: "x", viewMode: "split" }} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enter focus mode" }));
    });

    const overlay = document.querySelector(".md-fullscreen-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelector(".md-editor-host")).not.toBeNull();
    expect(overlay?.querySelector(".md-preview")).not.toBeNull();
    expect(overlay?.querySelector(".md-split-divider")).not.toBeNull();
  });
});

describe("MarkdownNode resizable split divider", () => {
  /** Pin the writing-area bounding rect so drag math is deterministic. */
  function stubWritingAreaRect(width = 1000): () => void {
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if ((this as HTMLElement).classList.contains("md-writing-area")) {
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: width,
          bottom: 600,
          width,
          height: 600,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return original.call(this);
    };
    return () => {
      Element.prototype.getBoundingClientRect = original;
    };
  }

  it("seeds the writing area with --md-split-ratio = 0.5 by default", () => {
    const { container } = render(
      <Probe initial={{ title: "T", content: "x", viewMode: "split" }} />,
    );
    const writingArea = container.querySelector(
      ".md-writing-area",
    ) as HTMLElement;
    expect(writingArea).not.toBeNull();
    expect(writingArea.style.getPropertyValue("--md-split-ratio")).toBe("0.5");
  });

  it("respects a persisted splitRatio from data", () => {
    const { container } = render(
      <Probe
        initial={{
          title: "T",
          content: "x",
          viewMode: "split",
          splitRatio: 0.7,
        }}
      />,
    );
    const writingArea = container.querySelector(
      ".md-writing-area",
    ) as HTMLElement;
    expect(writingArea.style.getPropertyValue("--md-split-ratio")).toBe("0.7");
  });

  it("clamps an out-of-range persisted ratio into [0.15, 0.85]", () => {
    const { container } = render(
      <Probe
        initial={{
          title: "T",
          content: "x",
          viewMode: "split",
          splitRatio: 0.01,
        }}
      />,
    );
    const writingArea = container.querySelector(
      ".md-writing-area",
    ) as HTMLElement;
    expect(writingArea.style.getPropertyValue("--md-split-ratio")).toBe("0.15");
  });

  it("dragging the divider commits the new ratio on pointer up", async () => {
    const restoreRect = stubWritingAreaRect(1000);
    try {
      const data: MarkdownData[] = [];
      render(
        <Probe
          initial={{ title: "T", content: "x", viewMode: "split" }}
          onData={(d) => data.push(d)}
        />,
      );

      const divider = document.querySelector(
        ".md-split-divider",
      ) as HTMLElement;
      expect(divider).not.toBeNull();

      // Stub pointer capture APIs (not implemented in jsdom).
      divider.setPointerCapture = () => {};
      divider.releasePointerCapture = () => {};

      await act(async () => {
        fireEvent.pointerDown(divider, { pointerId: 1, clientX: 500 });
        fireEvent.pointerMove(divider, { pointerId: 1, clientX: 700 });
        fireEvent.pointerUp(divider, { pointerId: 1, clientX: 700 });
      });

      // 700 / 1000 = 0.7 — within bounds, no clamp needed.
      const last = data[data.length - 1];
      expect(last?.splitRatio).toBeCloseTo(0.7, 5);
    } finally {
      restoreRect();
    }
  });

  it("clamps the drag at the SPLIT_MAX boundary (85%)", async () => {
    const restoreRect = stubWritingAreaRect(1000);
    try {
      const data: MarkdownData[] = [];
      render(
        <Probe
          initial={{ title: "T", content: "x", viewMode: "split" }}
          onData={(d) => data.push(d)}
        />,
      );

      const divider = document.querySelector(
        ".md-split-divider",
      ) as HTMLElement;
      divider.setPointerCapture = () => {};
      divider.releasePointerCapture = () => {};

      await act(async () => {
        fireEvent.pointerDown(divider, { pointerId: 1, clientX: 500 });
        // Drag all the way past the right edge.
        fireEvent.pointerMove(divider, { pointerId: 1, clientX: 9999 });
        fireEvent.pointerUp(divider, { pointerId: 1, clientX: 9999 });
      });

      expect(data[data.length - 1]?.splitRatio).toBeCloseTo(0.85, 5);
    } finally {
      restoreRect();
    }
  });

  it("double-clicking the divider resets the ratio to 0.5", async () => {
    const data: MarkdownData[] = [];
    render(
      <Probe
        initial={{
          title: "T",
          content: "x",
          viewMode: "split",
          splitRatio: 0.8,
        }}
        onData={(d) => data.push(d)}
      />,
    );

    const divider = document.querySelector(".md-split-divider") as HTMLElement;
    await act(async () => {
      fireEvent.doubleClick(divider);
    });

    expect(data[data.length - 1]?.splitRatio).toBe(0.5);
  });

  it("exposes correct ARIA semantics on the divider", () => {
    render(
      <Probe
        initial={{
          title: "T",
          content: "x",
          viewMode: "split",
          splitRatio: 0.6,
        }}
      />,
    );
    const divider = document.querySelector(".md-split-divider") as HTMLElement;
    expect(divider).toHaveAttribute("role", "separator");
    expect(divider).toHaveAttribute("aria-orientation", "vertical");
    expect(divider).toHaveAttribute("aria-valuenow", "60");
    expect(divider).toHaveAttribute("aria-valuemin", "15");
    expect(divider).toHaveAttribute("aria-valuemax", "85");
  });
});
