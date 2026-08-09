import { describe, expect, it } from "vitest";
import { parseOpenCodeModels, resolveOpenCodeModel } from "./models.ts";
import { checkOpenCodeReadiness } from "./runtime.ts";

const context = () => ({ signal: new AbortController().signal });

describe("OpenCode model discovery", () => {
  it("parses canonical provider/model lines and removes duplicates", () => {
    expect(parseOpenCodeModels("anthropic/claude-sonnet-4-5\nopenai/gpt-5.2\nanthropic/claude-sonnet-4-5\n")).toEqual([
      { id: "anthropic/claude-sonnet-4-5", label: "anthropic/claude-sonnet-4-5" },
      { id: "openai/gpt-5.2", label: "openai/gpt-5.2" },
    ]);
  });

  it("ignores prose and malformed output", () => {
    expect(parseOpenCodeModels("No models available\nprovider only\n\n")).toEqual([]);
  });

  it("reports ready only when the effective catalog contains models", async () => {
    const ready = await checkOpenCodeReadiness(context(), {
      resolve: () => ({ executable: "/fixture/opencode", source: "path" }),
      run: async () => ({ code: 0, stdout: "local/qwen-coder\n" }),
    });
    expect(ready).toMatchObject({ state: "ready", runtime: { source: "path" }, auth: { authenticated: true } });

    const empty = await checkOpenCodeReadiness(context(), {
      resolve: () => ({ executable: "/fixture/opencode", source: "path" }),
      run: async () => ({ code: 0, stdout: "" }),
    });
    expect(empty.state).toBe("unauthenticated");
  });

  it("passes configured model ids through unchanged", () => {
    expect(resolveOpenCodeModel("custom/my-model")).toBe("custom/my-model");
    expect(resolveOpenCodeModel(" ")).toBeNull();
  });
});
