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

/** Absolute path to the mcp-servers.json file for a project. */
export function mcpServersFilePath(projectPath: string): string {
  return path.join(projectPath, SIDECAR_DIR, MCP_SERVERS_FILE);
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

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
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

/** Convert persisted entries into the native shape consumed by Claude's SDK.
 * Keeping this conversion beside storage gives launch producers one explicit,
 * tested boundary instead of passing sidecar records through accidentally. */
export function resolveClaudeMcpServers(
  entries: readonly McpServerEntry[],
): { servers: Record<string, unknown>; allowedTools: string[] } {
  const servers: Record<string, unknown> = {};
  const allowedTools: string[] = [];
  for (const entry of entries) {
    const {
      id,
      name: _name,
      description: _description,
      toolNames,
      transport,
      ...config
    } = entry;
    servers[id] = transport === "stdio"
      ? { type: "stdio", ...config }
      : { type: transport, ...config };
    for (const toolName of toolNames ?? []) {
      allowedTools.push(`mcp__${id}__${toolName}`);
    }
  }
  return { servers, allowedTools };
}

/** Result shape for {@link listMcpServers}. */
export interface ListMcpServersResult {
  entries: McpServerEntry[];
  invalid: { index: number; errors: { path: string; message: string }[] }[];
  securityWarnings: { id: string; messages: string[] }[];
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
  const securityWarnings = entries.flatMap((entry) => {
    const messages = mcpServerSecurityWarnings(entry);
    return messages.length > 0 ? [{ id: entry.id, messages }] : [];
  });
  return { entries, invalid, securityWarnings };
}

/** Capability warnings suitable for an API/UI to show before enabling a
 * project-owned server. Never include secret values in these messages. */
export function mcpServerSecurityWarnings(entry: McpServerEntry): string[] {
  const messages: string[] = [];
  if (entry.transport === "stdio") {
    messages.push(
      "This server executes a local command with the Minions process user's privileges.",
    );
    if (entry.env && Object.keys(entry.env).length > 0) {
      messages.push(
        "Environment values are stored in the project sidecar; do not commit the .minions directory.",
      );
    }
  } else if (entry.headers && Object.keys(entry.headers).length > 0) {
    messages.push(
      "HTTP header values are stored in the project sidecar; do not commit the .minions directory.",
    );
  }
  return messages;
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
