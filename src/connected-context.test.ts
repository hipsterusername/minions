import { describe, it, expect } from "vitest";
import {
  hashString,
  itemContentHash,
  buildContextBlock,
  sendCanvasContextSnapshotIfChanged,
} from "./connected-context.ts";
import type { ContextItem } from "./types.ts";

// ── hashString ────────────────────────────────────────────────────────────

describe("hashString", () => {
  it("returns the same value for the same input", () => {
    expect(hashString("hello world")).toBe(hashString("hello world"));
  });

  it("returns different values for different inputs", () => {
    expect(hashString("foo")).not.toBe(hashString("bar"));
  });

  it("returns an unsigned 32-bit integer (≥ 0)", () => {
    const h = hashString("negative test");
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });

  it("handles empty string without throwing", () => {
    expect(() => hashString("")).not.toThrow();
  });

  it("is stable across calls (deterministic)", () => {
    const s = "context-node-42\0markdown\0Some text content";
    const first = hashString(s);
    const second = hashString(s);
    expect(first).toBe(second);
  });
});

// ── buildContextBlock ─────────────────────────────────────────────────────

describe("buildContextBlock", () => {
  it("returns null for an empty items array", () => {
    expect(buildContextBlock([])).toBeNull();
  });

  it("wraps content in the exact <connected-context> wrapper required by deriveTaskName", () => {
    const items: ContextItem[] = [
      { nodeId: "n1", nodeType: "markdown", label: "markdown", content: "Hello" },
    ];
    const block = buildContextBlock(items);
    expect(block).not.toBeNull();
    // Exact wrapper text pinned here — server/session-host-config.ts deriveTaskName
    // uses a regex to strip this block and relies on this exact text.
    expect(block).toMatch(/^<connected-context>\nThe following context has been provided/);
    expect(block).toMatch(/<\/connected-context>$/);
  });

  it("uses plain <context-group> when label equals nodeType (case-insensitive)", () => {
    const items: ContextItem[] = [
      { nodeId: "n1", nodeType: "markdown", label: "Markdown", content: "content" },
    ];
    const block = buildContextBlock(items)!;
    expect(block).toContain("<context-group>\n");
    expect(block).not.toContain('<context-group title=');
  });

  it("uses titled <context-group> when label differs from nodeType", () => {
    const items: ContextItem[] = [
      { nodeId: "n1", nodeType: "markdown", label: "Project Spec", content: "content" },
    ];
    const block = buildContextBlock(items)!;
    expect(block).toContain('<context-group title="Project Spec">');
  });

  it("joins multiple items with newlines between groups", () => {
    const items: ContextItem[] = [
      { nodeId: "n1", nodeType: "markdown", label: "markdown", content: "first" },
      { nodeId: "n2", nodeType: "code", label: "code", content: "second" },
    ];
    const block = buildContextBlock(items)!;
    expect(block).toContain("first");
    expect(block).toContain("second");
  });

  it("appends no attachment hint when there are no attachments", () => {
    const items: ContextItem[] = [
      { nodeId: "n1", nodeType: "markdown", label: "markdown", content: "text" },
    ];
    const block = buildContextBlock(items)!;
    expect(block).not.toContain("attached");
    expect(block).not.toContain("image");
  });

  it("appends singular attachment hint for exactly one image", () => {
    const items: ContextItem[] = [
      {
        nodeId: "n1",
        nodeType: "image",
        label: "image",
        content: "",
        attachments: [
          { kind: "image", mediaType: "image/png", data: "base64data" },
        ],
      },
    ];
    const block = buildContextBlock(items)!;
    expect(block).toContain("attached 1 image ");
    expect(block).toContain("see the image block in this turn");
  });

  it("appends plural attachment hint for multiple images", () => {
    const items: ContextItem[] = [
      {
        nodeId: "n1",
        nodeType: "image",
        label: "image",
        content: "",
        attachments: [
          { kind: "image", mediaType: "image/png", data: "a" },
          { kind: "image", mediaType: "image/jpeg", data: "b" },
        ],
      },
    ];
    const block = buildContextBlock(items)!;
    expect(block).toContain("attached 2 images");
    expect(block).toContain("see the image blocks in this turn");
  });
});

// ── itemContentHash ───────────────────────────────────────────────────────

describe("itemContentHash", () => {
  it("is deterministic for identical items", () => {
    const item: ContextItem = { nodeId: "n1", nodeType: "markdown", label: "L", content: "c" };
    expect(itemContentHash(item)).toBe(itemContentHash({ ...item }));
  });

  it("changes when content changes", () => {
    const a: ContextItem = { nodeId: "n1", nodeType: "markdown", label: "L", content: "one" };
    const b: ContextItem = { ...a, content: "two" };
    expect(itemContentHash(a)).not.toBe(itemContentHash(b));
  });

  it("changes when label changes (label is part of the hash key)", () => {
    const a: ContextItem = { nodeId: "n1", nodeType: "markdown", label: "Old", content: "same" };
    const b: ContextItem = { ...a, label: "New" };
    expect(itemContentHash(a)).not.toBe(itemContentHash(b));
  });
});

describe("sendCanvasContextSnapshotIfChanged", () => {
  it("sends the full snapshot when connected context appears", () => {
    const sent: unknown[] = [];
    const items: ContextItem[] = [
      { nodeId: "n1", nodeType: "markdown", label: "Note", content: "hello" },
    ];

    const signature = sendCanvasContextSnapshotIfChanged({
      socketSend: (payload) => sent.push(payload),
      sessionKey: "leader-1",
      items,
      previousSignature: null,
    });

    expect(signature).not.toBeNull();
    expect(sent).toEqual([{ type: "canvas_context", sessionKey: "leader-1", items }]);
  });

  it("does not resend unchanged snapshots and sends an empty snapshot when cleared", () => {
    const sent: unknown[] = [];
    const items: ContextItem[] = [
      { nodeId: "n1", nodeType: "markdown", label: "Note", content: "hello" },
    ];
    const first = sendCanvasContextSnapshotIfChanged({
      socketSend: (payload) => sent.push(payload),
      sessionKey: "leader-1",
      items,
      previousSignature: null,
    });
    const second = sendCanvasContextSnapshotIfChanged({
      socketSend: (payload) => sent.push(payload),
      sessionKey: "leader-1",
      items,
      previousSignature: first,
    });
    const third = sendCanvasContextSnapshotIfChanged({
      socketSend: (payload) => sent.push(payload),
      sessionKey: "leader-1",
      items: [],
      previousSignature: second,
    });

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ type: "canvas_context", sessionKey: "leader-1", items: [] });
    expect(third).toBeNull();
  });

  it("strips client-side `blocks` metadata from the wire payload", () => {
    const sent: Array<{ items: ContextItem[] }> = [];
    const items: ContextItem[] = [
      {
        nodeId: "n1",
        nodeType: "leader",
        label: "Upstream",
        content: "User:\nhi\n\nAssistant:\nhello",
        blocks: ["User:\nhi", "Assistant:\nhello"],
      },
    ];

    sendCanvasContextSnapshotIfChanged({
      socketSend: (payload) => sent.push(payload as { items: ContextItem[] }),
      sessionKey: "leader-1",
      items,
      previousSignature: null,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.items[0]).not.toHaveProperty("blocks");
    expect(sent[0]!.items[0]!.content).toBe(items[0]!.content);
  });
});
