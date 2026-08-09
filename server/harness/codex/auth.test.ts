/**
 * Tests for Codex credential discovery and direct harness failure behavior.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveCodexCredentials } from "./auth.ts";

const scratchDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-test-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveCodexCredentials", () => {
  it("returns no credentials when the environment has none", () => {
    expect(resolveCodexCredentials({})).toEqual({});
  });

  it("prefers CODEX_API_KEY over OPENAI_API_KEY", () => {
    const creds = resolveCodexCredentials({
      CODEX_API_KEY: "codex-key",
      OPENAI_API_KEY: "openai-key",
    });
    expect(creds.apiKey).toBe("codex-key");
  });

  it("falls back to OPENAI_API_KEY", () => {
    const creds = resolveCodexCredentials({ OPENAI_API_KEY: "openai-key" });
    expect(creds.apiKey).toBe("openai-key");
  });

  it("passes CODEX_PATH through as the binary override", () => {
    const creds = resolveCodexCredentials({ CODEX_PATH: "C:/bin/codex.exe" });
    expect(creds.codexPathOverride).toBe("C:/bin/codex.exe");
  });
});

describe("CodexHarness.start() credential preflight", () => {
  it("yields a single actionable done/error event instead of spawning", async () => {
    const { codexHarness } = await import("./index.ts");
    const home = makeTempDir(); // empty — no .codex/auth.json
    const prevEnv = {
      CODEX_API_KEY: process.env["CODEX_API_KEY"],
      OPENAI_API_KEY: process.env["OPENAI_API_KEY"],
      CODEX_HOME: process.env["CODEX_HOME"],
    };
    delete process.env["CODEX_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    process.env["CODEX_HOME"] = path.join(home, ".codex");
    try {
      const { events } = codexHarness.start({
        sessionKey: "preflight-test",
        cwd: home,
        prompt: "hello",
        systemPrompt: "sys",
        model: "gpt-5.5",
        allowedTools: [],
        abortSignal: new AbortController().signal,
      });
      const received = [];
      for await (const evt of events) received.push(evt);
      expect(received).toHaveLength(1);
      const done = received[0];
      expect(done).toMatchObject({ kind: "done", reason: "error" });
      const error = done?.kind === "done" ? done.error : undefined;
      expect(String(error).length).toBeGreaterThan(0);
    } finally {
      for (const [key, value] of Object.entries(prevEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
