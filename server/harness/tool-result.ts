/**
 * Token-efficient NormalizedToolResult builders.
 *
 * Every MCP tool result is paid for twice: once when the harness streams it
 * to the model, and again on every subsequent turn it sits in context. These
 * helpers are the harness's affordance for keeping that cost minimal:
 *
 *  - `okResult()`        — constant terse ack. Use when the call succeeded and
 *                          the model gains nothing from a restatement of its
 *                          own input. The model already has its arguments in
 *                          context; echoing them back is pure token waste.
 *  - `textResult(text)`  — one short text block carrying NEW information only.
 *  - `errorResult(text)` — same, with `isError` set.
 *  - `jsonResult(value)` — compact (non-pretty-printed) JSON with `null` and
 *                          `undefined` object fields stripped recursively.
 *                          Pretty-printing roughly doubles the token count of
 *                          structured payloads; null fields are absence
 *                          encoded as presence.
 *
 * Rule of thumb for tool authors: a result should contain only information
 * the model could not reconstruct from its own tool-call arguments.
 *
 * The architecture test `tests/architecture/token-efficient-tool-results.test.ts`
 * enforces the no-pretty-print rule across all tool modules.
 */

import type { NormalizedToolResult } from "./types.ts";

/** Constant minimal acknowledgement for successful, no-news tool calls. */
export function okResult(): NormalizedToolResult {
  return { content: [{ type: "text", text: "ok" }] };
}

/** Single text block. Keep it to new information only — never echo input. */
export function textResult(text: string): NormalizedToolResult {
  return { content: [{ type: "text", text }] };
}

/** Single text block flagged as an error. */
export function errorResult(text: string): NormalizedToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Compact JSON result: no indentation, `null`/`undefined` object fields
 * stripped recursively. Array elements are preserved positionally (a `null`
 * inside an array is kept — removing it would shift meaning).
 */
export function jsonResult(
  value: unknown,
  opts?: { isError?: boolean },
): NormalizedToolResult {
  return {
    content: [{ type: "text", text: compactJson(value) }],
    ...(opts?.isError ? { isError: true } : {}),
  };
}

/** Serialize as compact JSON with null/undefined object fields elided. */
export function compactJson(value: unknown): string {
  return JSON.stringify(stripAbsent(value));
}

/**
 * Recursively drop object entries whose value is `null` or `undefined`.
 * Arrays keep their elements (positions can be meaningful); nested objects
 * inside arrays are still stripped.
 */
export function stripAbsent(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => stripAbsent(v));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      out[k] = stripAbsent(v);
    }
    return out;
  }
  return value;
}
