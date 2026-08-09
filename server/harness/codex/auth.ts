/**
 * Codex environment credential discovery.
 *
 * `resolveCodexCredentials` picks up API credentials from the environment
 * without forcing them into argv.
 *
 * CLI authentication is deliberately not inferred from credential files.
 * The harness readiness probe runs `codex login status` against the same
 * executable and environment used by sessions.
 */

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
