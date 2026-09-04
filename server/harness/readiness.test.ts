import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkClaudeReadiness } from "./claude/runtime.ts";
import { checkCodexReadiness, resolveCodexRuntime } from "./codex/runtime.ts";

const context = () => ({ signal: new AbortController().signal });

describe("harness readiness probes", () => {
  it("accepts only parsed Claude logged-in output", async () => {
    const ready = await checkClaudeReadiness(context(), { resolve: () => ({ executable: "/fixture/claude", source: "env_override" }), run: async () => ({ code: 0, stdout: '{"loggedIn":true,"authMethod":"oauth"}' }) });
    expect(ready).toMatchObject({ state: "ready", auth: { authenticated: true, source: "oauth" } });
    const malformed = await checkClaudeReadiness(context(), { resolve: () => ({ executable: "/fixture/claude", source: "env_override" }), run: async () => ({ code: 0, stdout: "token=secret" }) });
    expect(malformed.state).toBe("probe_failed");
    expect(JSON.stringify(malformed)).not.toContain("secret");
  });

  it("uses Codex status exit code without retaining output", async () => {
    const result = await checkCodexReadiness(context(), { resolve: () => ({ executable: "/fixture/codex", source: "env_override", env: {} }), run: async () => ({ code: 1, stdout: "account@example.test token-secret" }) });
    expect(result.state).toBe("unauthenticated");
    expect(JSON.stringify(result)).not.toContain("example.test");
    expect(JSON.stringify(result)).not.toContain("token-secret");
  });

  it("falls back to a standalone Codex CLI on PATH when the SDK runtime is absent", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "minions-codex-path-"));
    try {
      const executable = path.join(directory, process.platform === "win32" ? "codex.CMD" : "codex");
      fs.writeFileSync(executable, "");
      if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
      expect(resolveCodexRuntime({ PATH: directory }, { resolveBundled: () => null })).toMatchObject({
        executable,
        source: "path",
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
