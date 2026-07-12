import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Build the environment passed to the Codex CLI.
 *
 * The CLI receives an explicit allowlist rather than every credential in the
 * server process. Login/config remains available through HOME/CODEX_HOME;
 * OpenAI provider variables and standard process/locale/proxy settings are
 * retained for supported CLI operation.
 */
export function buildCodexEnv(
  bridgeEnv: Record<string, string>,
  cwd: string,
): Record<string, string> {
  const fallbackHome = codexHomeFallback(cwd);

  const env = allowedProcessEnv();
  Object.assign(env, bridgeEnv);
  if (!env["CODEX_HOME"] && fallbackHome !== null) {
    env["CODEX_HOME"] = fallbackHome;
  }
  return env;
}

function codexHomeFallback(cwd: string): string | null {
  if (process.env["CODEX_HOME"]) return null;

  const home = process.env["HOME"] || os.homedir();
  const defaultCodexHome = path.join(home, ".codex");
  if (
    isWritableDir(defaultCodexHome) ||
    (!fs.existsSync(defaultCodexHome) && isWritableDir(home))
  ) {
    return null;
  }

  const fallback = path.join(cwd, ".minions", "codex-home");
  try {
    fs.mkdirSync(fallback, { recursive: true });
  } catch (err) {
    throw new Error(
      `Codex home is not writable and fallback CODEX_HOME could not be created at ${fallback}: ` +
        errorMessage(err),
    );
  }
  return fallback;
}

function isWritableDir(dir: string): boolean {
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const EXACT_ENV_ALLOWLIST = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "COMSPEC", "PATHEXT", "SYSTEMROOT", "WINDIR",
  "TMPDIR", "TMP", "TEMP", "LANG", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "CODEX_HOME", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID",
  "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_VERSION",
]);

function allowedProcessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      (EXACT_ENV_ALLOWLIST.has(key) || key === "TZ" || key.startsWith("LC_") || key.startsWith("XDG_"))
    ) {
      out[key] = value;
    }
  }
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
