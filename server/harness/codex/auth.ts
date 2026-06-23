/**
 * Codex credential discovery + preflight.
 *
 * `resolveCodexCredentials` picks up API credentials from the environment
 * without forcing them into argv (moved here from `index.ts`).
 *
 * `missingCodexAuth` is the fail-fast preflight used by
 * `CodexHarness.start()`: when neither an API key nor a Codex CLI login
 * exists, spawning `codex` fails or hangs while emitting zero events, so the
 * session sits silently at 0 turns until a task timeout aborts it.
 * Surfacing an actionable error before any I/O is the difference between a
 * one-line fix for the user and a silent dead minion.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CodexCredentials {
  apiKey?: string;
  codexPathOverride?: string;
}

/**
 * Either `CODEX_API_KEY` or `OPENAI_API_KEY` is accepted; if neither is set
 * the SDK falls back to whatever the local `codex` CLI has configured.
 * `CODEX_PATH` overrides the discovered binary.
 */
export function resolveCodexCredentials(
  env: Record<string, string | undefined> = process.env,
): CodexCredentials {
  const out: CodexCredentials = {};
  const apiKey = env["CODEX_API_KEY"] ?? env["OPENAI_API_KEY"];
  if (apiKey) out.apiKey = apiKey;
  const codexPath = env["CODEX_PATH"];
  if (codexPath) out.codexPathOverride = codexPath;
  return out;
}

/**
 * Returns an actionable error message when no Codex credentials are
 * available, or `null` when an API key or a CLI login (`auth.json` under
 * `CODEX_HOME`, defaulting to `~/.codex`) is present.
 */
export function missingCodexAuth(opts?: {
  env?: Record<string, string | undefined>;
  homeDir?: string;
}): string | null {
  const env = opts?.env ?? process.env;
  if (env["CODEX_API_KEY"] || env["OPENAI_API_KEY"]) return null;
  const home = opts?.homeDir ?? env["HOME"] ?? os.homedir();
  const codexHome = env["CODEX_HOME"] ?? path.join(home, ".codex");
  const authFile = path.join(codexHome, "auth.json");
  if (fs.existsSync(authFile)) return null;
  return (
    `Codex harness has no credentials: CODEX_API_KEY/OPENAI_API_KEY are not ` +
    `set in the server environment and no Codex CLI login was found at ` +
    `"${authFile}". Fix one of: run \`codex login\` on this machine, set ` +
    `CODEX_API_KEY or OPENAI_API_KEY before starting the server, or switch ` +
    `the default minion harness to "claude" in project settings.`
  );
}
