import { describe, expect, it } from "vitest";
import { registerNodeType } from "./node-registry.ts";
import { nodeSearchEntry, searchNodes } from "./node-search.ts";
import type { CanvasNode } from "./types.ts";

function node(type: string, data: unknown, id = `${type}-1`): CanvasNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    data,
  };
}

// A registered type so we can exercise the registry label + extractor path.
registerNodeType({
  type: "search-note",
  label: "Search Note",
  defaultSize: { width: 100, height: 100 },
  render: (() => null) as unknown as never,
  extractContent: (data) => (data as { body?: string }).body ?? null,
});

describe("nodeSearchEntry", () => {
  it("prefers taskName as the title", () => {
    const entry = nodeSearchEntry(node("leader", { taskName: "Ship the API" }));
    expect(entry.title).toBe("Ship the API");
  });

  it("falls back to the first content line when there is no title field", () => {
    const entry = nodeSearchEntry(
      node("markdown", { content: "First line here\nsecond line" }),
    );
    expect(entry.title).toBe("First line here");
    expect(entry.snippet).toContain("First line here");
  });

  it("uses the registry label and content extractor", () => {
    const entry = nodeSearchEntry(node("search-note", { body: "hello world" }));
    expect(entry.typeLabel).toBe("Search Note");
    expect(entry.snippet).toBe("hello world");
  });

  it("falls back to the raw type when nothing is registered or set", () => {
    const entry = nodeSearchEntry(node("mystery", {}));
    expect(entry.title).toBe("mystery");
    expect(entry.typeLabel).toBe("mystery");
    expect(entry.snippet).toBe("");
  });
});

describe("searchNodes", () => {
  const nodes: CanvasNode[] = [
    node("leader", { taskName: "Refactor auth" }, "a"),
    node("markdown", { title: "Meeting notes", content: "budget review" }, "b"),
    node("note", { text: "grocery list" }, "c"),
  ];

  it("returns every node for an empty query", () => {
    expect(searchNodes(nodes, "").map((e) => e.nodeId)).toEqual(["a", "b", "c"]);
  });

  it("matches on title text", () => {
    const ids = searchNodes(nodes, "auth").map((e) => e.nodeId);
    expect(ids).toEqual(["a"]);
  });

  it("matches on body content, not just the title", () => {
    const ids = searchNodes(nodes, "budget").map((e) => e.nodeId);
    expect(ids).toEqual(["b"]);
  });

  it("ranks substring hits above looser subsequence hits", () => {
    const ranked = searchNodes(nodes, "list");
    // "grocery list" is a substring hit; nothing else should outrank it.
    expect(ranked[0]?.nodeId).toBe("c");
  });

  it("returns nothing when no node matches", () => {
    expect(searchNodes(nodes, "zzzzz")).toEqual([]);
  });
});
