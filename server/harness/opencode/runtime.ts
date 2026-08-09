import type { HarnessReadinessContext, HarnessReadinessProbe } from "../readiness-types.ts";
import { resolveCliRuntime, type CliRuntime } from "../cli-runtime.ts";
import { runProcess, type ProcessRunner } from "../process-runner.ts";
import { parseOpenCodeModels, setOpenCodeModels } from "./models.ts";

export function resolveOpenCodeRuntime(env: NodeJS.ProcessEnv = process.env): CliRuntime | null {
  return resolveCliRuntime("OPENCODE_PATH", "opencode", env);
}

export async function checkOpenCodeReadiness(
  context: HarnessReadinessContext,
  deps: { resolve?: () => CliRuntime | null; run?: ProcessRunner } = {},
): Promise<HarnessReadinessProbe> {
  const runtime = (deps.resolve ?? resolveOpenCodeRuntime)();
  const source = runtime?.source ?? (process.env["OPENCODE_PATH"] ? "env_override" : "path");
  if (!runtime) {
    setOpenCodeModels([]);
    return { state: "runtime_missing", runtime: { available: false, source }, auth: { authenticated: false, source: "unknown" } };
  }
  const result = await (deps.run ?? runProcess)(runtime.executable, ["models"], {
    env: process.env,
    signal: context.signal,
  });
  const models = result.code === 0 ? parseOpenCodeModels(result.stdout) : [];
  setOpenCodeModels(models);
  const ready = result.code === 0 && models.length > 0;
  return {
    state: ready ? "ready" : result.code === 0 ? "unauthenticated" : "probe_failed",
    runtime: { available: true, source },
    auth: { authenticated: ready, source: ready ? "cli_login" : "unknown" },
  };
}
