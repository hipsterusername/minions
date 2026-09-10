/** Additive history protocol: IDs identify immutable SQLite rows, cursors are exclusive. */
export interface HistoryReference { id: number; bytes: number; url: string }
export interface HistoryWindow { before: number | null; highWater: number; url: string }
export const HISTORY_PAGE_BYTES = 512 * 1024;
export const HISTORY_INLINE_BYTES = 64 * 1024;
export const HISTORY_EVENT_COUNT = 200;
/** Recognize generated placeholders in saved transcripts from older clients. */
export function isArchivePlaceholderText(text: string): boolean {
  const content = text.trim();
  return /^\[Read archived event \(\d+ bytes\)\]\(\/api\/history\/[^\s)]+\/events\/\d+\)$/.test(content)
    || /^(?:\[Archive preview\] )?Archived event \(\d+ bytes\)\. \[Download exact event JSON\]\(\/api\/history\/[^\s)]+\/events\/\d+\)/.test(content);
}
/** Conservative bounded traversal; never stringify an oversized object just to measure it. */
export function fitsInline(value: unknown, budget = HISTORY_INLINE_BYTES): boolean {
  const seen = new Set<object>();
  function visit(v: unknown): boolean {
    if (typeof v === "string") { budget -= v.length * 6 + 2; return budget >= 0; }
    budget -= 16;
    if (budget < 0) return false;
    if (!v || typeof v !== "object") return true;
    if (seen.has(v)) return false;
    seen.add(v);
    for (const key in v) {
      if (!Object.hasOwn(v, key)) continue;
      if (!visit(key) || !visit((v as Record<string, unknown>)[key])) return false;
    }
    seen.delete(v);
    return true;
  }
  return visit(value);
}
