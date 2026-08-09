/**
 * Codex model alias resolution.
 *
 * Maps short UI aliases ("codex", "fast", "default") to canonical OpenAI
 * model IDs. Mirrors the pattern in server/harness/claude/models.ts.
 */

/**
 * Codex model entries exposed in the UI.
 *
 * GPT-5.6 is a three-tier model family (OpenAI, 2026-07). The generation
 * number ("5.6") is shared; the tier name is a durable capability tier:
 *   - Sol   — flagship, most capable  (`gpt-5.6-sol`)
 *   - Terra — strong lower-cost mid   (`gpt-5.6-terra`)
 *   - Luna  — fastest / cheapest      (`gpt-5.6-luna`)
 * The bare `gpt-5.6` generation alias routes to the flagship tier (Sol),
 * matching OpenAI's own routing. Older explicit IDs (`gpt-5`, `gpt-5.5`,
 * `gpt-5.3-codex-spark`, …) are rejected by current Codex accounts, so they
 * resolve forward to the nearest current tier.
 */
export const CODEX_SOL_MODEL_ID = "gpt-5.6-sol";
export const CODEX_TERRA_MODEL_ID = "gpt-5.6-terra";
export const CODEX_LUNA_MODEL_ID = "gpt-5.6-luna";

/** Flagship tier is the default when a caller asks for Codex without a tier. */
export const CODEX_DEFAULT_MODEL_ID = CODEX_SOL_MODEL_ID;

export const CODEX_STATIC_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: CODEX_SOL_MODEL_ID, label: "GPT-5.6 Sol" },
  { id: CODEX_TERRA_MODEL_ID, label: "GPT-5.6 Terra" },
  { id: CODEX_LUNA_MODEL_ID, label: "GPT-5.6 Luna" },
];

export const CODEX_MODEL_POLICY = {
  leader: [CODEX_SOL_MODEL_ID, CODEX_TERRA_MODEL_ID, CODEX_LUNA_MODEL_ID],
  minion: {
    mechanical: [CODEX_LUNA_MODEL_ID, CODEX_TERRA_MODEL_ID, CODEX_SOL_MODEL_ID],
    standard: [CODEX_TERRA_MODEL_ID, CODEX_LUNA_MODEL_ID, CODEX_SOL_MODEL_ID],
    reasoning: [CODEX_SOL_MODEL_ID, CODEX_TERRA_MODEL_ID, CODEX_LUNA_MODEL_ID],
  },
} as const;

/**
 * Short aliases the Codex harness accepts, mapped to canonical model IDs.
 * Lookup is done after lowercasing the input, so aliases are case-insensitive.
 */
const CODEX_MODEL_ALIAS_MAP: Record<string, string> = {
  // Canonical tier IDs (identity).
  [CODEX_SOL_MODEL_ID]: CODEX_SOL_MODEL_ID,
  [CODEX_TERRA_MODEL_ID]: CODEX_TERRA_MODEL_ID,
  [CODEX_LUNA_MODEL_ID]: CODEX_LUNA_MODEL_ID,
  // Bare generation alias routes to the flagship tier (OpenAI routing).
  "gpt-5.6": CODEX_SOL_MODEL_ID,
  // Short harness aliases.
  codex: CODEX_DEFAULT_MODEL_ID,
  default: CODEX_DEFAULT_MODEL_ID,
  "codex-default": CODEX_DEFAULT_MODEL_ID,
  fast: CODEX_LUNA_MODEL_ID,
  // Legacy persisted IDs resolve forward to the nearest current tier.
  "gpt-5.5": CODEX_SOL_MODEL_ID,
  "gpt-5.4": CODEX_TERRA_MODEL_ID,
  "gpt-5.3-codex-spark": CODEX_LUNA_MODEL_ID,
  "gpt-5": CODEX_SOL_MODEL_ID,
  "gpt-5-codex": CODEX_SOL_MODEL_ID,
  "gpt-5-codex-mini": CODEX_LUNA_MODEL_ID,
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
