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

  it("formats callouts even when variant has been elided from persisted state", () => {
    // Regression: server/render-tools.ts runs elideDefaults on incoming
    // components, which strips `variant: "info"` (the documented default).
    // Connecting such a Dashboard to a Leader pipes that state through
    // flattenRenderStateToText, so the formatter must tolerate a missing
    // variant rather than crashing on `c.variant.toUpperCase()`.
    const elidedCallout = {
      id: "cl",
      type: "callout",
      content: "heads up",
    } as unknown as RenderComponent;

    const out = flattenRenderStateToText(state([elidedCallout]));

    expect(out).toContain("[INFO]");
    expect(out).toContain("heads up");
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
