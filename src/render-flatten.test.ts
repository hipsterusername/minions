/**
 * Tests for {@link flattenRenderStateToText}.
 *
 * Locks the markdown-ish serialization that flows from a Dashboard
 * (RenderNode) into a connected Leader as context. Every component
 * primitive in the DSL must produce a deterministic, agent-readable
 * representation.
 */
import { describe, expect, it } from "vitest";

import type {
  RenderComponent,
  RenderState,
} from "../shared/render-dsl.ts";
import { flattenRenderStateToText } from "./render-flatten.ts";

function state(components: RenderComponent[], title?: string): RenderState {
  return {
    layout: title ? { columns: 2, gap: 12, title } : { columns: 2, gap: 12 },
    components,
  };
}

describe("flattenRenderStateToText", () => {
  it("returns an empty string for an empty dashboard", () => {
    expect(flattenRenderStateToText(state([]))).toBe("");
  });

  it("includes the layout title when present", () => {
    const out = flattenRenderStateToText(
      state([{ id: "m", type: "metric", label: "Users", value: "42" }], "Overview"),
    );
    expect(out.startsWith("# Overview")).toBe(true);
    expect(out).toContain("**Users**: 42");
  });

  it("formats a metric with trend and detail", () => {
    const out = flattenRenderStateToText(
      state([
        {
          id: "m",
          type: "metric",
          label: "Conversion",
          value: "3.4%",
          trend: "up",
          detail: "vs last week",
        },
      ]),
    );
    expect(out).toBe("**Conversion**: 3.4% (up) — vs last week");
  });

  it("formats progress and status", () => {
    const out = flattenRenderStateToText(
      state([
        { id: "p", type: "progress", label: "Build", value: 75 },
        { id: "s", type: "status", label: "CI", state: "running" },
      ]),
    );
    expect(out).toContain("**Build**: 75%");
    expect(out).toContain("**CI**: running");
  });

  it("renders tables as markdown grids", () => {
    const out = flattenRenderStateToText(
      state([
        {
          id: "t",
          type: "table",
          title: "Files",
          headers: ["Path", "Lines"],
          rows: [
            ["a.ts", "10"],
            ["b.ts", "20"],
          ],
        },
      ]),
    );
    expect(out).toContain("### Files");
    expect(out).toContain("| Path | Lines |");
    expect(out).toContain("| --- | --- |");
    expect(out).toContain("| a.ts | 10 |");
    expect(out).toContain("| b.ts | 20 |");
  });

  it("renders ordered and unordered lists", () => {
    const unordered = flattenRenderStateToText(
      state([{ id: "l", type: "list", items: ["one", "two"] }]),
    );
    expect(unordered).toBe("- one\n- two");

    const ordered = flattenRenderStateToText(
      state([{ id: "l", type: "list", items: ["one", "two"], ordered: true }]),
    );
    expect(ordered).toBe("1. one\n2. two");
  });

  it("passes text through and fences code with the language", () => {
    const out = flattenRenderStateToText(
      state([
        { id: "tx", type: "text", content: "Hello **world**" },
        { id: "c", type: "code", language: "ts", content: "const x = 1;" },
      ]),
    );
    expect(out).toContain("Hello **world**");
    expect(out).toContain("```ts\nconst x = 1;\n```");
  });

  it("formats sparkline data inline", () => {
    const out = flattenRenderStateToText(
      state([
        { id: "sp", type: "sparkline", label: "Latency", data: [1, 2, 3, 4] },
      ]),
    );
    expect(out).toBe("**Latency**: [1, 2, 3, 4]");
  });

  it("formats key-value sheets", () => {
    const out = flattenRenderStateToText(
      state([
        {
          id: "kv",
          type: "kv",
          title: "Config",
          entries: [
            { key: "host", value: "localhost" },
            { key: "port", value: "3141" },
          ],
        },
      ]),
    );
    expect(out).toContain("### Config");
    expect(out).toContain("- host: localhost");
    expect(out).toContain("- port: 3141");
  });

  it("formats timelines with state, time, label, and detail", () => {
    const out = flattenRenderStateToText(
      state([
        {
          id: "tl",
          type: "timeline",
          events: [
            { label: "Started", state: "success", time: "10:00" },
            { label: "Failed", state: "error", detail: "OOM" },
          ],
        },
      ]),
    );
    expect(out).toContain("- [success] (10:00) Started");
    expect(out).toContain("- [error] Failed — OOM");
  });

  it("formats callouts as block quotes with variant prefix", () => {
    const out = flattenRenderStateToText(
      state([
        {
          id: "co",
          type: "callout",
          variant: "warning",
          title: "Heads up",
          content: "Be careful.",
        },
      ]),
    );
    expect(out).toContain("> [WARNING]");
    expect(out).toContain("**Heads up**");
    expect(out).toContain("Be careful.");
  });

  it("formats separators with and without labels", () => {
    expect(
      flattenRenderStateToText(state([{ id: "s", type: "separator" }])),
    ).toBe("---");
    expect(
      flattenRenderStateToText(
        state([{ id: "s", type: "separator", label: "Section A" }]),
      ),
    ).toBe("--- Section A ---");
  });

  it("formats diffs as labeled before/after code blocks", () => {
    const out = flattenRenderStateToText(
      state([
        {
          id: "d",
          type: "diff",
          title: "Patch",
          before: { content: "old" },
          after: { content: "new" },
        },
      ]),
    );
    expect(out).toContain("### Patch");
    expect(out).toContain("**Before:**");
    expect(out).toContain("```\nold\n```");
    expect(out).toContain("**After:**");
    expect(out).toContain("```\nnew\n```");
  });

  it("formats checklists with [x] / [ ] markers", () => {
    const out = flattenRenderStateToText(
      state([
        {
          id: "ch",
          type: "checklist",
          items: [
            { label: "done item", checked: true },
            { label: "todo item", checked: false },
          ],
        },
      ]),
    );
    expect(out).toContain("- [x] done item");
    expect(out).toContain("- [ ] todo item");
  });

  it("formats tags as a comma-separated row", () => {
    const out = flattenRenderStateToText(
      state([
        {
          id: "tg",
          type: "tags",
          label: "Stack",
          items: [{ text: "ts" }, { text: "react" }, { text: "vite" }],
        },
      ]),
    );
    expect(out).toBe("**Stack**: ts, react, vite");
  });

  it("formats copyable as a fenced block with optional label, description, and language", () => {
    const minimal = flattenRenderStateToText(
      state([{ id: "cp", type: "copyable", content: "abc123" }]),
    );
    expect(minimal).toBe("```\nabc123\n```");

    const full = flattenRenderStateToText(
      state([
        {
          id: "cp",
          type: "copyable",
          label: "Token",
          description: "Use within 1 hour.",
          language: "bash",
          content: "export TOKEN=xyz",
        },
      ]),
    );
    expect(full).toContain("**Token**");
    expect(full).toContain("Use within 1 hour.");
    expect(full).toContain("```bash\nexport TOKEN=xyz\n```");
  });

  it("joins multiple components with blank-line separators", () => {
    const out = flattenRenderStateToText(
      state([
        { id: "m", type: "metric", label: "A", value: "1" },
        { id: "n", type: "metric", label: "B", value: "2" },
      ]),
    );
    expect(out).toBe("**A**: 1\n\n**B**: 2");
  });
});
