/**
 * Node search — turn the canvas node list into searchable entries for the
 * command palette (Ctrl+K).
 *
 * Kept out of Canvas.tsx so the matching logic is pure and unit-testable.
 * The palette lets a user jump to an existing node by typing part of its
 * title or content; this module derives a title/snippet/haystack for any
 * node type without the palette needing to know per-type data shapes.
 */
import type { CanvasNode } from "./types.ts";
import { getContentExtractor, getNodeType } from "./node-registry.ts";

export interface NodeSearchEntry {
  nodeId: string;
  /** Human title shown as the primary row label. */
  title: string;
  /** Registry label for the node type (e.g. "Leader", "Markdown"). */
  typeLabel: string;
  /** Short one-line content preview (may be empty). */
  snippet: string;
  /** Lowercased combined text used for matching. */
  haystack: string;
}

// Fields that make a good human title, in priority order.
const TITLE_FIELDS = [
  "taskName",
  "title",
  "name",
  "filePath",
  "filename",
  "folderPath",
  "label",
] as const;

// Fields that hold body content when the registry has no extractor.
const CONTENT_FIELDS = ["content", "text", "prompt", "loadedContent"] as const;

function firstString(
  data: Record<string, unknown>,
  fields: readonly string[],
): string {
  for (const field of fields) {
    const value = data[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Collapse whitespace and clip to a single-line preview. */
function toSnippet(content: string, max = 90): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Build a searchable entry for a single node. */
export function nodeSearchEntry(node: CanvasNode): NodeSearchEntry {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const typeLabel = getNodeType(node.type)?.label ?? node.type;

  const extractor = getContentExtractor(node.type);
  const content =
    (extractor ? extractor(node.data) : null)?.trim() ||
    firstString(data, CONTENT_FIELDS);

  let title = firstString(data, TITLE_FIELDS);
  if (!title) {
    const firstLine = content.split("\n")[0]?.trim() ?? "";
    title = firstLine ? toSnippet(firstLine, 60) : typeLabel;
  }

  const snippet = toSnippet(content);
  const haystack = `${title} ${typeLabel} ${content}`.toLowerCase();

  return { nodeId: node.id, title, typeLabel, snippet, haystack };
}

/**
 * Order-preserving subsequence match — every char of `needle` appears in
 * `haystack` in order. Mirrors the palette's create-action fuzzy match so
 * typing "ldr" still finds "leader".
 */
function subsequenceMatch(haystack: string, needle: string): boolean {
  let index = 0;
  for (const ch of needle) {
    index = haystack.indexOf(ch, index);
    if (index === -1) return false;
    index += 1;
  }
  return true;
}

/**
 * Filter + rank nodes against a query. Empty query returns every node in
 * canvas order. Substring hits rank above looser subsequence hits.
 */
export function searchNodes(
  nodes: CanvasNode[],
  query: string,
): NodeSearchEntry[] {
  const entries = nodes.map(nodeSearchEntry);
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;

  const scored: Array<{ entry: NodeSearchEntry; score: number }> = [];
  for (const entry of entries) {
    if (entry.haystack.includes(needle)) {
      scored.push({ entry, score: 0 });
    } else if (subsequenceMatch(entry.haystack, needle)) {
      scored.push({ entry, score: 1 });
    }
  }
  // Stable sort by score (substring first); preserves canvas order within a tier.
  scored.sort((a, b) => a.score - b.score);
  return scored.map((s) => s.entry);
}
