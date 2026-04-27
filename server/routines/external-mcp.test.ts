/**
 * Tests for buildExternalMcpServers. Uses a fresh temp directory per test so
 * no state leaks between cases.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildExternalMcpServers } from "./external-mcp.ts";
import { saveMcpServer } from "../mcp-server-store.ts";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildExternalMcpServers", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "external-mcp-"));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────

  it("returns empty result when ids is empty", () => {
    expect(buildExternalMcpServers(projectDir, [])).toEqual({
      mcpServers: {},
      toolNames: [],
    });
  });

  it("drops unknown ids silently", () => {
    saveMcpServer(projectDir, {
      id: "real",
      name: "Real",
      transport: "stdio",
      command: "node",
    });
    const { mcpServers } = buildExternalMcpServers(projectDir, [
      "real",
      "ghost",
      "missing",
    ]);
    expect(Object.keys(mcpServers)).toEqual(["real"]);
  });

  it("returns empty when all ids are unknown", () => {
    expect(buildExternalMcpServers(projectDir, ["a", "b", "c"])).toEqual({
      mcpServers: {},
      toolNames: [],
    });
  });

  // ── stdio transport ─────────────────────────────────────────────────────────

  describe("stdio transport", () => {
    it("builds config with command only (no optional fields)", () => {
      saveMcpServer(projectDir, {
        id: "stdio-bare",
        name: "Bare",
        transport: "stdio",
        command: "node",
      });
      const { mcpServers } = buildExternalMcpServers(projectDir, ["stdio-bare"]);
      expect(mcpServers["stdio-bare"]).toEqual({ command: "node" });
    });

    it("includes args when non-empty", () => {
      saveMcpServer(projectDir, {
        id: "stdio-args",
        name: "With Args",
        transport: "stdio",
        command: "npx",
        args: ["-y", "my-pkg"],
      });
      const { mcpServers } = buildExternalMcpServers(projectDir, ["stdio-args"]);
      expect(mcpServers["stdio-args"]).toEqual({
        command: "npx",
        args: ["-y", "my-pkg"],
      });
    });

    it("includes env when non-empty", () => {
      saveMcpServer(projectDir, {
        id: "stdio-env",
        name: "With Env",
        transport: "stdio",
        command: "server",
        env: { API_KEY: "secret" },
      });
      const { mcpServers } = buildExternalMcpServers(projectDir, ["stdio-env"]);
      expect(mcpServers["stdio-env"]).toEqual({
        command: "server",
        env: { API_KEY: "secret" },
      });
    });

    it("omits args key when args is empty array", () => {
      saveMcpServer(projectDir, {
        id: "stdio-noargs",
        name: "No Args",
        transport: "stdio",
        command: "server",
        args: [],
      });
      const { mcpServers } = buildExternalMcpServers(projectDir, [
        "stdio-noargs",
      ]);
      expect(mcpServers["stdio-noargs"]).not.toHaveProperty("args");
    });

    it("omits env key when env is empty object", () => {
      saveMcpServer(projectDir, {
        id: "stdio-noenv",
        name: "No Env",
        transport: "stdio",
        command: "server",
        env: {},
      });
      const { mcpServers } = buildExternalMcpServers(projectDir, [
        "stdio-noenv",
      ]);
      expect(mcpServers["stdio-noenv"]).not.toHaveProperty("env");
    });

    it("includes both args and env together", () => {
      saveMcpServer(projectDir, {
        id: "stdio-full",
        name: "Full",
        transport: "stdio",
        command: "run",
        args: ["--port", "3000"],
        env: { MODE: "prod" },
      });
      const { mcpServers } = buildExternalMcpServers(projectDir, ["stdio-full"]);
      expect(mcpServers["stdio-full"]).toEqual({
        command: "run",
        args: ["--port", "3000"],
        env: { MODE: "prod" },
      });
    });
  });

  // ── SSE transport ───────────────────────────────────────────────────────────

  describe("SSE transport", () => {
    it("builds config with type=sse and url", () => {
      saveMcpServer(projectDir, {
        id: "my-sse",
        name: "SSE",
        transport: "sse",
        url: "https://example.com/sse",
      });
      const { mcpServers } = buildExternalMcpServers(projectDir, ["my-sse"]);
      expect(mcpServers["my-sse"]).toEqual({
        type: "sse",
        url: "https://example.com/sse",
      });
    });

    it("includes headers when present", () => {
      saveMcpServer(projectDir, {
        id: "sse-headers",
        name: "SSE Headers",
        transport: "sse",
        url: "https://example.com/sse",
        headers: { Authorization: "Bearer tok" },
      });
      const { mcpServers } = buildExternalMcpServers(projectDir, [
        "sse-headers",
      ]);
      expect(mcpServers["sse-headers"]).toEqual({
        type: "sse",
        url: "https://example.com/sse",
        headers: { Authorization: "Bearer tok" },
      });
    });

    it("omits headers key when headers is empty object", () => {
      saveMcpServer(projectDir, {
        id: "sse-noheaders",
        name: "SSE No Headers",
        transport: "sse",
        url: "https://example.com/sse",
        headers: {},
      });
      const { mcpServers } = buildExternalMcpServers(projectDir, [
        "sse-noheaders",
      ]);
      expect(mcpServers["sse-noheaders"]).not.toHaveProperty("headers");
    });
  });

  // ── HTTP transport ──────────────────────────────────────────────────────────

  describe("HTTP transport", () => {
    it("builds config with type=http and url", () => {
      saveMcpServer(projectDir, {
        id: "my-http",
        name: "HTTP",
        transport: "http",
        url: "https://example.com/mcp",
      });
      const { mcpServers } = buildExternalMcpServers(projectDir, ["my-http"]);
      expect(mcpServers["my-http"]).toEqual({
        type: "http",
        url: "https://example.com/mcp",
      });
    });

    it("includes headers when present", () => {
      saveMcpServer(projectDir, {
        id: "http-headers",
        name: "HTTP Headers",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { "X-API-Key": "key123" },
      });
      const { mcpServers } = buildExternalMcpServers(projectDir, [
        "http-headers",
      ]);
      expect(mcpServers["http-headers"]).toEqual({
        type: "http",
        url: "https://example.com/mcp",
        headers: { "X-API-Key": "key123" },
      });
    });

    it("omits headers key when headers is empty object", () => {
      saveMcpServer(projectDir, {
        id: "http-noheaders",
        name: "HTTP No Headers",
        transport: "http",
        url: "https://example.com/mcp",
        headers: {},
      });
      const { mcpServers } = buildExternalMcpServers(projectDir, [
        "http-noheaders",
      ]);
      expect(mcpServers["http-noheaders"]).not.toHaveProperty("headers");
    });
  });

  // ── Tool name formatting ────────────────────────────────────────────────────

  describe("tool name formatting", () => {
    it("returns empty toolNames when no entry has toolNames", () => {
      saveMcpServer(projectDir, {
        id: "no-tools",
        name: "No Tools",
        transport: "stdio",
        command: "server",
      });
      const { toolNames } = buildExternalMcpServers(projectDir, ["no-tools"]);
      expect(toolNames).toEqual([]);
    });

    it("formats names as mcp__<serverId>__<toolName>", () => {
      saveMcpServer(projectDir, {
        id: "my-srv",
        name: "With Tools",
        transport: "stdio",
        command: "server",
        toolNames: ["do_thing", "other_tool"],
      });
      const { toolNames } = buildExternalMcpServers(projectDir, ["my-srv"]);
      expect(toolNames).toEqual([
        "mcp__my-srv__do_thing",
        "mcp__my-srv__other_tool",
      ]);
    });

    it("aggregates tool names across multiple servers in id order", () => {
      saveMcpServer(projectDir, {
        id: "srv-a",
        name: "A",
        transport: "stdio",
        command: "a",
        toolNames: ["tool1"],
      });
      saveMcpServer(projectDir, {
        id: "srv-b",
        name: "B",
        transport: "stdio",
        command: "b",
        toolNames: ["tool2", "tool3"],
      });
      const { toolNames } = buildExternalMcpServers(projectDir, [
        "srv-a",
        "srv-b",
      ]);
      expect(toolNames).toEqual([
        "mcp__srv-a__tool1",
        "mcp__srv-b__tool2",
        "mcp__srv-b__tool3",
      ]);
    });

    it("skips tool names for a server that has empty toolNames array", () => {
      saveMcpServer(projectDir, {
        id: "a",
        name: "A",
        transport: "stdio",
        command: "a",
        toolNames: [],
      });
      saveMcpServer(projectDir, {
        id: "b",
        name: "B",
        transport: "stdio",
        command: "b",
        toolNames: ["real"],
      });
      const { toolNames } = buildExternalMcpServers(projectDir, ["a", "b"]);
      expect(toolNames).toEqual(["mcp__b__real"]);
    });
  });

  // ── Multiple servers ────────────────────────────────────────────────────────

  it("maps multiple servers to the mcpServers record by id", () => {
    saveMcpServer(projectDir, {
      id: "srv-1",
      name: "One",
      transport: "stdio",
      command: "cmd1",
    });
    saveMcpServer(projectDir, {
      id: "srv-2",
      name: "Two",
      transport: "http",
      url: "https://two.example",
    });
    const { mcpServers } = buildExternalMcpServers(projectDir, [
      "srv-1",
      "srv-2",
    ]);
    expect(Object.keys(mcpServers).sort()).toEqual(["srv-1", "srv-2"]);
    expect(mcpServers["srv-1"]).toHaveProperty("command", "cmd1");
    expect(mcpServers["srv-2"]).toHaveProperty("type", "http");
  });
});
