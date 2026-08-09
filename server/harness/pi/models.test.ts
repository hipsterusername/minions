import { describe, expect, it } from "vitest";
import { parsePiModels, resolvePiModel } from "./models.ts";
import { checkPiReadiness } from "./runtime.ts";

const context = () => ({ signal: new AbortController().signal });

describe("Pi model discovery", () => {
  it("parses provider/model TSV rows", () => {
    const stdout = "Provider\tModel\tName\tContext\n" +
      "anthropic\tclaude-sonnet-4-5\tClaude Sonnet 4.5\t200000\n" +
      "ollama\tqwen2.5-coder:7b\tQwen Coder\t128000\n";
    expect(parsePiModels(stdout)).toEqual([
      { id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
      { id: "ollama/qwen2.5-coder:7b", label: "Qwen Coder" },
    ]);
  });

  it("accepts already-prefixed model rows and rejects the empty notice", () => {
    expect(parsePiModels("openai/gpt-5.2\tGPT-5.2\nNo models available. Set API keys.\n")).toEqual([
      { id: "openai/gpt-5.2", label: "openai/gpt-5.2" },
    ]);
  });

  it("reports the PATH runtime ready when configured models are available", async () => {
    const result = await checkPiReadiness(context(), {
      resolve: () => ({ executable: "/fixture/pi", source: "path" }),
      run: async () => ({ code: 0, stdout: "ollama\tqwen-coder\tQwen Coder\n" }),
    });
    expect(result).toMatchObject({ state: "ready", runtime: { source: "path" }, auth: { authenticated: true } });
  });

  it("passes provider/model ids through unchanged", () => {
    expect(resolvePiModel("ollama/qwen-coder")).toBe("ollama/qwen-coder");
    expect(resolvePiModel("")).toBeNull();
  });
});
