import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Build the environment passed to the Codex CLI.
 *
 * Usually the SDK inherits `process.env` so users keep existing `~/.codex`
 * login/config. If that path is unusable, point `CODEX_HOME` at the app's
 * per-project state directory so Codex can write sessions/logs.
 */
export function buildCodexEnv(
  bridgeEnv: Record<string, string>,
  cwd: string,
): Record<string, string> | undefined {
  const needsBridgeEnv = Object.keys(bridgeEnv).length > 0;
  const fallbackHome = codexHomeFallback(cwd);
  if (!needsBridgeEnv && fallbackHome === null) return undefined;

  const env = stringProcessEnv();
  Object.assign(env, bridgeEnv);
  if (!env["CODEX_HOME"] && fallbackHome !== null) {
    env["CODEX_HOME"] = fallbackHome;
  }
  return env;
}

function codexHomeFallback(cwd: string): string | null {
  if (process.env["CODEX_HOME"]) return null;

  const home = os.homedir();
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

function stringProcessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
