import { readSettings } from "../project-store.ts";
import type { AgentTypeContext } from "../agents/types.ts";
import type { Bus } from "../bus.ts";
import { hasSystemModelManifest, loadSystemModel } from "./load.ts";
import type { LoadedSystemModel, ModelValidationError } from "./types.ts";

export type SystemModelMode = "off" | "advisory" | "enforced";

export interface SystemModelRuntime {
  mode: SystemModelMode;
  manifestFound: boolean;
  model: LoadedSystemModel | null;
  loadErrors: ModelValidationError[];
}

const OFF_RUNTIME: SystemModelRuntime = {
  mode: "off",
  manifestFound: false,
  model: null,
  loadErrors: [],
};

export function resolveSystemModelRuntime(ctx: Pick<AgentTypeContext, "cwd" | "worktreeInfo" | "bus" | "sessionKey">): SystemModelRuntime {
  const projectPath = ctx.worktreeInfo?.projectPath ?? ctx.cwd;
  const mode = normalizeMode(readSettings(projectPath).systemModel);
  if (mode === "off") return OFF_RUNTIME;

  const manifestFound = hasSystemModelManifest(ctx.cwd);
  if (!manifestFound) return { mode: "off", manifestFound: false, model: null, loadErrors: [] };

  const { model, errors } = loadSystemModel(ctx.cwd);
  if (errors.length > 0 || !model) {
    emitSystemModelError(ctx.bus, ctx.sessionKey, mode, true, errors);
    return { mode, manifestFound: true, model: null, loadErrors: errors };
  }
  return { mode, manifestFound: true, model, loadErrors: [] };
}

export function resolveSystemModelRuntimeForSession(args: {
  cwd: string;
  projectPath: string;
  sessionKey: string;
  bus: Bus;
}): SystemModelRuntime {
  const mode = normalizeMode(readSettings(args.projectPath).systemModel);
  if (mode === "off") return OFF_RUNTIME;
  const manifestFound = hasSystemModelManifest(args.cwd);
  if (!manifestFound) return { mode: "off", manifestFound: false, model: null, loadErrors: [] };
  const { model, errors } = loadSystemModel(args.cwd);
  if (errors.length > 0 || !model) {
    emitSystemModelError(args.bus, args.sessionKey, mode, true, errors);
    return { mode, manifestFound: true, model: null, loadErrors: errors };
  }
  return { mode, manifestFound: true, model, loadErrors: [] };
}

export function systemModelStatus(runtime: SystemModelRuntime) {
  const model = runtime.model;
  return {
    enabled: runtime.mode !== "off" && Boolean(model),
    mode: runtime.mode,
    manifestFound: runtime.manifestFound,
    counts: {
      capabilities: model?.capabilities.length ?? 0,
      flows: model?.flows.length ?? 0,
      constraints: model?.constraints.length ?? 0,
      decisions: model?.decisions.length ?? 0,
      risks: model?.risks.length ?? 0,
    },
    loadErrors: runtime.loadErrors,
  };
}

function normalizeMode(value: unknown): SystemModelMode {
  return value === "advisory" || value === "enforced" ? value : "off";
}

function emitSystemModelError(
  bus: Bus,
  sessionKey: string,
  mode: SystemModelMode,
  manifestFound: boolean,
  errors: ModelValidationError[],
): void {
  bus.emitToSession(sessionKey, {
    type: "system_model_error",
    sessionKey,
    mode,
    manifestFound,
    errors,
  });
}
