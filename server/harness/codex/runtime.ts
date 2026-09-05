import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { HarnessReadinessContext, HarnessReadinessProbe } from "../readiness-types.ts";
import { runProcess, type ProcessRunner } from "../process-runner.ts";
import { resolveCodexCredentials } from "./auth.ts";

const require = createRequire(import.meta.url);

export interface CodexRuntime {
  executable: string;
  source: "env_override" | "sdk_bundled" | "path";
  env: NodeJS.ProcessEnv;
}

type CodexRuntimeCandidate = {
  executable: string;
  source: "sdk_bundled" | "path";
};
type CodexVersion = readonly [major: number, minor: number, patch: number];

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
  deps: {
    resolveBundled?: () => string | null;
    resolvePath?: () => CodexRuntimeCandidate[];
    readVersion?: (executable: string) => CodexVersion | null;
  } = {},
): CodexRuntime | null {
  const credentials = resolveCodexCredentials(env);
  const runtimeEnv = { ...env };
  if (credentials.apiKey) runtimeEnv["CODEX_API_KEY"] = credentials.apiKey;
  const override = credentials.codexPathOverride?.trim();
  if (override) return isExecutableFile(override)
    ? { executable: override, source: "env_override", env: runtimeEnv }
    : null;

  const candidates: CodexRuntimeCandidate[] = [];
  const bundled = (deps.resolveBundled ?? resolveBundledCodexExecutable)();
  if (bundled) candidates.push({ executable: bundled, source: "sdk_bundled" });
  candidates.push(...(deps.resolvePath ?? (() => resolveCodexExecutablesOnPath(runtimeEnv)))());

  const readVersion = deps.readVersion
    ?? ((executable: string) => readCodexVersion(executable, runtimeEnv));
  const selected = selectNewestCodexRuntime(candidates, readVersion);
  return selected ? { ...selected, env: runtimeEnv } : null;
}

function resolveCodexExecutablesOnPath(env: NodeJS.ProcessEnv): CodexRuntimeCandidate[] {
  const pathValue = env["PATH"] ?? env["Path"] ?? env["path"] ?? "";
  const extensions = process.platform === "win32"
    ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  const seen = new Set<string>();
  const candidates: CodexRuntimeCandidate[] = [];
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const executable = path.join(directory, process.platform === "win32" ? `codex${extension}` : "codex");
      if (!isExecutableFile(executable)) continue;
      const identity = realPath(executable);
      if (seen.has(identity)) continue;
      seen.add(identity);
      candidates.push({ executable, source: "path" });
    }
  }
  return candidates;
}

function selectNewestCodexRuntime(
  candidates: CodexRuntimeCandidate[],
  readVersion: (executable: string) => CodexVersion | null,
): CodexRuntimeCandidate | null {
  if (candidates.length <= 1) return candidates[0] ?? null;
  let selected = candidates[0]!;
  let selectedVersion = readVersion(selected.executable);
  for (const candidate of candidates.slice(1)) {
    const version = readVersion(candidate.executable);
    if (version && (!selectedVersion || compareVersions(version, selectedVersion) > 0)) {
      selected = candidate;
      selectedVersion = version;
    }
  }
  return selected;
}

function readCodexVersion(executable: string, env: NodeJS.ProcessEnv): CodexVersion | null {
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 3_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(result.stdout);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(left: CodexVersion, right: CodexVersion): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function realPath(candidate: string): string {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return candidate;
  }
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
