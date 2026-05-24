/**
 * Codex model alias resolution.
 *
 * Maps short UI aliases ("codex", "fast", "default") to canonical OpenAI
 * model IDs. Mirrors the pattern in server/harness/claude/models.ts.
 */

/**
 * Codex model entries exposed in the UI.
 *
 * ChatGPT-backed Codex accounts reject older explicit model IDs such as
 * `gpt-5` and `gpt-5-codex*`. Current Codex docs use GPT-5.5, GPT-5.4,
 * and GPT-5.3 Codex Spark model strings, so the UI exposes those directly
 * and legacy persisted IDs resolve forward to GPT-5.5.
 */
export const CODEX_DEFAULT_MODEL_ID = "gpt-5.5";
export const CODEX_FALLBACK_MODEL_ID = "gpt-5.4";
export const CODEX_SPARK_MODEL_ID = "gpt-5.3-codex-spark";

export const CODEX_STATIC_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: CODEX_DEFAULT_MODEL_ID, label: "GPT-5.5" },
  { id: CODEX_FALLBACK_MODEL_ID, label: "GPT-5.4" },
  { id: CODEX_SPARK_MODEL_ID, label: "GPT-5.3-Codex-Spark" },
];

/**
 * Short aliases the Codex harness accepts, mapped to canonical model IDs.
 * Lookup is done after lowercasing the input, so aliases are case-insensitive.
 */
const CODEX_MODEL_ALIAS_MAP: Record<string, string> = {
  [CODEX_DEFAULT_MODEL_ID]: CODEX_DEFAULT_MODEL_ID,
  [CODEX_FALLBACK_MODEL_ID]: CODEX_FALLBACK_MODEL_ID,
  [CODEX_SPARK_MODEL_ID]: CODEX_SPARK_MODEL_ID,
  codex: CODEX_DEFAULT_MODEL_ID,
  default: CODEX_DEFAULT_MODEL_ID,
  fast: CODEX_DEFAULT_MODEL_ID,
  "codex-default": CODEX_DEFAULT_MODEL_ID,
  "gpt-5": CODEX_DEFAULT_MODEL_ID,
  "gpt-5-codex": CODEX_DEFAULT_MODEL_ID,
  "gpt-5-codex-mini": CODEX_DEFAULT_MODEL_ID,
};

/**
 * Resolve a user-supplied alias or concrete model ID to a canonical Codex model ID.
 *
 * - Known aliases (case-insensitive) are expanded to current Codex model IDs.
 *   Old persisted IDs are treated as compatibility aliases.
 * - Strings not in the alias map are returned as-is (treated as concrete IDs).
 * - Null / empty input returns null.
 */
export function resolveCodexModel(alias: string | null | undefined): string | null {
  if (!alias) return null;
  return CODEX_MODEL_ALIAS_MAP[alias.toLowerCase()] ?? alias;
}
