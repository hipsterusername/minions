import { afterEach, describe, expect, it } from "vitest";
import "./opencode/index.ts";
import "./pi/index.ts";
import { modelPolicy, resolveLaunchModel } from "./model-policy.ts";
import { setOpenCodeModels } from "./opencode/models.ts";
import { setPiModels } from "./pi/models.ts";

afterEach(() => {
  setOpenCodeModels([]);
  setPiModels([]);
});

describe("dynamic harness model policy", () => {
  it("uses discovered models as safe defaults for every executor class", () => {
    setPiModels([
      { id: "ollama/qwen-coder", label: "Qwen Coder" },
      { id: "openai/gpt-5.2", label: "GPT-5.2" },
    ]);
    expect(modelPolicy("pi")).toEqual({
      leader: ["ollama/qwen-coder", "openai/gpt-5.2"],
      minion: {
        mechanical: ["ollama/qwen-coder", "openai/gpt-5.2"],
        standard: ["ollama/qwen-coder", "openai/gpt-5.2"],
        reasoning: ["ollama/qwen-coder", "openai/gpt-5.2"],
      },
    });
  });

  it("accepts a model advertised by the selected harness even if another harness also knows it", () => {
    setOpenCodeModels([{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol via OpenCode" }]);
    expect(resolveLaunchModel({
      requestedHarness: "opencode",
      effectiveHarness: "opencode",
      requestedModel: "gpt-5.6-sol",
      role: "leader",
    })).toEqual({ model: "gpt-5.6-sol", incompatible: false });
  });
});
