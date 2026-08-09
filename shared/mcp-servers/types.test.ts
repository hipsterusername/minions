import { describe, expect, it } from "vitest";
import { isSecureMcpUrl, safeParseMcpServerEntry } from "./types.ts";

describe("MCP transport policy", () => {
  it.each([
    "https://mcp.example.test/v1",
    "http://localhost:3000/mcp",
    "http://127.0.0.42:8080/mcp",
    "http://[::1]:9000/mcp",
  ])("accepts TLS or loopback URL %s", (url) => {
    expect(isSecureMcpUrl(url)).toBe(true);
    expect(safeParseMcpServerEntry({ id: "test", name: "Test", transport: "http", url }).ok).toBe(true);
  });

  it.each([
    "http://mcp.example.test/v1",
    "ftp://localhost/mcp",
    "https://user:secret@mcp.example.test/v1",
    "http://127.999.0.1/mcp",
  ])("rejects insecure or credential-bearing URL %s", (url) => {
    expect(isSecureMcpUrl(url)).toBe(false);
    const result = safeParseMcpServerEntry({ id: "test", name: "Test", transport: "sse", url });
    expect(result.ok).toBe(false);
  });

  it("bounds executable arguments and secret maps", () => {
    expect(safeParseMcpServerEntry({
      id: "test",
      name: "Test",
      transport: "stdio",
      command: "node",
      args: Array.from({ length: 513 }, () => "x"),
    }).ok).toBe(false);
  });

  it("rejects header injection and invalid environment variable names", () => {
    expect(safeParseMcpServerEntry({
      id: "remote",
      name: "Remote",
      transport: "http",
      url: "https://mcp.example.test",
      headers: { Authorization: "safe\r\nInjected: yes" },
    }).ok).toBe(false);
    expect(safeParseMcpServerEntry({
      id: "local",
      name: "Local",
      transport: "stdio",
      command: "node",
      env: { "BAD-NAME": "value" },
    }).ok).toBe(false);
  });
});
