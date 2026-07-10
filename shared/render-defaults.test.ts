/**
 * shared/render-defaults: every entry in `COMPONENT_DEFAULTS` is exercised
 * here so a future addition to the schema can't silently skip elision.
 *
 * The contract test at the bottom ensures the table covers every component
 * type the discriminated union knows about — preventing drift between the
 * schema and the elision rules.
 */
import { describe, it, expect } from "vitest";
import {
  COMPONENT_DEFAULTS,
  LAYOUT_DEFAULTS,
  elideDefaults,
  elideLayoutDefaults,
} from "./render-defaults.ts";
import {
  RENDER_COMPONENT_TYPES,
  renderComponentSchema,
  type RenderComponent,
} from "./render-dsl.ts";

describe("elideDefaults", () => {
  it("strips span=auto from any component", () => {
    const c: RenderComponent = {
      id: "m",
      type: "metric",
      label: "L",
      value: "1",
      span: "auto",
    };
    expect(elideDefaults(c)).toEqual({
      id: "m",
      type: "metric",
      label: "L",
      value: "1",
    });
  });

  it("preserves span when it is not auto", () => {
    const c: RenderComponent = {
      id: "m",
      type: "metric",
      label: "L",
      value: "1",
      span: "full",
    };
    expect(elideDefaults(c)).toEqual(c);
  });

  it("strips metric.trend=flat", () => {
    const before: RenderComponent = {
      id: "m",
      type: "metric",
      label: "L",
      value: "1",
      trend: "flat",
    };
    const after = elideDefaults(before);
    expect(after).not.toHaveProperty("trend");
  });

  it("preserves metric.trend when it carries information", () => {
    const c: RenderComponent = {
      id: "m",
      type: "metric",
      label: "L",
      value: "1",
      trend: "up",
    };
    expect(elideDefaults(c)).toEqual(c);
  });

  it("strips list.ordered=false", () => {
    const c: RenderComponent = {
      id: "l",
      type: "list",
      items: ["a", "b"],
      ordered: false,
    };
    expect(elideDefaults(c)).toEqual({
      id: "l",
      type: "list",
      items: ["a", "b"],
    });
  });

  it("strips callout.variant=info", () => {
    const c: RenderComponent = {
      id: "c",
      type: "callout",
      variant: "info",
      content: "hi",
    };
    expect(elideDefaults(c)).toEqual({
      id: "c",
      type: "callout",
      content: "hi",
    });
  });

  it("strips kv.layout=vertical", () => {
    const c: RenderComponent = {
      id: "kv",
      type: "kv",
      entries: [{ key: "a", value: "1" }],
      layout: "vertical",
    };
    expect(elideDefaults(c)).toEqual({
      id: "kv",
      type: "kv",
      entries: [{ key: "a", value: "1" }],
    });
  });

  it("strips sparkline.variant=line and showRange=false", () => {
    const c: RenderComponent = {
      id: "s",
      type: "sparkline",
      data: [1, 2, 3],
      variant: "line",
      showRange: false,
    };
    expect(elideDefaults(c)).toEqual({
      id: "s",
      type: "sparkline",
      data: [1, 2, 3],
    });
  });

  it("strips section.defaultOpen=false and recurses into children", () => {
    const c: RenderComponent = {
      id: "sec",
      type: "section",
      title: "T",
      defaultOpen: false,
      components: [
        {
          id: "child",
          type: "metric",
          label: "x",
          value: "1",
          trend: "flat",
          span: "auto",
        },
      ],
    };
    const out = elideDefaults(c);
    expect(out).not.toHaveProperty("defaultOpen");
    expect((out as { components: unknown[] }).components[0]).toEqual({
      id: "child",
      type: "metric",
      label: "x",
      value: "1",
    });
  });

  it("recurses into tabs > components", () => {
    const c: RenderComponent = {
      id: "t",
      type: "tabs",
      tabs: [
        {
          id: "a",
          label: "A",
          components: [
            {
              id: "x",
              type: "status",
              label: "S",
              state: "running",
              span: "auto",
            },
          ],
        },
      ],
    };
    const out = elideDefaults(c) as { tabs: { components: unknown[] }[] };
    expect(out.tabs[0]?.components[0]).toEqual({
      id: "x",
      type: "status",
      label: "S",
      state: "running",
    });
  });

  it("does not mutate the input", () => {
    const c: RenderComponent = {
      id: "m",
      type: "metric",
      label: "L",
      value: "1",
      span: "auto",
      trend: "flat",
    };
    const snapshot = JSON.parse(JSON.stringify(c)) as unknown;
    elideDefaults(c);
    expect(c).toEqual(snapshot);
  });

  it("leaves unknown types alone (forward compatibility)", () => {
    const c = { id: "u", type: "unknown-future", foo: "bar" } as unknown as RenderComponent;
    expect(elideDefaults(c)).toBe(c);
  });
});

describe("elideLayoutDefaults", () => {
  it("strips title='', columns=2, gap=12", () => {
    expect(elideLayoutDefaults({ title: "", columns: 2, gap: 12 })).toEqual({});
  });

  it("preserves non-default values", () => {
    expect(
      elideLayoutDefaults({ title: "Hi", columns: 3, gap: 12 }),
    ).toEqual({ title: "Hi", columns: 3 });
  });
});

describe("COMPONENT_DEFAULTS — schema parity", () => {
  it("covers every component type in the discriminated union", () => {
    // Pull the literal `type` value from each option of the discriminated
    // union — the same trick the server uses when echoing the schema.
    const options = (renderComponentSchema as unknown as {
      options: { shape: { type: { value: string } } }[];
    }).options;
    const schemaTypes = options.map((o) => o.shape.type.value).sort();
    const tableTypes = Object.keys(COMPONENT_DEFAULTS).sort();
    expect(tableTypes).toEqual(schemaTypes);
    expect([...RENDER_COMPONENT_TYPES].sort()).toEqual(schemaTypes);
  });

  it("LAYOUT_DEFAULTS keys match render_set's accepted layout fields", () => {
    expect(Object.keys(LAYOUT_DEFAULTS).sort()).toEqual(
      ["columns", "gap", "title"].sort(),
    );
  });
});
