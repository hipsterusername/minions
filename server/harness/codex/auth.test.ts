/**
 * Tests for Codex credential discovery and the no-credentials preflight.
 *
 * Regression context: with `defaultMinionHarness: "codex"` configured but no
 * Codex CLI login (`~/.codex/auth.json`) and no API key in the server
 * environment, every minion session died silently at 0 turns — the `codex`
 * CLI spawn produced no events and the session sat until a task timeout
 * aborted it. `missingCodexAuth` + the `start()` preflight turn that silent
 * death into an immediate, actionable error event.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { missingCodexAuth, resolveCodexCredentials } from "./auth.ts";

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

describe("missingCodexAuth", () => {
  it("returns null when CODEX_API_KEY is set", () => {
    expect(missingCodexAuth({ env: { CODEX_API_KEY: "k" } })).toBeNull();
  });

  it("returns null when OPENAI_API_KEY is set", () => {
    expect(missingCodexAuth({ env: { OPENAI_API_KEY: "k" } }))
      .toBeNull();
  });

  it("returns null when a CLI login exists under CODEX_HOME", () => {
    const codexHome = makeTempDir();
    fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");
    expect(missingCodexAuth({ env: { CODEX_HOME: codexHome } })).toBeNull();
  });

  it("returns null when a CLI login exists under <home>/.codex", () => {
    const home = makeTempDir();
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(path.join(home, ".codex", "auth.json"), "{}");
    expect(missingCodexAuth({ env: {}, homeDir: home })).toBeNull();
  });

  it("names the missing auth path and the fixes when nothing is configured", () => {
    const home = makeTempDir(); // empty — no .codex dir
    const message = missingCodexAuth({ env: {}, homeDir: home });
    expect(message).not.toBeNull();
    expect(message).toContain(path.join(home, ".codex", "auth.json"));
    expect(message).toMatch(/codex login/);
    expect(message).toMatch(/CODEX_API_KEY|OPENAI_API_KEY/);
    expect(message).toMatch(/minion harness/i);
  });

  it("treats empty-string env vars as unset", () => {
    const home = makeTempDir();
    const message = missingCodexAuth({
      env: { CODEX_API_KEY: "", OPENAI_API_KEY: "" },
      homeDir: home,
    });
    expect(message).not.toBeNull();
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
      expect(String(error)).toMatch(/codex login/);
    } finally {
      for (const [key, value] of Object.entries(prevEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
