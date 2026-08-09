import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { HarnessReadinessContext, HarnessReadinessProbe } from "../readiness-types.ts";
import { runProcess, type ProcessRunner } from "../process-runner.ts";

const require = createRequire(import.meta.url);

export interface ClaudeRuntime {
  executable: string;
  source: "env_override" | "sdk_bundled";
}

function packageCandidates(): string[] {
  const suffix = `${process.platform}-${process.arch}`;
  return process.platform === "linux"
    ? [`@anthropic-ai/claude-agent-sdk-${suffix}`, `@anthropic-ai/claude-agent-sdk-${suffix}-musl`]
    : [`@anthropic-ai/claude-agent-sdk-${suffix}`];
}

export function resolveClaudeRuntime(env: NodeJS.ProcessEnv = process.env): ClaudeRuntime | null {
  const override = env["CLAUDE_CODE_PATH"]?.trim();
  if (override) return fs.existsSync(override) ? { executable: override, source: "env_override" } : null;
  for (const packageName of packageCandidates()) {
    try {
      const packageJson = require.resolve(`${packageName}/package.json`);
      const executable = path.join(path.dirname(packageJson), process.platform === "win32" ? "claude.exe" : "claude");
      if (fs.existsSync(executable)) return { executable, source: "sdk_bundled" };
    } catch { /* optional platform package is absent */ }
  }
  return null;
}

function parsedLoggedIn(stdout: string): { loggedIn: boolean; source: "oauth" | "api_key" | "unknown" } | null {
  try {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    const loggedIn = value["loggedIn"] ?? value["logged_in"] ?? value["authenticated"];
    if (typeof loggedIn !== "boolean") return null;
    const method = String(value["authMethod"] ?? value["auth_method"] ?? "").toLowerCase();
    return { loggedIn, source: method.includes("api") ? "api_key" : method.includes("oauth") ? "oauth" : "unknown" };
  } catch { return null; }
}

export async function checkClaudeReadiness(
  context: HarnessReadinessContext,
  deps: { resolve?: () => ClaudeRuntime | null; run?: ProcessRunner } = {},
): Promise<HarnessReadinessProbe> {
  const runtime = (deps.resolve ?? resolveClaudeRuntime)();
  const source = runtime?.source ?? (process.env["CLAUDE_CODE_PATH"] ? "env_override" : "sdk_bundled");
  if (!runtime) return { state: "runtime_missing", runtime: { available: false, source }, auth: { authenticated: false, source: "unknown" } };
  const result = await (deps.run ?? runProcess)(runtime.executable, ["auth", "status", "--json"], { env: process.env, signal: context.signal });
  if (result.code !== 0) return { state: "unauthenticated", runtime: { available: true, source }, auth: { authenticated: false, source: "unknown" } };
  const auth = parsedLoggedIn(result.stdout);
  if (!auth) return { state: "probe_failed", runtime: { available: true, source }, auth: { authenticated: false, source: "unknown" } };
  return {
    state: auth.loggedIn ? "ready" : "unauthenticated",
    runtime: { available: true, source },
    auth: { authenticated: auth.loggedIn, source: auth.source },
  };
}
