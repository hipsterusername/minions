/**
 * Unit tests for `applyRenderMessage` and `emptyRenderState`.
 *
 * Covers every action variant and the invariants we care about:
 *   - set: replaces components; merges layout only when provided
 *   - patch: updates matched components; preserves id and type; ignores unknowns
 *   - remove: filters by id; ignores unknown ids
 *   - append: adds new; replaces existing when id collides
 *   - emptyRenderState: canonical default shape
 */

import { describe, it, expect } from "vitest";
import { applyRenderMessage, emptyRenderState } from "./render-dsl.ts";
import type {
  RenderState,
  MetricComponent,
  TextComponent,
} from "./render-dsl.ts";

const metricA: MetricComponent = {
  id: "a",
  type: "metric",
  label: "Tasks",
  value: "3",
};

const textB: TextComponent = {
  id: "b",
  type: "text",
  content: "hello",
};

function baseState(): RenderState {
  return {
    layout: { columns: 3, gap: 8, title: "My Dashboard" },
    components: [metricA, textB],
  };
}

describe("emptyRenderState", () => {
  it("returns layout with columns 2 and gap 12", () => {
    expect(emptyRenderState()).toEqual({
      layout: { columns: 2, gap: 12 },
      components: [],
    });
  });

  it("returns a fresh object on each call", () => {
    const a = emptyRenderState();
    const b = emptyRenderState();
    expect(a).not.toBe(b);
  });
});

describe("applyRenderMessage", () => {
  describe("set", () => {
    it("replaces all components with the new list", () => {
      const next = applyRenderMessage(baseState(), {
        action: "set",
        layout: { columns: 2 },
        components: [metricA],
      });
      expect(next.components).toHaveLength(1);
      expect(next.components[0]?.id).toBe("a");
    });

    it("uses the provided layout when given", () => {
      const next = applyRenderMessage(baseState(), {
        action: "set",
        layout: { columns: 4, gap: 20 },
        components: [],
      });
      expect(next.layout).toEqual({ columns: 4, gap: 20 });
    });

    it("keeps existing layout when layout is omitted", () => {
      const state = baseState();
      const next = applyRenderMessage(state, {
        action: "set",
        components: [metricA],
      });
      expect(next.layout).toEqual(state.layout);
    });

    it("results in an empty component list when set with empty array", () => {
      const next = applyRenderMessage(baseState(), {
        action: "set",
        components: [],
      });
      expect(next.components).toHaveLength(0);
    });
  });

  describe("patch", () => {
    it("updates matching components by id", () => {
      const next = applyRenderMessage(baseState(), {
        action: "patch",
        updates: [{ id: "a", value: "99" }],
      });
      const updated = next.components.find((c) => c.id === "a") as MetricComponent;
      expect(updated.value).toBe("99");
    });

    it("preserves id on the patched component", () => {
      const next = applyRenderMessage(baseState(), {
        action: "patch",
        updates: [{ id: "a", value: "7" }],
      });
      expect(next.components.find((c) => c.id === "a")?.id).toBe("a");
    });

    it("preserves type on the patched component", () => {
      const next = applyRenderMessage(baseState(), {
        action: "patch",
        updates: [{ id: "a", value: "7" }],
      });
      expect(next.components.find((c) => c.id === "a")?.type).toBe("metric");
    });

    it("is a no-op for ids that do not exist", () => {
      const state = baseState();
      const next = applyRenderMessage(state, {
        action: "patch",
        updates: [{ id: "ghost" }],
      });
      expect(next.components).toEqual(state.components);
    });

    it("leaves untargeted components unchanged", () => {
      const next = applyRenderMessage(baseState(), {
        action: "patch",
        updates: [{ id: "a", value: "7" }],
      });
      const b = next.components.find((c) => c.id === "b") as TextComponent;
      expect(b.content).toBe("hello");
    });

    it("preserves layout", () => {
      const state = baseState();
      const next = applyRenderMessage(state, {
        action: "patch",
        updates: [{ id: "a", value: "42" }],
      });
      expect(next.layout).toEqual(state.layout);
    });
  });

  describe("remove", () => {
    it("filters out a component by id", () => {
      const next = applyRenderMessage(baseState(), {
        action: "remove",
        ids: ["a"],
      });
      expect(next.components.map((c) => c.id)).toEqual(["b"]);
    });

    it("can remove multiple ids at once", () => {
      const next = applyRenderMessage(baseState(), {
        action: "remove",
        ids: ["a", "b"],
      });
      expect(next.components).toHaveLength(0);
    });

    it("ignores unknown ids without error", () => {
      const state = baseState();
      const next = applyRenderMessage(state, {
        action: "remove",
        ids: ["does-not-exist"],
      });
      expect(next.components).toHaveLength(state.components.length);
    });

    it("preserves layout", () => {
      const state = baseState();
      const next = applyRenderMessage(state, {
        action: "remove",
        ids: ["a"],
      });
      expect(next.layout).toEqual(state.layout);
    });
  });

  describe("append", () => {
    it("adds new components after existing ones", () => {
      const newComp: TextComponent = { id: "c", type: "text", content: "new" };
      const next = applyRenderMessage(baseState(), {
        action: "append",
        components: [newComp],
      });
      expect(next.components).toHaveLength(3);
      expect(next.components[2]?.id).toBe("c");
    });

    it("replaces existing component when appended id collides", () => {
      const replacement: MetricComponent = {
        id: "a",
        type: "metric",
        label: "Replaced",
        value: "0",
      };
      const next = applyRenderMessage(baseState(), {
        action: "append",
        components: [replacement],
      });
      const found = next.components.find((c) => c.id === "a") as MetricComponent;
      expect(found.label).toBe("Replaced");
    });

    it("keeps only one component when an id collides", () => {
      const replacement: MetricComponent = {
        id: "a",
        type: "metric",
        label: "Replaced",
        value: "0",
      };
      const next = applyRenderMessage(baseState(), {
        action: "append",
        components: [replacement],
      });
      expect(next.components.filter((c) => c.id === "a")).toHaveLength(1);
    });

    it("preserves layout", () => {
      const state = baseState();
      const next = applyRenderMessage(state, {
        action: "append",
        components: [{ id: "z", type: "text", content: "z" }],
      });
      expect(next.layout).toEqual(state.layout);
    });
  });
});
