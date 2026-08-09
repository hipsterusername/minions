/**
 * Tests for shared/render-form.ts — schema parsing and formatForm helper.
 */

import { describe, it, expect } from "vitest";
import {
  formComponentSchema,
  formFieldSchema,
  formatForm,
  type FormComponent,
} from "./render-form.ts";

// ── Schema parse tests ─────────────────────────────────────

describe("formFieldSchema", () => {
  it("parses a minimal text field", () => {
    const result = formFieldSchema.safeParse({
      id: "name",
      kind: "text",
      label: "Name",
    });
    expect(result.success).toBe(true);
  });

  it("parses a slider field with all numeric constraints", () => {
    const result = formFieldSchema.safeParse({
      id: "pct",
      kind: "slider",
      label: "Percentage",
      min: 0,
      max: 100,
      step: 5,
      default: 10,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.min).toBe(0);
    expect(result.data.max).toBe(100);
    expect(result.data.default).toBe(10);
  });

  it("parses a select field with string options", () => {
    const result = formFieldSchema.safeParse({
      id: "env",
      kind: "select",
      label: "Environment",
      required: true,
      options: ["staging", "prod"],
    });
    expect(result.success).toBe(true);
  });

  it("parses a select field with {value, label} options", () => {
    const result = formFieldSchema.safeParse({
      id: "region",
      kind: "select",
      label: "Region",
      options: [
        { value: "us-east-1", label: "US East" },
        { value: "eu-west-1", label: "EU West" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("parses a multiselect with array default", () => {
    const result = formFieldSchema.safeParse({
      id: "tags",
      kind: "multiselect",
      label: "Tags",
      options: ["alpha", "beta", "gamma"],
      default: ["alpha"],
    });
    expect(result.success).toBe(true);
  });

  it("parses a checkbox field with boolean default", () => {
    const result = formFieldSchema.safeParse({
      id: "agree",
      kind: "checkbox",
      label: "I agree",
      default: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown kind", () => {
    const result = formFieldSchema.safeParse({
      id: "x",
      kind: "color-picker",
      label: "Color",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required id", () => {
    const result = formFieldSchema.safeParse({
      kind: "text",
      label: "Name",
    });
    expect(result.success).toBe(false);
  });
});

describe("formComponentSchema", () => {
  it("parses a minimal form with no fields", () => {
    const result = formComponentSchema.safeParse({
      id: "empty-form",
      type: "form",
      fields: [],
    });
    expect(result.success).toBe(true);
  });

  it("parses a complete form with all optional fields", () => {
    const result = formComponentSchema.safeParse({
      id: "deploy",
      type: "form",
      title: "Confirm deploy",
      description: "Review and confirm before proceeding.",
      fields: [
        { id: "env", kind: "select", label: "Environment", options: ["staging", "prod"] },
        { id: "canary", kind: "slider", label: "Canary %", min: 0, max: 100, default: 10 },
      ],
      submitLabel: "Deploy",
      span: "full",
    });
    expect(result.success).toBe(true);
  });

  it("parses a form with submittedAnswers (locked state)", () => {
    const result = formComponentSchema.safeParse({
      id: "f1",
      type: "form",
      fields: [{ id: "q", kind: "text", label: "Q" }],
      submittedAnswers: { q: "answer" },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.submittedAnswers).toEqual({ q: "answer" });
  });

  it("rejects a form with wrong type discriminant", () => {
    const result = formComponentSchema.safeParse({
      id: "f1",
      type: "metric",
      fields: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a form missing the id field", () => {
    const result = formComponentSchema.safeParse({
      type: "form",
      fields: [],
    });
    expect(result.success).toBe(false);
  });
});

// ── formatForm helper tests ────────────────────────────────

describe("formatForm", () => {
  const base: FormComponent = {
    id: "deploy",
    type: "form",
    title: "Confirm deploy",
    fields: [
      {
        id: "env",
        kind: "select",
        label: "env",
        required: true,
        options: ["staging", "prod"],
      },
      {
        id: "canary",
        kind: "slider",
        label: "canary",
        min: 0,
        max: 100,
        default: 10,
      },
    ],
  };

  it("starts with a heading that includes the title", () => {
    const text = formatForm(base);
    expect(text).toContain("### Form: Confirm deploy");
  });

  it("lists all fields as bullet lines", () => {
    const text = formatForm(base);
    expect(text).toContain("- env");
    expect(text).toContain("- canary");
  });

  it("includes 'required' in the field metadata when set", () => {
    const text = formatForm(base);
    expect(text).toMatch(/env.*required/);
  });

  it("appends select options with pipe separator", () => {
    const text = formatForm(base);
    expect(text).toContain("staging | prod");
  });

  it("includes min–max range for slider fields", () => {
    const text = formatForm(base);
    expect(text).toContain("0–100");
  });

  it("includes default value in slider metadata", () => {
    const text = formatForm(base);
    expect(text).toContain("default 10");
  });

  it("uses fallback heading '### Form' when title is absent", () => {
    const form: FormComponent = { ...base, title: undefined };
    const text = formatForm(form);
    expect(text.startsWith("### Form\n")).toBe(true);
  });

  it("includes description paragraph when present", () => {
    const form: FormComponent = { ...base, description: "Review carefully." };
    const text = formatForm(form);
    expect(text).toContain("Review carefully.");
  });

  it("does NOT include an Answers section when submittedAnswers is absent", () => {
    const text = formatForm(base);
    expect(text).not.toContain("Answers:");
  });

  it("includes Answers section with submitted values when present", () => {
    const form: FormComponent = {
      ...base,
      submittedAnswers: { env: "prod", canary: 25 },
    };
    const text = formatForm(form);
    expect(text).toContain("Answers:");
    expect(text).toContain("- env: prod");
    expect(text).toContain("- canary: 25");
  });

  it("renders {value, label} select options using the label", () => {
    const form: FormComponent = {
      id: "f",
      type: "form",
      fields: [
        {
          id: "region",
          kind: "select",
          label: "region",
          options: [
            { value: "us-east-1", label: "US East" },
            { value: "eu-west-1", label: "EU West" },
          ],
        },
      ],
    };
    const text = formatForm(form);
    expect(text).toContain("US East | EU West");
  });

  it("renders array answers as comma-joined string", () => {
    const form: FormComponent = {
      id: "f",
      type: "form",
      fields: [{ id: "tags", kind: "multiselect", label: "tags", options: ["a", "b"] }],
      submittedAnswers: { tags: ["a", "b"] },
    };
    const text = formatForm(form);
    expect(text).toContain("- tags: a, b");
  });

  it("handles a form with no fields gracefully", () => {
    const form: FormComponent = { id: "f", type: "form", fields: [] };
    const text = formatForm(form);
    expect(text).toBe("### Form");
  });
});
