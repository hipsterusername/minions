import type { HarnessReadinessContext, HarnessReadinessProbe } from "../readiness-types.ts";
import { resolveCliRuntime, type CliRuntime } from "../cli-runtime.ts";
import { runProcess, type ProcessRunner } from "../process-runner.ts";
import { parsePiModels, setPiModels } from "./models.ts";

export function resolvePiRuntime(env: NodeJS.ProcessEnv = process.env): CliRuntime | null {
  return resolveCliRuntime("PI_PATH", "pi", env);
}

export async function checkPiReadiness(
  context: HarnessReadinessContext,
  deps: { resolve?: () => CliRuntime | null; run?: ProcessRunner } = {},
): Promise<HarnessReadinessProbe> {
  const runtime = (deps.resolve ?? resolvePiRuntime)();
  const source = runtime?.source ?? (process.env["PI_PATH"] ? "env_override" : "path");
  if (!runtime) {
    setPiModels([]);
    return { state: "runtime_missing", runtime: { available: false, source }, auth: { authenticated: false, source: "unknown" } };
  }
  const result = await (deps.run ?? runProcess)(runtime.executable, ["--list-models"], {
    env: process.env,
    signal: context.signal,
  });
  const models = result.code === 0 ? parsePiModels(result.stdout) : [];
  setPiModels(models);
  const ready = result.code === 0 && models.length > 0;
  return {
    state: ready ? "ready" : result.code === 0 ? "unauthenticated" : "probe_failed",
    runtime: { available: true, source },
    auth: { authenticated: ready, source: ready ? "cli_login" : "unknown" },
  };
}
