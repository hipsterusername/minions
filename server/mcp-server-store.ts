/**
 * MCP server file storage.
 *
 * Server configs live in one JSON file at
 * `<projectPath>/.minions/mcp-servers.json`. This mirrors the flat
 * array format used by `skills.json` in `project-store.ts`: one file for
 * all entries, parsed as an array, each entry validated independently.
 *
 * Malformed entries are skipped during list operations rather than
 * throwing — matching the project-store's tolerance for hand-edited
 * sidecar files.
 */

import fs from "node:fs";
import path from "node:path";
import {
  safeParseMcpServerEntry,
  parseMcpServerEntry,
  type McpServerEntry,
} from "../shared/mcp-servers/types.ts";

const SIDECAR_DIR = ".minions";
const MCP_SERVERS_FILE = "mcp-servers.json";

// ── Paths ───────────────────────────────────────────────────────────────────

/** Absolute path to the mcp-servers.json file for a project. */
export function mcpServersFilePath(projectPath: string): string {
  return path.join(projectPath, SIDECAR_DIR, MCP_SERVERS_FILE);
}

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

// ── Read raw array ──────────────────────────────────────────────────────────

function readRawEntries(projectPath: string): unknown[] {
  const filePath = mcpServersFilePath(projectPath);
  if (!fs.existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRawEntries(projectPath: string, entries: McpServerEntry[]): void {
  const filePath = mcpServersFilePath(projectPath);
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2));
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Result shape for {@link listMcpServers}. */
export interface ListMcpServersResult {
  entries: McpServerEntry[];
  invalid: { index: number; errors: { path: string; message: string }[] }[];
}

/**
 * List every MCP server in the project's sidecar. Missing file = empty
 * result. Each entry is parsed independently so one bad entry cannot
 * poison the rest.
 */
export function listMcpServers(projectPath: string): ListMcpServersResult {
  const raw = readRawEntries(projectPath);
  const entries: McpServerEntry[] = [];
  const invalid: ListMcpServersResult["invalid"] = [];

  for (let i = 0; i < raw.length; i++) {
    const result = safeParseMcpServerEntry(raw[i]);
    if (result.ok) {
      entries.push(result.entry);
    } else {
      invalid.push({ index: i, errors: result.errors });
    }
  }

  // Stable ordering by id.
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return { entries, invalid };
}

/**
 * Load MCP servers by ID from the project's sidecar. Unknown IDs are
 * silently dropped — the caller (step runner) may reference a server that
 * was deleted since a saved reference was authored. Returns entries in the order
 * of the requested ids.
 */
export function loadMcpServersByIds(
  projectPath: string,
  ids: readonly string[],
): McpServerEntry[] {
  if (ids.length === 0) return [];
  const { entries } = listMcpServers(projectPath);
  const byId = new Map(entries.map((e) => [e.id, e] as const));
  const out: McpServerEntry[] = [];
  for (const id of ids) {
    const entry = byId.get(id);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Save (create or replace) a single MCP server entry. Validates before
 * writing so the file always holds schema-valid entries.
 */
export function saveMcpServer(
  projectPath: string,
  entry: McpServerEntry,
): McpServerEntry {
  // Validate — throws ZodError on invalid input.
  const validated = parseMcpServerEntry(entry);

  const { entries } = listMcpServers(projectPath);
  const idx = entries.findIndex((e) => e.id === validated.id);
  if (idx >= 0) {
    entries[idx] = validated;
  } else {
    entries.push(validated);
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  writeRawEntries(projectPath, entries);
  return validated;
}

/**
 * Delete an MCP server by id. Returns true when removed, false when not
 * found (idempotent).
 */
export function deleteMcpServer(projectPath: string, id: string): boolean {
  const { entries } = listMcpServers(projectPath);
  const next = entries.filter((e) => e.id !== id);
  if (next.length === entries.length) return false;
  writeRawEntries(projectPath, next);
  return true;
}
