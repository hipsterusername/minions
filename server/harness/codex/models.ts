/**
 * Codex model alias resolution.
 *
 * Maps short UI aliases ("codex", "fast", "default") to canonical OpenAI
 * model IDs. Mirrors the pattern in server/harness/claude/models.ts.
 */

/**
 * Documented Codex model entries, kept in sync with Codex's documented models.
 * Update this table when OpenAI releases a new Codex model ID.
 */
export const CODEX_STATIC_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "gpt-5-codex", label: "GPT-5 Codex" },
  { id: "gpt-5-codex-mini", label: "GPT-5 Codex Mini" },
  { id: "gpt-5", label: "GPT-5" },
];

/**
 * Short aliases the Codex harness accepts, mapped to canonical model IDs.
 * Lookup is done after lowercasing the input, so aliases are case-insensitive.
 */
const CODEX_MODEL_ALIAS_MAP: Record<string, string> = {
  codex: "gpt-5-codex",
  default: "gpt-5-codex",
  fast: "gpt-5-codex-mini",
};

/**
 * Resolve a user-supplied alias or concrete model ID to a canonical Codex model ID.
 *
 * - Known aliases (case-insensitive) are expanded to their full ID.
 * - Strings not in the alias map are returned as-is (treated as concrete IDs).
 * - Null / empty input returns null.
 */
export function resolveCodexModel(alias: string | null | undefined): string | null {
  if (!alias) return null;
  return CODEX_MODEL_ALIAS_MAP[alias.toLowerCase()] ?? alias;
}
