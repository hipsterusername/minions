/**
 * Form component for the render DSL.
 *
 * Defines the schema, types, and markdown-formatting helper for agent-driven
 * interactive forms. The agent renders a form, the user fills it, and the
 * answers are injected back into the session as a synthetic user turn via the
 * `submit_form` WebSocket command.
 *
 * Kept separate from `shared/render-dsl.ts` so the Leader can wire it in
 * independently. Shared by the server (validation), client (rendering), and
 * the context-extraction pipeline (formatForm).
 */

import { z } from "zod/v4";
import { spanSchema } from "./render-base.ts";

// ── Field kind vocabulary ──────────────────────────────────

export const formFieldKindSchema = z.enum([
  "text",
  "textarea",
  "number",
  "select",
  "multiselect",
  "slider",
  "checkbox",
  "date",
]);

export type FormFieldKind = z.infer<typeof formFieldKindSchema>;

// ── Individual field schema ────────────────────────────────

export const formFieldSchema = z.object({
  id: z.string(),
  kind: formFieldKindSchema,
  label: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
    .optional(),
  placeholder: z.string().optional(),
  /** Regex source string for text/textarea validation. */
  pattern: z.string().optional(),
  maxLength: z.number().optional(),
  /** Lower bound for number/slider fields. */
  min: z.number().optional(),
  /** Upper bound for number/slider fields. */
  max: z.number().optional(),
  step: z.number().optional(),
  /** Options for select/multiselect. Each entry is a bare string or {value, label}. */
  options: z
    .array(
      z.union([
        z.string(),
        z.object({ value: z.string(), label: z.string() }),
      ]),
    )
    .optional(),
});

export type FormField = z.infer<typeof formFieldSchema>;

// ── Form component schema ──────────────────────────────────

export const formComponentSchema = z.object({
  id: z.string(),
  type: z.literal("form"),
  title: z.string().optional(),
  description: z.string().optional(),
  fields: z.array(formFieldSchema),
  submitLabel: z.string().optional(),
  /**
   * Set by the client after the user submits (or by the agent on a patch)
   * so the form locks into a read-only "submitted" state.
   */
  submittedAnswers: z.record(z.string(), z.unknown()).optional(),
  span: spanSchema.optional(),
});

export type FormComponent = z.infer<typeof formComponentSchema>;

// ── formatForm helper ──────────────────────────────────────

/**
 * Produce a compact markdown summary of a FormComponent for the
 * context-extraction pipeline (`flattenRenderStateToText`).
 *
 * Example output:
 * ```
 * ### Form: Confirm deploy
 * - env (select, required): staging | prod
 * - canary (slider, 0–100, default 10)
 *
 * Answers:
 * - env: prod
 * - canary: 25
 * ```
 */
export function formatForm(c: FormComponent): string {
  const lines: string[] = [];

  const heading = c.title ? `### Form: ${c.title}` : "### Form";
  lines.push(heading);

  if (c.description) {
    lines.push(c.description);
    lines.push("");
  }

  for (const field of c.fields) {
    lines.push(formatField(field));
  }

  if (c.submittedAnswers != null) {
    lines.push("");
    lines.push("Answers:");
    for (const [key, value] of Object.entries(c.submittedAnswers)) {
      const displayValue = Array.isArray(value)
        ? value.join(", ")
        : String(value ?? "");
      lines.push(`- ${key}: ${displayValue}`);
    }
  }

  return lines.join("\n");
}

/** Produce a single bullet line describing one form field. */
function formatField(field: FormField): string {
  const parts: string[] = [field.kind];

  if (field.required) parts.push("required");

  if (field.kind === "slider" || field.kind === "number") {
    const rangeParts: string[] = [];
    if (field.min != null) rangeParts.push(String(field.min));
    if (field.max != null) rangeParts.push(String(field.max));
    if (rangeParts.length === 2) {
      parts.push(`${rangeParts[0]}–${rangeParts[1]}`);
    }
  }

  if (field.default != null) {
    parts.push(`default ${String(field.default)}`);
  }

  const meta = parts.join(", ");
  const base = `- ${field.label} (${meta})`;

  if (
    (field.kind === "select" || field.kind === "multiselect") &&
    field.options != null &&
    field.options.length > 0
  ) {
    const optLabels = field.options.map((o) =>
      typeof o === "string" ? o : o.label,
    );
    return `${base}: ${optLabels.join(" | ")}`;
  }

  return base;
}
