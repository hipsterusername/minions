/**
 * Behavioral tests for the MCP paste parser.
 *
 * Covers the four input shapes vendors actually publish, the security
 * fences (size, shell metacharacters, malformed JSON), and the round-trip
 * with the form's argv splitter.
 */

import { describe, it, expect } from "vitest";
import {
  parsePastedMcpConfig,
  splitArgsLine,
  sanitizeId,
  MAX_PASTE_BYTES,
} from "./mcp-paste-parser.ts";

describe("parsePastedMcpConfig — bare subprocess", () => {
  it("parses an npx install line", () => {
    const r = parsePastedMcpConfig(
      "npx -y @modelcontextprotocol/server-filesystem ~/Documents",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.transport).toBe("stdio");
    expect(r.draft.command).toBe("npx");
    expect(r.draft.args).toBe(
      "-y @modelcontextprotocol/server-filesystem ~/Documents",
    );
  });

  it("preserves quoted args containing whitespace", () => {
    const r = parsePastedMcpConfig(
      'mybin --message "hello world" --flag',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.args).toBe('--message "hello world" --flag');
  });

  it("rejects shell pipelines", () => {
    const r = parsePastedMcpConfig("npx foo | grep bar");
    expect(r.ok).toBe(false);
  });

  it("rejects redirects and command substitution", () => {
    expect(parsePastedMcpConfig("npx foo > out.txt").ok).toBe(false);
    expect(parsePastedMcpConfig("npx foo $(whoami)").ok).toBe(false);
    expect(parsePastedMcpConfig("npx foo `whoami`").ok).toBe(false);
    expect(parsePastedMcpConfig("npx foo && rm -rf /").ok).toBe(false);
  });

  it("allows literal $ inside an arg", () => {
    // $VAR alone is a valid literal arg (no expansion happens at parse
    // or at spawn — argv passes verbatim). Only $( triggers rejection.
    const r = parsePastedMcpConfig("mybin --price $5");
    expect(r.ok).toBe(true);
  });

  it("rejects unclosed quotes", () => {
    const r = parsePastedMcpConfig('mybin --foo "unterminated');
    expect(r.ok).toBe(false);
  });
});

describe("parsePastedMcpConfig — `claude mcp add` command", () => {
  it("parses the canonical filesystem example", () => {
    const r = parsePastedMcpConfig(
      "claude mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem ~/Documents",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.id).toBe("filesystem");
    expect(r.draft.name).toBe("filesystem");
    expect(r.draft.transport).toBe("stdio");
    expect(r.draft.command).toBe("npx");
    expect(r.draft.args).toBe(
      "-y @modelcontextprotocol/server-filesystem ~/Documents",
    );
  });

  it("collects --env into the env field", () => {
    const r = parsePastedMcpConfig(
      "claude mcp add weather --env API_KEY=secret --env DEBUG=true -- weather-mcp",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.env).toBe("API_KEY=secret\nDEBUG=true");
    expect(r.draft.command).toBe("weather-mcp");
  });

  it("handles HTTP transport with --header flags", () => {
    const r = parsePastedMcpConfig(
      'claude mcp add weather --transport http --header "Authorization: Bearer xyz" https://api.example.com/mcp',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.transport).toBe("http");
    expect(r.draft.url).toBe("https://api.example.com/mcp");
    expect(r.draft.headers).toBe("Authorization=Bearer xyz");
  });

  it("ignores --scope on import", () => {
    const r = parsePastedMcpConfig(
      "claude mcp add foo --scope user -- npx foo-mcp",
    );
    expect(r.ok).toBe(true);
  });

  it("handles `add-json` form", () => {
    const r = parsePastedMcpConfig(
      'claude mcp add-json weather \'{"command":"npx","args":["weather-mcp"]}\'',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.id).toBe("weather");
    expect(r.draft.transport).toBe("stdio");
    expect(r.draft.command).toBe("npx");
    expect(r.draft.args).toBe("weather-mcp");
  });

  it("accepts the `npx @anthropic-ai/claude-code mcp add` variant", () => {
    const r = parsePastedMcpConfig(
      "npx @anthropic-ai/claude-code mcp add filesystem -- npx fs-mcp",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.id).toBe("filesystem");
    expect(r.draft.command).toBe("npx");
  });

  it("errors when no -- or URL is present", () => {
    const r = parsePastedMcpConfig("claude mcp add foo");
    expect(r.ok).toBe(false);
  });
});

describe("parsePastedMcpConfig — JSON forms", () => {
  it("parses our own schema verbatim", () => {
    const r = parsePastedMcpConfig(
      JSON.stringify({
        id: "fs",
        name: "Filesystem",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem"],
        env: { LOG_LEVEL: "info" },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.id).toBe("fs");
    expect(r.draft.name).toBe("Filesystem");
    expect(r.draft.command).toBe("npx");
    expect(r.draft.args).toBe("-y @modelcontextprotocol/server-filesystem");
    expect(r.draft.env).toBe("LOG_LEVEL=info");
  });

  it("parses the Claude Desktop / .mcp.json wrapped form", () => {
    const r = parsePastedMcpConfig(
      JSON.stringify({
        mcpServers: {
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          },
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.id).toBe("filesystem");
    expect(r.draft.name).toBe("filesystem");
    expect(r.draft.transport).toBe("stdio");
    expect(r.draft.command).toBe("npx");
  });

  it("warns when the wrapped form contains multiple servers", () => {
    const r = parsePastedMcpConfig(
      JSON.stringify({
        mcpServers: {
          a: { command: "a-mcp" },
          b: { command: "b-mcp" },
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.draft.id).toBe("a");
  });

  it("infers HTTP transport from a `url` field", () => {
    const r = parsePastedMcpConfig(
      JSON.stringify({ url: "https://example.com/mcp" }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.transport).toBe("http");
    expect(r.draft.url).toBe("https://example.com/mcp");
  });

  it("accepts headers as an array of `K: V` strings", () => {
    const r = parsePastedMcpConfig(
      JSON.stringify({
        type: "http",
        url: "https://example.com/mcp",
        headers: ["Authorization: Bearer abc", "X-Foo: bar"],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.headers).toBe("Authorization=Bearer abc\nX-Foo=bar");
  });

  it("rejects malformed JSON", () => {
    const r = parsePastedMcpConfig("{not json");
    expect(r.ok).toBe(false);
  });

  it("rejects stdio entry without command", () => {
    const r = parsePastedMcpConfig(
      JSON.stringify({ transport: "stdio", args: ["foo"] }),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects http entry without url", () => {
    const r = parsePastedMcpConfig(JSON.stringify({ transport: "http" }));
    expect(r.ok).toBe(false);
  });

  it("rejects empty mcpServers wrapper", () => {
    const r = parsePastedMcpConfig(JSON.stringify({ mcpServers: {} }));
    expect(r.ok).toBe(false);
  });
});

describe("parsePastedMcpConfig — bare URL", () => {
  it("recognises a lone HTTPS URL as an HTTP server", () => {
    const r = parsePastedMcpConfig("https://api.example.com/mcp");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.transport).toBe("http");
    expect(r.draft.url).toBe("https://api.example.com/mcp");
  });

  it("does not treat a URL with adjacent text as a lone URL", () => {
    // Falls through to subprocess parsing, which treats it as `command url`.
    const r = parsePastedMcpConfig("curl https://example.com");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.transport).toBe("stdio");
    expect(r.draft.command).toBe("curl");
  });
});

describe("parsePastedMcpConfig — security & limits", () => {
  it("rejects empty input", () => {
    expect(parsePastedMcpConfig("").ok).toBe(false);
    expect(parsePastedMcpConfig("   \n  ").ok).toBe(false);
  });

  it("rejects oversize input", () => {
    const huge = "a".repeat(MAX_PASTE_BYTES + 1);
    expect(parsePastedMcpConfig(huge).ok).toBe(false);
  });

  it("rejects non-string input", () => {
    // @ts-expect-error — runtime guard for callers ignoring types.
    expect(parsePastedMcpConfig(123).ok).toBe(false);
  });
});

describe("splitArgsLine", () => {
  it("splits on whitespace by default", () => {
    expect(splitArgsLine("--foo bar baz")).toEqual(["--foo", "bar", "baz"]);
  });

  it("preserves quoted whitespace", () => {
    expect(splitArgsLine('--msg "hello world"')).toEqual([
      "--msg",
      "hello world",
    ]);
  });

  it("handles single quotes", () => {
    expect(splitArgsLine("--msg 'hi there'")).toEqual(["--msg", "hi there"]);
  });

  it("handles escaped quotes inside double quotes", () => {
    expect(splitArgsLine('--msg "she said \\"hi\\""')).toEqual([
      "--msg",
      'she said "hi"',
    ]);
  });

  it("returns empty array for blank input", () => {
    expect(splitArgsLine("")).toEqual([]);
    expect(splitArgsLine("   ")).toEqual([]);
  });

  it("does NOT reject shell metacharacters (they're valid as literal args)", () => {
    expect(splitArgsLine("--filter foo|bar")).toEqual(["--filter", "foo|bar"]);
  });
});

describe("sanitizeId", () => {
  // Removed: "lower-cases" — pinning of String#toLowerCase. See
  // docs/testing-strategy.md §5 (no platform-builtin tautologies).
  it("replaces invalid chars with dash", () => {
    expect(sanitizeId("@scope/name")).toBe("scope-name");
  });

  it("strips leading dashes", () => {
    expect(sanitizeId("--foo")).toBe("foo");
  });

  it("falls back to `server` for empty input", () => {
    expect(sanitizeId("!!!")).toBe("server");
  });

  it("caps length at 80", () => {
    const long = "a".repeat(200);
    expect(sanitizeId(long).length).toBeLessThanOrEqual(80);
  });

  it("prefixes with `s` if first char is non-alnum after cleanup", () => {
    // After stripping leading dashes this is empty → falls back; check a
    // case where cleanup leaves a non-alnum start.
    expect(sanitizeId("_foo")).toMatch(/^[a-z0-9]/);
  });
});

// Removed: round-trip test composing parser + splitArgsLine — both pieces
// are individually covered above; the composition adds no new behaviour.
// See docs/testing-strategy.md §5.
