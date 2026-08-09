import * as fs from "node:fs";
import * as path from "node:path";
import type { HarnessReadiness } from "./readiness-types.ts";

export interface CliRuntime {
  executable: string;
  source: HarnessReadiness["runtime"]["source"];
}

/** Resolve an explicit harness path first, then the executable on PATH. */
export function resolveCliRuntime(
  envName: string,
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): CliRuntime | null {
  const override = env[envName]?.trim();
  if (override) {
    return isExecutableFile(override)
      ? { executable: override, source: "env_override" }
      : null;
  }

  const executable = findOnPath(command, env);
  return executable ? { executable, source: "path" } : null;
}

function findOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const pathValue = env["PATH"] ?? env["Path"] ?? env["path"] ?? "";
  const extensions = process.platform === "win32"
    ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, process.platform === "win32" ? `${command}${extension}` : command);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
