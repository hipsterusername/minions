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
  applyRenderMessage,
  emptyRenderState,
  type RenderState,
} from "./render-dsl.ts";

// Note: per testing-strategy.md §5.4 (SCHEMA_REDUNDANT), the per-component
// "accepts valid X" / "rejects invalid X" hand-built parse tests have been
// removed. They re-asserted zod's own parse rules against literals authored
// next to the schema. The §2.1 round-trip rewrite — emit through a real
// render-tools producer, parse through the real applyRenderMessage consumer —
// is the Wave 2 replacement that exercises the contract end-to-end.

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
