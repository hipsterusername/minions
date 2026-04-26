import { describe, expect, it } from "vitest";
import { getModelCapability, MODEL_CAPABILITIES } from "./model-meta.ts";
import type { ModelOption } from "./components/SessionToolbar.tsx";

describe("getModelCapability", () => {
  it("returns correct capability for each known model", () => {
    for (const [model, expected] of Object.entries(MODEL_CAPABILITIES)) {
      expect(getModelCapability(model as ModelOption)).toBe(expected);
    }
  });

  it("returns a safe fallback for an unrecognized model value instead of crashing", () => {
    // Simulates stale persisted data arriving with a model string not in the map.
    const cap = getModelCapability("unknown-model" as ModelOption);
    expect(cap).toBeDefined();
    expect(cap.supportsAdaptiveThinking).toBe(false);
    expect(cap.supportedEffortLevels).toEqual([]);
  });
});
