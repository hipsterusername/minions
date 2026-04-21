/**
 * Capability metadata per ModelOption.
 *
 * Drives UI visibility for adaptive-thinking controls. Source: the
 * Anthropic adaptive-thinking docs and `ModelInfo` in the Claude
 * Agent SDK (which exposes the same `supportsAdaptiveThinking` /
 * `supportedEffortLevels` fields the API serves).
 */

import type { EffortLevel } from "./types.ts";
import type { ModelOption } from "./components/SessionToolbar.tsx";

export interface ModelCapability {
  /** True when the model accepts `thinking: {type: "adaptive"}`. */
  supportsAdaptiveThinking: boolean;
  /** Effort levels this model accepts. Empty when none. */
  supportedEffortLevels: EffortLevel[];
}

const STANDARD_EFFORTS: EffortLevel[] = ["low", "medium", "high"];
const OPUS_EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

export const MODEL_CAPABILITIES: Record<ModelOption, ModelCapability> = {
  // Sonnet 4.6 supports adaptive (and standard effort levels).
  sonnet: {
    supportsAdaptiveThinking: true,
    supportedEffortLevels: STANDARD_EFFORTS,
  },
  // Opus 4.7: adaptive is the *only* supported thinking mode and
  // it accepts xhigh/max in addition to the standard levels.
  opus: {
    supportsAdaptiveThinking: true,
    supportedEffortLevels: OPUS_EFFORTS,
  },
  // Opus 4.6: adaptive supported with standard effort levels.
  "opus-old": {
    supportsAdaptiveThinking: true,
    supportedEffortLevels: STANDARD_EFFORTS,
  },
  // Haiku 3.5 does not support adaptive thinking.
  haiku: {
    supportsAdaptiveThinking: false,
    supportedEffortLevels: [],
  },
};

export function getModelCapability(model: ModelOption): ModelCapability {
  return MODEL_CAPABILITIES[model];
}
