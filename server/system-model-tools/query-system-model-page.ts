import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { compactJson, jsonResult } from "../harness/tool-result.ts";
import type { Query } from "./query-system-model-schema.ts";

export interface RetrievalEntry { target: "matches" | "diagnostics"; value: Record<string, unknown> }
const cursorSchema = z.object({ v: z.literal(1), r: z.string().regex(/^[a-f0-9]{64}$/),
  m: z.string().regex(/^[a-f0-9]{64}$/), i: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  o: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();

export function digest(value: unknown): string { return createHash("sha256").update(compactJson(canonical(value))).digest("hex"); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function retrievalError(status: string, message: string) {
  return jsonResult({ version: 1, status, error: message, matches: [], linked: [], diagnostics: [], fragments: [],
    page: { totalEntries: 0, complete: true } }, { isError: true });
}

/** Bound the actual normalized result, including nested JSON escaping and the content wrapper. */
export function retrievalPage(entries: RetrievalEntry[], metadata: Record<string, unknown>, query: Query, snapshot: string) {
  const { cursor, ...request } = query;
  const requestDigest = digest(request);
  let index = 0;
  let offset = 0;
  if (cursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw new Error();
      const decoded = Buffer.from(cursor, "base64url");
      if (decoded.length > 384 || decoded.toString("base64url") !== cursor) throw new Error();
      const parsed = cursorSchema.parse(JSON.parse(decoded.toString("utf8")));
      if (parsed.m !== snapshot) return retrievalError("stale_cursor", "Model snapshot changed; restart without cursor.");
      if (parsed.r !== requestDigest || parsed.i >= entries.length) throw new Error();
      index = parsed.i; offset = parsed.o;
    } catch { return retrievalError("invalid_cursor", "Invalid continuation; repeat the original arguments or restart without cursor."); }
  }
  const matches: Record<string, unknown>[] = [];
  const diagnostics: Record<string, unknown>[] = [];
  const encode = (i: number, o: number) => Buffer.from(JSON.stringify({ v: 1, r: requestDigest, m: snapshot, i, o })).toString("base64url");
  const build = (i: number, o: number, fragments: Record<string, unknown>[] = []) => jsonResult({
    version: 1, ...metadata, matches, linked: [], diagnostics, fragments,
    page: { totalEntries: entries.length, complete: i === entries.length, ...(i < entries.length ? { nextCursor: encode(i, o) } : {}) },
  }, { isError: metadata.status === "model_unavailable" });
  const fits = (result: ReturnType<typeof jsonResult>) => Buffer.byteLength(JSON.stringify(result)) <= query.maxResponseBytes;
  const overflow = () => retrievalError("response_budget_exceeded", "Response envelope cannot fit; restart with a larger maxResponseBytes.");
  if (!fits(build(index, offset))) return overflow();
  let started = 0;
  while (index < entries.length && started < query.topK) {
    const entry = entries[index]!;
    const value = { ...entry.value, entryIndex: index };
    const collection = entry.target === "matches" ? matches : diagnostics;
    if (offset === 0) {
      collection.push(value);
      if (fits(build(index + 1, 0))) { index++; started++; continue; }
      collection.pop();
      if (matches.length || diagnostics.length) break;
    }
    const points = Array.from(compactJson(canonical(value)));
    if (offset >= points.length) return retrievalError("invalid_cursor", "Invalid fragment offset; restart without cursor.");
    if (offset > 0) {
      collection.push(value);
      const ordinaryFits = fits(build(index + 1, 0));
      collection.pop();
      if (ordinaryFits) return retrievalError("invalid_cursor", "This entry is not fragmented; restart without cursor.");
    }
    const fragment = (end: number) => build(end === points.length ? index + 1 : index, end === points.length ? 0 : end, [{
      entryIndex: index, target: entry.target, encoding: "json-string", offset,
      nextOffset: end, totalCodePoints: points.length, text: points.slice(offset, end).join(""),
    }]);
    let low = offset + 1;
    let high = points.length;
    let best = offset;
    // A final fragment drops its cursor and can fit even when an intermediate prefix cannot.
    if (fits(fragment(high))) return fragment(high);
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (fits(fragment(middle))) { best = middle; low = middle + 1; } else high = middle - 1;
    }
    return best > offset ? fragment(best) : overflow();
  }
  return build(index, offset);
}
