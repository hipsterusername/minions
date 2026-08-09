
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deleteMcpServer,
  listMcpServers,
  loadMcpServersByIds,
  mcpServerSecurityWarnings,
  mcpServersFilePath,
  resolveClaudeMcpServers,
  saveMcpServer,
} from "./mcp-server-store.ts";
import type { McpServerEntry } from "../shared/mcp-servers/types.ts";
import { registerWorkspace } from "./workspace-registry.ts";

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

describe("mcp-server-store", () => {
  let projectDir: string;
  let minionsHome: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-store-"));
    minionsHome = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-home-"));
    vi.stubEnv("MINIONS_HOME", minionsHome);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(minionsHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  describe("listMcpServers", () => {
    it("returns empty results when the file does not exist", () => {
      expect(listMcpServers(projectDir)).toEqual({ entries: [], invalid: [], securityWarnings: [] });
    });

    it("returns entries sorted by id", () => {
      saveMcpServer(projectDir, makeStdio({ id: "zulu", name: "Z" }));
      saveMcpServer(projectDir, makeStdio({ id: "alpha", name: "A" }));
      saveMcpServer(projectDir, makeStdio({ id: "mike", name: "M" }));
      const { entries, invalid } = listMcpServers(projectDir);
      expect(entries.map((e) => e.id)).toEqual(["alpha", "mike", "zulu"]);
      expect(invalid).toEqual([]);
    });

    it("imports a legacy source sidecar into central MCP state before reading", () => {
      const legacyPath = path.join(projectDir, ".minions", "mcp-servers.json");
      fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
      fs.writeFileSync(legacyPath, JSON.stringify([makeStdio({ id: "legacy" })]));

      expect(listMcpServers(projectDir).entries.map((entry) => entry.id)).toEqual(["legacy"]);
      const central = mcpServersFilePath(projectDir);
      expect(central.startsWith(path.join(minionsHome, "workspaces"))).toBe(true);
      expect(fs.existsSync(central)).toBe(true);
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
      expect(listMcpServers(projectDir)).toEqual({ entries: [], invalid: [], securityWarnings: [] });
    });

    it("tolerates invalid JSON without throwing", () => {
      const p = mcpServersFilePath(projectDir);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "{ not valid json");
      expect(listMcpServers(projectDir)).toEqual({ entries: [], invalid: [], securityWarnings: [] });
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

  describe("saveMcpServer", () => {
    it.each([
      { kind: "stdio", make: () => makeStdio({ id: "new-srv" }) },
      { kind: "sse", make: () => makeSse({ id: "my-sse" }) },
      { kind: "http", make: () => makeHttp({ id: "my-http" }) },
    ])("creates a new $kind entry and round-trips its transport", ({ kind, make }) => {
      const entry = make();
      saveMcpServer(projectDir, entry);
      const { entries } = listMcpServers(projectDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.id).toBe(entry.id);
      expect(entries[0]!.transport).toBe(kind);
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
      if (process.platform !== "win32") {
        expect(fs.statSync(path.dirname(mcpServersFilePath(projectDir))).mode & 0o777).toBe(0o700);
        expect(fs.statSync(mcpServersFilePath(projectDir)).mode & 0o777).toBe(0o600);
      }
    });

    it("writes to the registered workspace state root and leaves the source clean", () => {
      const workspace = registerWorkspace(projectDir)!;

      saveMcpServer(projectDir, makeStdio());

      expect(mcpServersFilePath(projectDir)).toBe(
        path.join(workspace.stateRoot, "mcp-servers.json"),
      );
      expect(fs.existsSync(path.join(projectDir, ".minions"))).toBe(false);
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

  });

  describe("resolveClaudeMcpServers", () => {
    it("converts saved transports and derives explicitly allowed tool names", () => {
      const result = resolveClaudeMcpServers([
        makeStdio({ id: "local", toolNames: ["read", "write"], args: ["server.js"] }),
        makeHttp({ id: "remote", headers: { Authorization: "Bearer secret" } }),
      ]);
      expect(result.servers).toEqual({
        local: { type: "stdio", command: "node", args: ["server.js"] },
        remote: {
          type: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer secret" },
        },
      });
      expect(result.allowedTools).toEqual(["mcp__local__read", "mcp__local__write"]);
    });
  });

  describe("security warnings", () => {
    it("warns about command execution and plaintext sidecar secrets without echoing them", () => {
      const messages = mcpServerSecurityWarnings(makeStdio({ env: { TOKEN: "super-secret" } }));
      expect(messages.join(" ")).toMatch(/executes a local command/);
      expect(messages.join(" ")).toMatch(/stored in the private Minions workspace state/);
      expect(messages.join(" ")).not.toContain("super-secret");
    });
  });

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
