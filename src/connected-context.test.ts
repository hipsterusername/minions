import { describe, it, expect } from "vitest";
import {
  hashString,
  buildContextBlock,
  seedContextHashes,
  diffContextItems,
  sendCanvasContextSnapshotIfChanged,
  type ContextHashes,
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

// ── seedContextHashes ─────────────────────────────────────────────────────

describe("seedContextHashes", () => {
  it("returns an empty object for empty items", () => {
    expect(seedContextHashes([])).toEqual({});
  });

  it("keys the hash map by nodeId", () => {
    const items: ContextItem[] = [
      { nodeId: "abc", nodeType: "markdown", label: "markdown", content: "hello" },
    ];
    const hashes = seedContextHashes(items);
    expect(Object.keys(hashes)).toEqual(["abc"]);
  });

  it("is deterministic: same items → same hashes", () => {
    const items: ContextItem[] = [
      { nodeId: "x", nodeType: "markdown", label: "markdown", content: "content" },
    ];
    expect(seedContextHashes(items)).toEqual(seedContextHashes(items));
  });
});

// ── diffContextItems ──────────────────────────────────────────────────────

describe("diffContextItems", () => {
  const makeItem = (
    nodeId: string,
    content: string,
    label = "markdown",
    nodeType = "markdown",
  ): ContextItem => ({ nodeId, nodeType, label, content });

  it("returns all items as changed when prevHashes is empty (new session baseline)", () => {
    const items = [makeItem("n1", "content A"), makeItem("n2", "content B")];
    const { changedItems, nextHashes } = diffContextItems(items, {});
    expect(changedItems).toHaveLength(2);
    expect(nextHashes).toHaveProperty("n1");
    expect(nextHashes).toHaveProperty("n2");
  });

  it("returns empty changedItems when no content changed", () => {
    const items = [makeItem("n1", "hello"), makeItem("n2", "world")];
    const prev = seedContextHashes(items);
    const { changedItems, nextHashes } = diffContextItems(items, prev);
    expect(changedItems).toHaveLength(0);
    expect(nextHashes).toEqual(prev);
  });

  it("includes an item when its content changes", () => {
    const original = [makeItem("n1", "original")];
    const prev = seedContextHashes(original);
    const updated = [makeItem("n1", "updated")];
    const { changedItems } = diffContextItems(updated, prev);
    expect(changedItems).toHaveLength(1);
    expect(changedItems[0]!.content).toBe("updated");
  });

  it("includes a new item not present in prevHashes", () => {
    const original = [makeItem("n1", "existing")];
    const prev = seedContextHashes(original);
    const withNew = [makeItem("n1", "existing"), makeItem("n2", "brand new")];
    const { changedItems, nextHashes } = diffContextItems(withNew, prev);
    expect(changedItems).toHaveLength(1);
    expect(changedItems[0]!.nodeId).toBe("n2");
    expect(nextHashes).toHaveProperty("n2");
  });

  it("does not re-send a removed item (it simply disappears from nextHashes)", () => {
    const original = [makeItem("n1", "first"), makeItem("n2", "second")];
    const prev = seedContextHashes(original);
    const withRemoved = [makeItem("n1", "first")]; // n2 removed
    const { changedItems, nextHashes } = diffContextItems(withRemoved, prev);
    expect(changedItems).toHaveLength(0); // n1 unchanged
    expect(nextHashes).not.toHaveProperty("n2");
  });

  it("only includes changed item when one of several items changes", () => {
    const items = [makeItem("n1", "unchanged"), makeItem("n2", "to be changed")];
    const prev = seedContextHashes(items);
    const updated = [makeItem("n1", "unchanged"), makeItem("n2", "changed!")];
    const { changedItems } = diffContextItems(updated, prev);
    expect(changedItems).toHaveLength(1);
    expect(changedItems[0]!.nodeId).toBe("n2");
  });

  it("detects label changes as content changes (label is part of the hash key)", () => {
    const items: ContextItem[] = [
      { nodeId: "n1", nodeType: "markdown", label: "Old Label", content: "same content" },
    ];
    const prev = seedContextHashes(items);
    const relabeled: ContextItem[] = [
      { nodeId: "n1", nodeType: "markdown", label: "New Label", content: "same content" },
    ];
    const { changedItems } = diffContextItems(relabeled, prev);
    expect(changedItems).toHaveLength(1);
  });

  it("returns correct nextHashes after mixed update (changed + unchanged)", () => {
    const items = [makeItem("n1", "alpha"), makeItem("n2", "beta")];
    const prev: ContextHashes = seedContextHashes(items);
    const next = [makeItem("n1", "alpha"), makeItem("n2", "gamma")];
    const { nextHashes } = diffContextItems(next, prev);
    // n1 unchanged — its hash in nextHashes matches prev
    expect(nextHashes["n1"]).toBe(prev["n1"]);
    // n2 changed — its hash in nextHashes differs from prev
    expect(nextHashes["n2"]).not.toBe(prev["n2"]);
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
});
