import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { HarnessReadinessContext, HarnessReadinessProbe } from "../readiness-types.ts";
import { runProcess, type ProcessRunner } from "../process-runner.ts";
import { resolveCliRuntime } from "../cli-runtime.ts";
import { resolveCodexCredentials } from "./auth.ts";

const require = createRequire(import.meta.url);

export interface CodexRuntime {
  executable: string;
  source: "env_override" | "sdk_bundled" | "path";
  env: NodeJS.ProcessEnv;
}

const TARGETS: Record<string, [string, string]> = {
  "linux:x64": ["@openai/codex-linux-x64", "x86_64-unknown-linux-musl"],
  "linux:arm64": ["@openai/codex-linux-arm64", "aarch64-unknown-linux-musl"],
  "darwin:x64": ["@openai/codex-darwin-x64", "x86_64-apple-darwin"],
  "darwin:arm64": ["@openai/codex-darwin-arm64", "aarch64-apple-darwin"],
  "win32:x64": ["@openai/codex-win32-x64", "x86_64-pc-windows-msvc"],
  "win32:arm64": ["@openai/codex-win32-arm64", "aarch64-pc-windows-msvc"],
};

export function resolveCodexRuntime(
  env: NodeJS.ProcessEnv = process.env,
  deps: { resolveBundled?: () => string | null } = {},
): CodexRuntime | null {
  const credentials = resolveCodexCredentials(env);
  const runtimeEnv = { ...env };
  if (credentials.apiKey) runtimeEnv["CODEX_API_KEY"] = credentials.apiKey;
  const override = credentials.codexPathOverride?.trim();
  if (override) return fs.existsSync(override) ? { executable: override, source: "env_override", env: runtimeEnv } : null;
  const bundled = (deps.resolveBundled ?? resolveBundledCodexExecutable)();
  if (bundled) return { executable: bundled, source: "sdk_bundled", env: runtimeEnv };
  const standalone = resolveCliRuntime("CODEX_PATH", "codex", runtimeEnv);
  return standalone ? { ...standalone, env: runtimeEnv } : null;
}

function resolveBundledCodexExecutable(): string | null {
  const target = TARGETS[`${process.platform}:${process.arch}`];
  if (target) {
    try {
      const sdkRequire = createRequire(fileURLToPath(import.meta.resolve("@openai/codex-sdk")));
      const codexPackage = sdkRequire.resolve("@openai/codex/package.json");
      const packageJson = createRequire(codexPackage).resolve(`${target[0]}/package.json`);
      const executable = path.join(path.dirname(packageJson), "vendor", target[1], "bin", process.platform === "win32" ? "codex.exe" : "codex");
      if (fs.existsSync(executable)) return executable;
    } catch { /* Fall through to a standalone Codex CLI on PATH. */ }
  }
  return null;
}

export async function checkCodexReadiness(
  context: HarnessReadinessContext,
  deps: { resolve?: () => CodexRuntime | null; run?: ProcessRunner } = {},
): Promise<HarnessReadinessProbe> {
  const runtime = (deps.resolve ?? resolveCodexRuntime)();
  const source = runtime?.source ?? (process.env["CODEX_PATH"] ? "env_override" : "sdk_bundled");
  if (!runtime) return { state: "runtime_missing", runtime: { available: false, source }, auth: { authenticated: false, source: "unknown" } };
  const result = await (deps.run ?? runProcess)(runtime.executable, ["login", "status"], { env: runtime.env, signal: context.signal });
  const ready = result.code === 0;
  const apiKey = Boolean(runtime.env["CODEX_API_KEY"] || runtime.env["OPENAI_API_KEY"]);
  return {
    state: ready ? "ready" : "unauthenticated",
    runtime: { available: true, source },
    auth: { authenticated: ready, source: apiKey ? "api_key" : ready ? "cli_login" : "unknown" },
  };
}
