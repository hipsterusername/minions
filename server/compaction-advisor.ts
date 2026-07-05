import type { NormalizedEvent } from "../shared/normalized-event.ts";

export const RECOMMEND_THRESHOLD = 0.55;
export const FORCE_THRESHOLD = 0.8;
export const DEFAULT_LARGE_CONTEXT_WINDOW_TOKENS = 1_000_000;
export const FALLBACK_CONTEXT_WINDOW_TOKENS = 200_000;

export type ProactiveCompactionSetting = "off" | "recommend" | "auto";
export const DEFAULT_PROACTIVE_COMPACTION: ProactiveCompactionSetting = "recommend";

export type CompactionAction = "none" | "recommend" | "force";

export interface CompactionAdvisorState {
  recommendedArmed: boolean;
  forcedArmed: boolean;
}

export interface CompactionAdvice {
  action: CompactionAction;
  contextTokens: number;
  contextWindowTokens: number;
  ratio: number;
}

export function initialCompactionAdvisorState(): CompactionAdvisorState {
  return { recommendedArmed: false, forcedArmed: false };
}

export function contextWindowForModel(model: string | null | undefined): number {
  const normalized = (model ?? "").toLowerCase();
  if (
    normalized.includes("opus") ||
    normalized.includes("fable") ||
    normalized.includes("gpt-5")
  ) {
    return DEFAULT_LARGE_CONTEXT_WINDOW_TOKENS;
  }
  return FALLBACK_CONTEXT_WINDOW_TOKENS;
}

export function promptContextTokens(
  usage: Extract<NormalizedEvent, { kind: "usage" }>,
): number {
  return usage.input + (usage.cacheRead ?? 0);
}

export function evaluateCompactionUsage(
  state: CompactionAdvisorState,
  usage: Extract<NormalizedEvent, { kind: "usage" }>,
  model: string | null | undefined,
): CompactionAdvice {
  const contextTokens = promptContextTokens(usage);
  const contextWindowTokens = contextWindowForModel(model);
  const ratio = contextTokens / contextWindowTokens;
  let action: CompactionAction = "none";

  if (ratio >= FORCE_THRESHOLD && !state.forcedArmed) {
    state.forcedArmed = true;
    state.recommendedArmed = true;
    action = "force";
  } else if (ratio >= RECOMMEND_THRESHOLD && !state.recommendedArmed) {
    state.recommendedArmed = true;
    action = "recommend";
  }

  return { action, contextTokens, contextWindowTokens, ratio };
}
