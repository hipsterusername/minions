import { resolveModelAlias } from "./harness/claude/models.ts";
import { resolveCodexModel } from "./harness/codex/models.ts";
import { modelPolicy } from "./harness/model-policy.ts";
import type { ExecutorClass, ProjectSettings } from "./project-store.ts";

export function resolveMinionModelForHarness(
  settings: ProjectSettings,
  harnessName: string | undefined,
  executorClass: ExecutorClass | undefined,
): string | undefined {
  const configured =
    executorClass === "mechanical"
      ? settings.mechanicalMinionModel
      : executorClass === "reasoning"
        ? settings.reasoningMinionModel
        : settings.defaultMinionModel;
  const fallback = executorClass
    ? modelPolicy(harnessName ?? "claude")?.minion[executorClass][0]
    : firstString(settings.defaultMinionModel, settings.defaultModel);
  return compatibleOrFallback(configured, harnessName, fallback);
}

function compatibleOrFallback(
  model: unknown,
  harnessName: string | undefined,
  fallback: string | undefined,
): string | undefined {
  if (typeof model !== "string") return fallback;
  return isModelCompatibleWithHarness(model, harnessName)
    ? normalizeModel(model, harnessName ?? "claude")
    : fallback;
}

function isModelCompatibleWithHarness(model: string, harnessName: string | undefined): boolean {
  const effective = harnessName ?? "claude";
  return (["claude", "codex"] as const).every((name) =>
    name === effective || !advertisedModels(name).has(normalizeModel(model, name)),
  );
}

function normalizeModel(model: string, harnessName: string): string {
  return (harnessName === "codex" ? resolveCodexModel(model) : resolveModelAlias(model)) ?? model;
}

function advertisedModels(harnessName: string): Set<string> {
  const policy = modelPolicy(harnessName);
  return new Set(policy ? [...policy.leader, ...Object.values(policy.minion).flat()] : []);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}
