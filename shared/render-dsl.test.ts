/**
 * Render DSL — single-schema parity tests.
 *
 * Phase 2 of the refactor collapsed the duplicated render DSL into
 * `shared/render-dsl.ts`. These tests cover:
 *
 *   1. Every component variant parses (happy path).
 *   2. Unknown types are rejected (no more `.passthrough()` silent accept).
 *   3. Messages (`set`/`patch`/`append`/`remove`) parse and apply.
 *   4. The reducer preserves the behavior from the pre-split client.
 */

import { describe, it, expect } from "vitest";
import {
  renderComponentSchema,
  renderMessageSchema,
  applyRenderMessage,
  emptyRenderState,
  type RenderComponent,
  type RenderState,
} from "./render-dsl.ts";

describe("render-dsl: component schema", () => {
  it("accepts a valid metric component", () => {
    const example: RenderComponent = {
      id: "m1",
      type: "metric",
      label: "Tests",
      value: "42",
      color: "green",
      trend: "up",
      detail: "vs. baseline 35",
    };
    expect(renderComponentSchema.parse(example)).toEqual(example);
  });

  it("accepts a minimal status component", () => {
    const example: RenderComponent = {
      id: "s1",
      type: "status",
      label: "Build",
      state: "success",
    };
    expect(renderComponentSchema.parse(example)).toEqual(example);
  });

  it("accepts a table component with empty rows", () => {
    const example: RenderComponent = {
      id: "t1",
      type: "table",
      headers: ["File", "Lines"],
      rows: [],
    };
    expect(renderComponentSchema.parse(example)).toEqual(example);
  });

  it("accepts a progress component with only required fields", () => {
    const example: RenderComponent = {
      id: "p1",
      type: "progress",
      label: "Coverage",
      value: 73,
    };
    expect(renderComponentSchema.parse(example)).toEqual(example);
  });

  it("accepts a code component with language and title", () => {
    const example: RenderComponent = {
      id: "c1",
      type: "code",
      language: "ts",
      content: "export const x = 1",
      title: "hello.ts",
    };
    expect(renderComponentSchema.parse(example)).toEqual(example);
  });

  it("accepts a copyable component with only required fields", () => {
    const example: RenderComponent = {
      id: "cp1",
      type: "copyable",
      content: "ssh-rsa AAAA...",
    };
    expect(renderComponentSchema.parse(example)).toEqual(example);
  });

  it("accepts a copyable component with all optional fields", () => {
    const example: RenderComponent = {
      id: "cp2",
      type: "copyable",
      content: "git checkout -b feature/foo",
      label: "Run this in your terminal",
      description: "Creates and switches to the feature branch.",
      language: "bash",
      variant: "block",
    };
    expect(renderComponentSchema.parse(example)).toEqual(example);
  });

  it("rejects a copyable with an invalid variant", () => {
    const res = renderComponentSchema.safeParse({
      id: "cp",
      type: "copyable",
      content: "x",
      variant: "tooltip",
    });
    expect(res.success).toBe(false);
  });

  it("rejects a copyable missing content", () => {
    const res = renderComponentSchema.safeParse({
      id: "cp",
      type: "copyable",
      label: "no content",
    });
    expect(res.success).toBe(false);
  });

  it("rejects an unknown component type", () => {
    const res = renderComponentSchema.safeParse({
      id: "x",
      type: "histogram",
      label: "nope",
    });
    expect(res.success).toBe(false);
  });

  it("rejects a metric missing required fields", () => {
    const res = renderComponentSchema.safeParse({
      id: "m1",
      type: "metric",
      // label and value missing
    });
    expect(res.success).toBe(false);
  });

  it("rejects a status with an invalid state", () => {
    const res = renderComponentSchema.safeParse({
      id: "s1",
      type: "status",
      label: "Build",
      state: "on-fire",
    });
    expect(res.success).toBe(false);
  });
});

describe("render-dsl: message schema", () => {
  it("parses a `set` message", () => {
    const msg = {
      action: "set" as const,
      layout: { columns: 3 },
      components: [
        { id: "m1", type: "metric" as const, label: "A", value: "1" },
      ],
    };
    expect(renderMessageSchema.parse(msg)).toEqual(msg);
  });

  it("parses a `patch` message with extra fields on the update", () => {
    const msg = {
      action: "patch" as const,
      updates: [
        { id: "m1", value: "99", color: "red" },
        { id: "s1", state: "error" },
      ],
    };
    expect(renderMessageSchema.parse(msg)).toEqual(msg);
  });

  it("parses an `append` message", () => {
    const msg = {
      action: "append" as const,
      components: [
        { id: "t1", type: "text" as const, content: "# Hi" },
      ],
    };
    expect(renderMessageSchema.parse(msg)).toEqual(msg);
  });

  it("parses a `remove` message", () => {
    const msg = { action: "remove" as const, ids: ["m1", "m2"] };
    expect(renderMessageSchema.parse(msg)).toEqual(msg);
  });

  it("rejects an unknown action", () => {
    const res = renderMessageSchema.safeParse({
      action: "nuke",
      components: [],
    });
    expect(res.success).toBe(false);
  });
});

describe("render-dsl: applyRenderMessage", () => {
  const base: RenderState = {
    layout: { columns: 2, gap: 12 },
    components: [
      { id: "m1", type: "metric", label: "A", value: "1" },
      { id: "m2", type: "metric", label: "B", value: "2" },
    ],
  };

  it("set replaces components and layout", () => {
    const next = applyRenderMessage(base, {
      action: "set",
      layout: { columns: 4 },
      components: [{ id: "t1", type: "text", content: "hi" }],
    });
    expect(next.layout).toEqual({ columns: 4 });
    expect(next.components).toHaveLength(1);
    expect(next.components[0]?.id).toBe("t1");
  });

  it("patch merges fields by id, preserves id + type", () => {
    const next = applyRenderMessage(base, {
      action: "patch",
      updates: [{ id: "m1", value: "42" }],
    });
    expect(next.components[0]).toEqual({
      id: "m1",
      type: "metric",
      label: "A",
      value: "42",
    });
  });

  it("patch preserves original type when patch attempts to change it", () => {
    const next = applyRenderMessage(base, {
      action: "patch",
      updates: [{ id: "m1", type: "text", content: "sneaky" }],
    });
    expect(next.components[0]?.type).toBe("metric");
  });

  it("patch ignores updates for unknown ids", () => {
    const next = applyRenderMessage(base, {
      action: "patch",
      updates: [{ id: "ghost", value: "nope" }],
    });
    expect(next.components).toEqual(base.components);
  });

  it("remove filters components by id set", () => {
    const next = applyRenderMessage(base, {
      action: "remove",
      ids: ["m1"],
    });
    expect(next.components).toHaveLength(1);
    expect(next.components[0]?.id).toBe("m2");
  });

  it("append adds new components and dedupes against existing ids", () => {
    const next = applyRenderMessage(base, {
      action: "append",
      components: [
        { id: "m2", type: "metric", label: "B2", value: "22" },
        { id: "m3", type: "metric", label: "C", value: "3" },
      ],
    });
    // m2 replaced; m1 preserved; m3 added
    expect(next.components.map((c) => c.id)).toEqual(["m1", "m2", "m3"]);
    expect(next.components[1]).toMatchObject({ label: "B2", value: "22" });
  });

  it("empty state has a default layout and no components", () => {
    const s = emptyRenderState();
    expect(s.components).toEqual([]);
    expect(s.layout.columns).toBe(2);
    expect(s.layout.gap).toBe(12);
  });
});
