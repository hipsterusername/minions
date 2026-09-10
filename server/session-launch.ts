import type { Bus } from "./bus.ts";
import type { SessionRegistry } from "./session-registry.ts";
import type { StartSessionOptions } from "./session-host.ts";
import { getHarnessReadiness } from "./harness/readiness.ts";
import { productionHarnesses } from "./harness/index.ts";
import { harnessForModel, resolveLaunchModel } from "./harness/model-policy.ts";
import { readSettings, type ExecutorClass } from "./project-store.ts";
import type { HarnessReadinessSnapshot } from "./harness/readiness-types.ts";

export type LaunchReason = "harness_not_ready" | "model_incompatible" | "permission_unsupported";

export interface SessionLaunchResult {
  sessionKey: string;
  harness: string;
  model: string;
  permissionMode: string;
  reasons: LaunchReason[];
}

export class SessionLaunchError extends Error {
  constructor(readonly code: "HARNESS_NOT_READY" | "NO_COMPATIBLE_MODEL", readonly readiness: HarnessReadinessSnapshot) {
    super(code === "HARNESS_NOT_READY" ? "No authenticated agent harness is ready." : "No compatible model is registered for the ready harness.");
  }
}

export async function launchSession(input: {
  registry: SessionRegistry;
  bus: Bus;
  options: StartSessionOptions;
  executorClass?: ExecutorClass;
  getReadiness?: typeof getHarnessReadiness;
}): Promise<SessionLaunchResult> {
  const { registry, bus, options } = input;
  const reservation = registry.reserveCapacity(options.sessionKey);
  try {
    if (registry.has(options.sessionKey)) {
      await registry.start(options, reservation);
      const host = registry.get(options.sessionKey)!;
      return { sessionKey: options.sessionKey, harness: host.harnessName, model: host.model ?? "", permissionMode: host.permissionMode ?? "auto", reasons: [] };
    }
    const readiness = await (input.getReadiness ?? getHarnessReadiness)({ fresh: true });
    if (!readiness.ready) throw new SessionLaunchError("HARNESS_NOT_READY", readiness);
    const leader = options.role !== "minion";
    const settings = leader ? readSettings(options.cwd) : {};
    const defaultHarness = settings.defaultLeaderHarness;
    const defaultModel = settings.defaultLeaderModel ?? settings.defaultModel;
    const requestedHarness = options.harness || harnessForModel(options.initialModel)
      || defaultHarness || (leader ? "codex" : "claude");
    const effectiveHarness = readiness.readyHarnesses.includes(requestedHarness)
      ? requestedHarness
      : defaultHarness && readiness.readyHarnesses.includes(defaultHarness)
      ? defaultHarness
      : productionHarnesses().find((harness) => readiness.readyHarnesses.includes(harness.name))?.name;
    if (!effectiveHarness) throw new SessionLaunchError("HARNESS_NOT_READY", readiness);
    const reasons: LaunchReason[] = [];
    if (effectiveHarness !== requestedHarness) reasons.push("harness_not_ready");
    const requestedModel = options.initialModel
      ?? (requestedHarness === defaultHarness ? defaultModel : undefined);
    const modelResolution = resolveLaunchModel({
      requestedHarness,
      effectiveHarness,
      requestedModel,
      role: options.role === "minion" ? "minion" : "leader",
      executorClass: input.executorClass,
    });
    if (!modelResolution) throw new SessionLaunchError("NO_COMPATIBLE_MODEL", readiness);
    // Prefer the configured model when an incompatible selection falls back
    // to the project's default provider.
    if ((modelResolution.incompatible || effectiveHarness !== requestedHarness)
      && effectiveHarness === defaultHarness && defaultModel) {
      const fallback = resolveLaunchModel({ requestedHarness: effectiveHarness, effectiveHarness,
        requestedModel: defaultModel, role: "leader" });
      if (fallback) modelResolution.model = fallback.model;
    }
    if (modelResolution.incompatible) reasons.push("model_incompatible");
    const requestedPermission = options.permissionMode || "auto";
    const supported = ["default", "auto", "bypassPermissions", "plan"].includes(requestedPermission);
    const permissionMode = supported ? requestedPermission : "auto";
    if (!supported) reasons.push("permission_unsupported");
    const result = { sessionKey: options.sessionKey, harness: effectiveHarness, model: modelResolution.model, permissionMode, reasons };
    if (reasons.length > 0) {
      bus.emitToSession(options.sessionKey, {
        type: "session_launch_resolved",
        sessionKey: options.sessionKey,
        requested: { harness: options.harness, model: requestedModel, permissionMode: options.permissionMode },
        effective: { harness: effectiveHarness, model: modelResolution.model, permissionMode },
        reasons,
        transient: true,
      });
    }
    await registry.start({ ...options, harness: effectiveHarness, initialModel: modelResolution.model, permissionMode,
      ...(effectiveHarness !== requestedHarness ? { resumeId: undefined, prompt: options.freshThreadPrompt ?? options.prompt } : {}),
    }, reservation);
    return result;
  } catch (error) {
    registry.releaseCapacity(reservation);
    throw error;
  }
}
