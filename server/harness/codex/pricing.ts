import {
  CODEX_ASTRA_MODEL_ID,
  CODEX_LUNA_MODEL_ID,
  CODEX_SOL_MODEL_ID,
  CODEX_TERRA_MODEL_ID,
} from "./models.ts";

interface CodexRateCard {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

export interface CodexTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
}

// Standard API prices in USD per million tokens, verified against OpenAI's
// pricing documentation on 2026-09-04. Long-context requests use the rates
// OpenAI applies to prompts over 272K input tokens.
const STANDARD_RATES: Readonly<Record<string, CodexRateCard>> = {
  [CODEX_ASTRA_MODEL_ID]: { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
  [CODEX_SOL_MODEL_ID]: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 },
  [CODEX_TERRA_MODEL_ID]: { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 },
  [CODEX_LUNA_MODEL_ID]: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 },
};

const LONG_CONTEXT_THRESHOLD = 272_000;
const WEB_SEARCH_COST_USD = 10 / 1_000;

/** Estimate one Codex turn at standard API rates. */
export function estimateCodexTurnCostUSD(
  model: string,
  usage: CodexTokenUsage,
  webSearchCalls = 0,
): number | null {
  const standard = STANDARD_RATES[model];
  const ordinaryInput = ordinaryCodexInputTokens(usage);
  if (
    !standard ||
    ordinaryInput == null ||
    !Number.isSafeInteger(webSearchCalls) ||
    webSearchCalls < 0
  ) return null;

  const longContext = usage.inputTokens > LONG_CONTEXT_THRESHOLD;
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  const tokenCost = (
    ordinaryInput * standard.input * inputMultiplier +
    usage.cachedInputTokens * standard.cachedInput * inputMultiplier +
    usage.cacheWriteInputTokens * standard.cacheWrite * inputMultiplier +
    usage.outputTokens * standard.output * outputMultiplier
  ) / 1_000_000;
  return tokenCost + webSearchCalls * WEB_SEARCH_COST_USD;
}

/** Codex input_tokens includes both cache-read and cache-write tokens. */
export function ordinaryCodexInputTokens(usage: CodexTokenUsage): number | null {
  if (!isValidUsage(usage)) return null;
  const ordinary =
    usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens;
  return ordinary >= 0 ? ordinary : null;
}

function isValidUsage(usage: CodexTokenUsage): boolean {
  return Object.values(usage).every(
    (tokens) => Number.isSafeInteger(tokens) && tokens >= 0,
  );
}
