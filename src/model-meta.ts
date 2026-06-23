/**
 * Capability metadata for the model dropdown.
 *
 * Drives UI visibility for adaptive-thinking controls. The shape was
 * Claude-specific (keyed by `ModelOption`) before Phase E; it's now
 * harness-aware: a `HarnessInfo` argument lets non-Claude harnesses
 * declare whether thinking is supported at all and which effort levels
 * apply, while preserving the existing per-model gating Claude needs
 * (Haiku has no thinking; Opus 4.8 supports xhigh/max).
 *
 * Source for Claude entries: the Anthropic adaptive-thinking docs and
 * `ModelInfo` in the Claude Agent SDK. Codex entries follow the
 * Codex-spec mapping in docs/codex-harness-spec.md (low / medium / high
 * via `modelReasoningEffort`).
 */

import type { EffortLevel } from "./types.ts";
import type { HarnessInfo } from "./harness-list.ts";

export interface ModelCapability {
  /** True when the model accepts adaptive/extended thinking. */
  supportsAdaptiveThinking: boolean;
  /** Effort levels this model accepts. Empty when none. */
  supportedEffortLevels: EffortLevel[];
}

const STANDARD_EFFORTS: EffortLevel[] = ["low", "medium", "high"];
const OPUS_EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Per-Claude-model capability table. Keyed by both UI alias
 * ("opus", "sonnet") and concrete Anthropic model id so callers can
 * look up either.
 */
const CLAUDE_MODEL_CAPABILITIES: Record<string, ModelCapability> = {
  // UI aliases
  fable: {
    supportsAdaptiveThinking: true,
    supportedEffortLevels: OPUS_EFFORTS,
  },
  sonnet: {
    supportsAdaptiveThinking: true,
    supportedEffortLevels: STANDARD_EFFORTS,
  },
  opus: {
    supportsAdaptiveThinking: true,
    supportedEffortLevels: OPUS_EFFORTS,
  },
  "opus-old": {
    supportsAdaptiveThinking: true,
    supportedEffortLevels: OPUS_EFFORTS,
  },
  haiku: {
    supportsAdaptiveThinking: false,
    supportedEffortLevels: [],
  },
  // Concrete model ids (matching `staticInfo().models`).
  "claude-fable-5": {
    supportsAdaptiveThinking: true,
    supportedEffortLevels: OPUS_EFFORTS,
  },
  "claude-opus-4-8": {
    supportsAdaptiveThinking: true,
    supportedEffortLevels: OPUS_EFFORTS,
  },
  "claude-opus-4-7": {
    supportsAdaptiveThinking: true,
    supportedEffortLevels: OPUS_EFFORTS,
  },
  "claude-opus-4-6": {
    supportsAdaptiveThinking: true,
    supportedEffortLevels: STANDARD_EFFORTS,
  },
  "claude-sonnet-4-6": {
    supportsAdaptiveThinking: true,
    supportedEffortLevels: STANDARD_EFFORTS,
  },
  "claude-haiku-4-5": {
    supportsAdaptiveThinking: false,
    supportedEffortLevels: [],
  },
};

const NO_THINKING: ModelCapability = {
  supportsAdaptiveThinking: false,
  supportedEffortLevels: [],
};

/**
 * Resolve the per-model capability for the dropdown.
 *
 * - When a `harness` is supplied, its `capabilities.thinking` flag gates
 *   the entire surface — a harness with no thinking always returns
 *   `NO_THINKING` regardless of model.
 * - When the harness supports thinking and the model is Claude-known,
 *   the per-model entry wins (so Haiku correctly hides controls even
 *   under a thinking-capable harness).
 * - Otherwise the model is treated as a thinking-capable harness model
 *   with the standard low/medium/high effort levels (Codex shape).
 *
 * Backward-compatible: callers that pass only a model string still get
 * the legacy Claude behaviour because `harness` defaults to undefined.
 */
export function getModelCapability(
  model: string,
  harness?: HarnessInfo | null,
): ModelCapability {
  if (harness && !harness.capabilities.thinking) {
    return NO_THINKING;
  }
  const claudeCap = CLAUDE_MODEL_CAPABILITIES[model];
  if (claudeCap) return claudeCap;
  if (harness && harness.capabilities.thinking) {
    return {
      supportsAdaptiveThinking: true,
      supportedEffortLevels: STANDARD_EFFORTS,
    };
  }
  return NO_THINKING;
}

/**
 * Legacy export retained for compatibility with the Claude-only callers
 * that imported the bare table. New code should call `getModelCapability`.
 */
export const MODEL_CAPABILITIES = CLAUDE_MODEL_CAPABILITIES;
