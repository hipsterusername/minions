/**
 * Regression tests for the Canvas→Leader context-extraction pipeline.
 *
 * Anchors the bug: before this file existed, `extractContextItem` only knew
 * about markdown / file-viewer / note. Image nodes connected to a Leader
 * produced *zero* context items, so the leader never learned anything about
 * the image — not even the text description ImageNode had already registered
 * via `extractContent`.
 *
 * The fix delegates to the node registry, so any node type that declares
 * `providesContext: true` + `extractContent` automatically flows through.
 */
import { describe, expect, it } from "vitest";

// Side-effect imports register the content extractors we rely on below.
import "./nodes/ImageNode.tsx";
import "./nodes/MarkdownNode.tsx";
import "./nodes/FileViewerNode.tsx";
import "./nodes/FolderNode.tsx";
import "./nodes/RenderNode.tsx";

import { extractContextItem } from "./context-extraction.ts";
import type { CanvasNode } from "./types.ts";

function node(type: string, data: unknown): CanvasNode {
  return {
    id: `${type}-1`,
    type,
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    data,
  };
}

describe("extractContextItem", () => {
  it("returns null when the node has no content to contribute", () => {
    expect(extractContextItem(node("markdown", { title: "", content: "   ", viewMode: "edit" }))).toBeNull();
    expect(extractContextItem(node("image", { src: null, annotations: [] }))).toBeNull();
  });

  it("flattens a markdown node via its registered extractor", () => {
    const item = extractContextItem(
      node("markdown", { title: "Spec", content: "# Hello", viewMode: "edit" }),
    );
    expect(item).not.toBeNull();
    expect(item!.label).toBe("Spec");
    expect(item!.content).toContain("# Hello");
  });

  it("flattens a folder node via its registered extractor — regression for silent context drop on folders dragged from the project pane", () => {
    const item = extractContextItem(
      node("folder", {
        folderPath: "src/nodes",
        loadedContent: "Folder: src/nodes\n2 directories, 1 files\n\n📁 a\n📁 b\n   c.ts",
      }),
    );
    expect(item).not.toBeNull();
    expect(item!.nodeType).toBe("folder");
    expect(item!.content).toContain("Folder: src/nodes");
    expect(item!.content).toContain("c.ts");
  });

  it("returns null for a folder node whose listing has not loaded yet", () => {
    expect(
      extractContextItem(node("folder", { folderPath: "src/nodes" })),
    ).toBeNull();
  });

  it("flattens a file-viewer node via its registered extractor", () => {
    const item = extractContextItem(
      node("file-viewer", { filePath: "/tmp/foo.ts", loadedContent: "export const x = 1;" }),
    );
    expect(item).not.toBeNull();
    expect(item!.label).toBe("/tmp/foo.ts");
    expect(item!.content).toBe("export const x = 1;");
  });

  it("flattens an image node into a text description — regression for silent context drop", () => {
    const item = extractContextItem(
      node("image", {
        src: "data:image/png;base64,xxxx",
        naturalWidth: 800,
        naturalHeight: 600,
        filename: "screenshot.png",
        annotations: [
          { id: "p1", kind: "pin", x: 0.25, y: 0.4, note: "broken button", color: "#f00", order: 1 },
        ],
      }),
    );
    expect(item).not.toBeNull();
    expect(item!.nodeType).toBe("image");
    expect(item!.label).toBe("screenshot.png");
    expect(item!.content).toContain("screenshot.png");
    expect(item!.content).toContain("800×600");
    expect(item!.content).toContain("Pin at (0.250, 0.400)");
    expect(item!.content).toContain(`"broken button"`);
  });

  it("falls back to the node type as label when no filename/title is on the data", () => {
    const item = extractContextItem(
      node("image", {
        src: "data:image/png;base64,xxxx",
        naturalWidth: 10,
        naturalHeight: 10,
        annotations: [],
      }),
    );
    expect(item).not.toBeNull();
    expect(item!.label).toBe("image");
  });

  it("handles the legacy 'note' type that has no registered extractor", () => {
    const item = extractContextItem(node("note", { text: "remember this", color: "#fff" }));
    expect(item).not.toBeNull();
    expect(item!.label).toBe("Note");
    expect(item!.content).toBe("remember this");
  });

  it("attaches image bytes as a Base64 content attachment — regression for hallucinated-image bug", () => {
    const item = extractContextItem(
      node("image", {
        src: "data:image/png;base64,AAAAAAAA",
        naturalWidth: 640,
        naturalHeight: 480,
        filename: "cat.png",
        annotations: [],
      }),
    );
    expect(item).not.toBeNull();
    expect(item!.attachments).toBeDefined();
    expect(item!.attachments).toHaveLength(1);
    const att = item!.attachments![0]!;
    expect(att.kind).toBe("image");
    expect(att.mediaType).toBe("image/png");
    expect(att.data).toBe("AAAAAAAA");
    expect(att.filename).toBe("cat.png");
  });

  it("does not attach anything when the image src is not a supported data URL", () => {
    const item = extractContextItem(
      node("image", {
        src: "https://example.com/cat.png",
        naturalWidth: 10,
        naturalHeight: 10,
        annotations: [],
      }),
    );
    // External URLs are currently out of scope — we refuse rather than
    // send a broken block to the SDK.
    expect(item?.attachments).toBeUndefined();
  });

  it("flattens a render (dashboard) node so its components flow as Leader context", () => {
    const item = extractContextItem(
      node("render", {
        leaderSessionKey: "abc",
        leaderId: "leader-1",
        renderState: {
          layout: { columns: 2, gap: 12, title: "Build Status" },
          components: [
            { id: "m", type: "metric", label: "Tests", value: "42" },
            {
              id: "ch",
              type: "checklist",
              items: [
                { label: "lint", checked: true },
                { label: "typecheck", checked: false },
              ],
            },
          ],
        },
      }),
    );
    expect(item).not.toBeNull();
    expect(item!.nodeType).toBe("render");
    expect(item!.content).toContain("# Build Status");
    expect(item!.content).toContain("**Tests**: 42");
    expect(item!.content).toContain("- [x] lint");
    expect(item!.content).toContain("- [ ] typecheck");
  });

  it("returns null for a render node with no components yet", () => {
    expect(
      extractContextItem(
        node("render", {
          leaderSessionKey: null,
          leaderId: null,
          renderState: { layout: { columns: 2, gap: 12 }, components: [] },
        }),
      ),
    ).toBeNull();
  });

  it("keeps an image context item even when the text description would be empty", () => {
    // This can't happen in today's extractor (it always produces a
    // preamble), but guards the shape from future refactors that might
    // return empty text yet still have an attachment.
    const item = extractContextItem(
      node("image", {
        src: "data:image/jpeg;base64,ZZZZ",
        naturalWidth: 1,
        naturalHeight: 1,
        annotations: [],
      }),
    );
    expect(item).not.toBeNull();
    expect(item!.attachments).toHaveLength(1);
  });
});
