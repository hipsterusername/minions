/**
 * Tests for the MCP server file store. Uses a fresh temp directory per test
 * so no global state leaks across runs.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deleteMcpServer,
  listMcpServers,
  loadMcpServersByIds,
  mcpServersFilePath,
  saveMcpServer,
} from "./mcp-server-store.ts";
import type { McpServerEntry } from "../shared/mcp-servers/types.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeStdio(over: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    id: "my-server",
    name: "My Server",
    transport: "stdio",
    command: "node",
    ...over,
  } as McpServerEntry;
}

function makeSse(over: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    id: "sse-server",
    name: "SSE Server",
    transport: "sse",
    url: "https://example.com/sse",
    ...over,
  } as McpServerEntry;
}

function makeHttp(over: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    id: "http-server",
    name: "HTTP Server",
    transport: "http",
    url: "https://example.com/mcp",
    ...over,
  } as McpServerEntry;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("mcp-server-store", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-store-"));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // ── listMcpServers ──────────────────────────────────────────────────────────

  describe("listMcpServers", () => {
    it("returns empty results when the file does not exist", () => {
      expect(listMcpServers(projectDir)).toEqual({ entries: [], invalid: [] });
    });

    it("returns empty results for an empty JSON array", () => {
      const p = mcpServersFilePath(projectDir);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "[]");
      expect(listMcpServers(projectDir)).toEqual({ entries: [], invalid: [] });
    });

    it("returns entries sorted by id", () => {
      saveMcpServer(projectDir, makeStdio({ id: "zulu", name: "Z" }));
      saveMcpServer(projectDir, makeStdio({ id: "alpha", name: "A" }));
      saveMcpServer(projectDir, makeStdio({ id: "mike", name: "M" }));
      const { entries, invalid } = listMcpServers(projectDir);
      expect(entries.map((e) => e.id)).toEqual(["alpha", "mike", "zulu"]);
      expect(invalid).toEqual([]);
    });

    it("skips malformed entries and reports them in invalid", () => {
      saveMcpServer(projectDir, makeStdio({ id: "good" }));
      // Inject a malformed entry directly into the file.
      const p = mcpServersFilePath(projectDir);
      const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as unknown[];
      raw.push({ id: "bad-entry", transport: "unknown-transport" });
      fs.writeFileSync(p, JSON.stringify(raw));

      const { entries, invalid } = listMcpServers(projectDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.id).toBe("good");
      expect(invalid).toHaveLength(1);
      expect(invalid[0]!.errors.length).toBeGreaterThan(0);
    });

    it("tolerates non-array JSON without throwing", () => {
      const p = mcpServersFilePath(projectDir);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ not: "an array" }));
      expect(listMcpServers(projectDir)).toEqual({ entries: [], invalid: [] });
    });

    it("tolerates invalid JSON without throwing", () => {
      const p = mcpServersFilePath(projectDir);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "{ not valid json");
      expect(listMcpServers(projectDir)).toEqual({ entries: [], invalid: [] });
    });

    it("preserves all three transport types", () => {
      saveMcpServer(projectDir, makeStdio({ id: "s" }));
      saveMcpServer(projectDir, makeSse({ id: "e" }));
      saveMcpServer(projectDir, makeHttp({ id: "h" }));
      const { entries } = listMcpServers(projectDir);
      const transports = new Set(entries.map((e) => e.transport));
      expect(transports).toEqual(new Set(["stdio", "sse", "http"]));
    });
  });

  // ── loadMcpServersByIds ─────────────────────────────────────────────────────

  describe("loadMcpServersByIds", () => {
    it("returns empty when ids is empty", () => {
      saveMcpServer(projectDir, makeStdio());
      expect(loadMcpServersByIds(projectDir, [])).toEqual([]);
    });

    it("drops unknown ids silently", () => {
      saveMcpServer(projectDir, makeStdio({ id: "real" }));
      const result = loadMcpServersByIds(projectDir, ["real", "ghost"]);
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe("real");
    });

    it("returns entries in the requested id order", () => {
      saveMcpServer(projectDir, makeStdio({ id: "a" }));
      saveMcpServer(projectDir, makeStdio({ id: "b" }));
      saveMcpServer(projectDir, makeStdio({ id: "c" }));
      const result = loadMcpServersByIds(projectDir, ["c", "a"]);
      expect(result.map((e) => e.id)).toEqual(["c", "a"]);
    });

    it("returns empty when all ids are unknown", () => {
      const result = loadMcpServersByIds(projectDir, ["x", "y"]);
      expect(result).toEqual([]);
    });
  });

  // ── saveMcpServer ───────────────────────────────────────────────────────────

  describe("saveMcpServer", () => {
    it("creates a new stdio entry", () => {
      const saved = saveMcpServer(projectDir, makeStdio({ id: "new-srv" }));
      expect(saved.id).toBe("new-srv");
      expect(saved.transport).toBe("stdio");
      expect(listMcpServers(projectDir).entries).toHaveLength(1);
    });

    it("creates a new SSE entry", () => {
      saveMcpServer(projectDir, makeSse({ id: "my-sse" }));
      const { entries } = listMcpServers(projectDir);
      expect(entries[0]!.transport).toBe("sse");
    });

    it("creates a new HTTP entry", () => {
      saveMcpServer(projectDir, makeHttp({ id: "my-http" }));
      const { entries } = listMcpServers(projectDir);
      expect(entries[0]!.transport).toBe("http");
    });

    it("replaces an existing entry with the same id", () => {
      saveMcpServer(projectDir, makeStdio({ id: "srv", name: "Old" }));
      saveMcpServer(projectDir, makeStdio({ id: "srv", name: "New" }));
      const { entries } = listMcpServers(projectDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.name).toBe("New");
    });

    it("creates the sidecar directory when missing", () => {
      expect(fs.existsSync(mcpServersFilePath(projectDir))).toBe(false);
      saveMcpServer(projectDir, makeStdio());
      expect(fs.existsSync(mcpServersFilePath(projectDir))).toBe(true);
    });

    it("round-trips a fully-populated entry unchanged", () => {
      const entry: McpServerEntry = {
        id: "full-entry",
        name: "Full",
        description: "A complete entry",
        transport: "stdio",
        command: "npx",
        args: ["-y", "my-package"],
        env: { KEY: "value" },
        toolNames: ["do_thing", "other_tool"],
      };
      saveMcpServer(projectDir, entry);
      const loaded = loadMcpServersByIds(projectDir, ["full-entry"]);
      expect(loaded[0]).toEqual(entry);
    });

    it("rejects an invalid entry without writing", () => {
      const bad = { id: "bad", name: "Bad", transport: "unknown" };
      expect(() =>
        saveMcpServer(projectDir, bad as unknown as McpServerEntry),
      ).toThrow();
      expect(listMcpServers(projectDir).entries).toHaveLength(0);
    });

    it("keeps list sorted by id after each save", () => {
      saveMcpServer(projectDir, makeStdio({ id: "zulu" }));
      saveMcpServer(projectDir, makeStdio({ id: "alpha" }));
      saveMcpServer(projectDir, makeStdio({ id: "mike" }));
      const { entries } = listMcpServers(projectDir);
      expect(entries.map((e) => e.id)).toEqual(["alpha", "mike", "zulu"]);
    });
  });

  // ── deleteMcpServer ─────────────────────────────────────────────────────────

  describe("deleteMcpServer", () => {
    it("removes an existing entry and returns true", () => {
      saveMcpServer(projectDir, makeStdio({ id: "doomed" }));
      expect(deleteMcpServer(projectDir, "doomed")).toBe(true);
      expect(listMcpServers(projectDir).entries).toHaveLength(0);
    });

    it("returns false when the id does not exist", () => {
      expect(deleteMcpServer(projectDir, "ghost")).toBe(false);
    });

    it("does not remove sibling entries", () => {
      saveMcpServer(projectDir, makeStdio({ id: "keep" }));
      saveMcpServer(projectDir, makeStdio({ id: "doomed" }));
      deleteMcpServer(projectDir, "doomed");
      const { entries } = listMcpServers(projectDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.id).toBe("keep");
    });

    it("is idempotent — deleting twice returns false second time", () => {
      saveMcpServer(projectDir, makeStdio({ id: "once" }));
      expect(deleteMcpServer(projectDir, "once")).toBe(true);
      expect(deleteMcpServer(projectDir, "once")).toBe(false);
    });
  });
});
