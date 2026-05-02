/**
 * Claude model alias resolution.
 *
 * Maps short UI aliases ("opus", "sonnet") to concrete Anthropic model IDs.
 * Single source of truth — session-host-run.ts delegates to harness.resolveModel(),
 * which calls resolveModelAlias() here. No duplicate table elsewhere.
 */

/**
 * Short aliases the UI accepts, mapped to their full Anthropic model IDs.
 * Update this table when a new model ID is released.
 */
const MODEL_ALIAS_MAP: Record<string, string> = {
  opus: "claude-opus-4-7",
  "opus-old": "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
};

/**
 * Resolve a user-supplied alias or concrete model ID to a canonical model ID.
 *
 * - Known aliases are expanded to their full ID.
 * - Strings not in the alias map are returned as-is (treated as concrete IDs).
 * - Null / empty input returns null.
 */
export function resolveModelAlias(alias: string | null | undefined): string | null {
  if (!alias) return null;
  return MODEL_ALIAS_MAP[alias] ?? alias;
}

/**
 * Return true if `model` is known to support adaptive thinking.
 * Mirrors the check in session-host-config.ts; Phase 2 will consolidate.
 */
const ADAPTIVE_THINKING_MODELS: ReadonlySet<string> = new Set([
  "sonnet",
  "opus",
  "opus-old",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-mythos-preview",
]);

export function supportsAdaptiveThinking(model: string | null | undefined): boolean {
  if (!model) return false;
  return ADAPTIVE_THINKING_MODELS.has(model);
}
