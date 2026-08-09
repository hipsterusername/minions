import { getHarness, productionHarnesses } from "./index.ts";
import { CLAUDE_MODEL_POLICY } from "./claude/models.ts";
import { CODEX_MODEL_POLICY } from "./codex/models.ts";
import type { ExecutorClass } from "../project-store.ts";

export interface HarnessModelPolicy {
  leader: readonly string[];
  minion: Record<ExecutorClass, readonly string[]>;
}

const POLICIES: Record<string, HarnessModelPolicy> = {
  claude: CLAUDE_MODEL_POLICY,
  codex: CODEX_MODEL_POLICY,
};

export function modelPolicy(name: string): HarnessModelPolicy | undefined {
  const configured = POLICIES[name];
  if (configured) return configured;
  let ids: string[];
  try {
    ids = getHarness(name).staticInfo().models.map((model) => model.id);
  } catch {
    return undefined;
  }
  if (ids.length === 0) return undefined;
  return {
    leader: ids,
    minion: { mechanical: ids, standard: ids, reasoning: ids },
  };
}

export function resolveLaunchModel(input: {
  requestedHarness?: string;
  effectiveHarness: string;
  requestedModel?: string;
  role: "leader" | "minion";
  executorClass?: ExecutorClass;
}): { model: string; incompatible: boolean } | null {
  const harness = getHarness(input.effectiveHarness);
  const advertised = new Set(harness.staticInfo().models.map((item) => item.id));
  const chain = input.role === "leader"
    ? modelPolicy(input.effectiveHarness)?.leader
    : modelPolicy(input.effectiveHarness)?.minion[input.executorClass ?? "standard"];
  const fallback =
    chain?.find((id) => advertised.has(id)) ??
    harness.staticInfo().models.find((model) => advertised.has(model.id))?.id;
  if (!fallback) return null;
  if (!input.requestedModel || input.requestedHarness !== input.effectiveHarness) {
    return { model: fallback, incompatible: Boolean(input.requestedModel) };
  }
  const normalized = harness.resolveModel(input.requestedModel);
  if (!normalized) return { model: fallback, incompatible: true };
  if (advertised.has(normalized)) return { model: normalized, incompatible: false };
  const belongsElsewhere = productionHarnesses().some((other) =>
    other.name !== harness.name && other.staticInfo().models.some((item) => item.id === other.resolveModel(input.requestedModel!)),
  );
  if (belongsElsewhere) return { model: fallback, incompatible: true };
  return { model: normalized, incompatible: false };
}
