/**
 * Tests for shared/render-containers.ts — schema parsing and format helpers.
 *
 * Schema tests verify that the Zod objects accept valid input and reject
 * missing-required-field shapes. Format-helper tests verify the markdown
 * output contract that the server-side text flattener relies on.
 */

import { describe, it, expect } from "vitest";
import {
  sectionComponentSchema,
  tabsComponentSchema,
  formatSection,
  formatTabs,
} from "./render-containers.ts";
import type { SectionComponent, TabsComponent } from "./render-containers.ts";
import type { RenderComponent } from "./render-dsl.ts";

// ── Shared fixtures ────────────────────────────────────────

const mockChild: RenderComponent = { id: "c1", type: "text", content: "hello" };

const formatChild = (c: RenderComponent): string => c.id;

// ── sectionComponentSchema ─────────────────────────────────

describe("sectionComponentSchema", () => {
  it("parses a minimal valid section", () => {
    const result = sectionComponentSchema.safeParse({
      id: "s1",
      type: "section",
      title: "My Section",
      components: [],
    });
    expect(result.success).toBe(true);
  });

  it("parses a section with all optional fields", () => {
    const result = sectionComponentSchema.safeParse({
      id: "s1",
      type: "section",
      title: "Full Section",
      defaultOpen: false,
      badge: "3",
      components: [{ id: "c1", type: "text", content: "hi" }],
      span: "full",
    });
    expect(result.success).toBe(true);
  });

  it("accepts unknown child shapes (loose children schema)", () => {
    const result = sectionComponentSchema.safeParse({
      id: "s1",
      type: "section",
      title: "Nested",
      components: [{ id: "inner", type: "section", title: "Inner", components: [] }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts numeric span", () => {
    const result = sectionComponentSchema.safeParse({
      id: "s1",
      type: "section",
      title: "Spanned",
      components: [],
      span: 2,
    });
    expect(result.success).toBe(true);
  });

  it("rejects when type does not match literal", () => {
    const result = sectionComponentSchema.safeParse({
      id: "s1",
      type: "tabs",
      title: "Wrong Type",
      components: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects when required title is missing", () => {
    const result = sectionComponentSchema.safeParse({
      id: "s1",
      type: "section",
      components: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects when id is missing", () => {
    const result = sectionComponentSchema.safeParse({
      type: "section",
      title: "No ID",
      components: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects when components is not an array", () => {
    const result = sectionComponentSchema.safeParse({
      id: "s1",
      type: "section",
      title: "Bad Components",
      components: "not an array",
    });
    expect(result.success).toBe(false);
  });
});

// ── tabsComponentSchema ────────────────────────────────────

describe("tabsComponentSchema", () => {
  it("parses a minimal valid tabs component (empty tabs array)", () => {
    const result = tabsComponentSchema.safeParse({
      id: "t1",
      type: "tabs",
      tabs: [],
    });
    expect(result.success).toBe(true);
  });

  it("parses tabs with children and optional fields", () => {
    const result = tabsComponentSchema.safeParse({
      id: "t1",
      type: "tabs",
      activeTabId: "tab-a",
      tabs: [
        { id: "tab-a", label: "Tab A", components: [] },
        {
          id: "tab-b",
          label: "Tab B",
          badge: "2",
          components: [{ id: "c1", type: "text", content: "hi" }],
        },
      ],
      span: 2,
    });
    expect(result.success).toBe(true);
  });

  it("accepts unknown child shapes inside tabs (loose schema)", () => {
    const result = tabsComponentSchema.safeParse({
      id: "t1",
      type: "tabs",
      tabs: [
        {
          id: "tab-a",
          label: "Tab A",
          components: [{ id: "inner", type: "section", title: "Nested", components: [] }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects when type does not match literal", () => {
    const result = tabsComponentSchema.safeParse({
      id: "t1",
      type: "section",
      tabs: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects when tabs array is missing", () => {
    const result = tabsComponentSchema.safeParse({
      id: "t1",
      type: "tabs",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when a tab is missing required label", () => {
    const result = tabsComponentSchema.safeParse({
      id: "t1",
      type: "tabs",
      tabs: [{ id: "tab-a", components: [] }],
    });
    expect(result.success).toBe(false);
  });
});

// ── formatSection ──────────────────────────────────────────

describe("formatSection", () => {
  it("formats title as h2 followed by a single child", () => {
    const c: SectionComponent = {
      id: "s1",
      type: "section",
      title: "My Section",
      components: [mockChild],
    };
    expect(formatSection(c, formatChild)).toBe("## My Section\n\nc1");
  });

  it("joins multiple children with double newline", () => {
    const c2: RenderComponent = { id: "c2", type: "text", content: "world" };
    const c: SectionComponent = {
      id: "s1",
      type: "section",
      title: "Section",
      components: [mockChild, c2],
    };
    expect(formatSection(c, formatChild)).toBe("## Section\n\nc1\n\nc2");
  });

  it("returns heading followed by empty string when components is empty", () => {
    const c: SectionComponent = {
      id: "s1",
      type: "section",
      title: "Empty",
      components: [],
    };
    expect(formatSection(c, formatChild)).toBe("## Empty\n\n");
  });

  it("delegates child formatting to the supplied callback", () => {
    const calls: RenderComponent[] = [];
    const trackingFormatter = (child: RenderComponent): string => {
      calls.push(child);
      return `[${child.id}]`;
    };
    const c: SectionComponent = {
      id: "s1",
      type: "section",
      title: "Track",
      components: [mockChild],
    };
    const result = formatSection(c, trackingFormatter);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(mockChild);
    expect(result).toBe("## Track\n\n[c1]");
  });
});

// ── formatTabs ─────────────────────────────────────────────

describe("formatTabs", () => {
  it("formats each tab as h3 with its children below", () => {
    const c: TabsComponent = {
      id: "t1",
      type: "tabs",
      tabs: [
        { id: "tab-a", label: "Tab A", components: [mockChild] },
        { id: "tab-b", label: "Tab B", components: [] },
      ],
    };
    expect(formatTabs(c, formatChild)).toBe("### Tab A\n\nc1\n\n### Tab B\n\n");
  });

  it("handles a single tab with multiple children", () => {
    const c2: RenderComponent = { id: "c2", type: "text", content: "world" };
    const c: TabsComponent = {
      id: "t1",
      type: "tabs",
      tabs: [{ id: "tab-a", label: "First", components: [mockChild, c2] }],
    };
    expect(formatTabs(c, formatChild)).toBe("### First\n\nc1\n\nc2");
  });

  it("returns empty string when tabs array is empty", () => {
    const c: TabsComponent = { id: "t1", type: "tabs", tabs: [] };
    expect(formatTabs(c, formatChild)).toBe("");
  });

  it("delegates child formatting to the supplied callback", () => {
    const calls: RenderComponent[] = [];
    const trackingFormatter = (child: RenderComponent): string => {
      calls.push(child);
      return `[${child.id}]`;
    };
    const c: TabsComponent = {
      id: "t1",
      type: "tabs",
      tabs: [{ id: "tab-a", label: "A", components: [mockChild] }],
    };
    const result = formatTabs(c, trackingFormatter);
    expect(calls).toHaveLength(1);
    expect(result).toBe("### A\n\n[c1]");
  });
});
