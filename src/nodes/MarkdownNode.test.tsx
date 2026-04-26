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
  viewMode: "edit" | "preview";
  savedPath?: string | null;
  savedContentHash?: string | null;
}

function Probe({ initial }: { initial: MarkdownData }) {
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
    onUpdateData: (next) => setData(next as MarkdownData),
    onResize: () => {},
    projectPath: "/tmp/fake-project",
  };
  return <MarkdownNodeRenderer {...props} />;
}

const TEST_TOKEN = "test-token-123";

function mockFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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

  it("includes Bearer auth header on quick-save (Cmd+S with savedPath)", async () => {
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

    const textarea = await screen.findByPlaceholderText("Start writing…");

    await act(async () => {
      fireEvent.keyDown(textarea, { key: "s", metaKey: true });
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
});
