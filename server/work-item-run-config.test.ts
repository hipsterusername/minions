import { describe, expect, it } from "vitest";
import { compatibleResumeId, resolvePrimaryRunConfig } from "./work-item-run-config.ts";

describe("primary run planning config", () => {
  it("does not reuse a defaulted provider thread when switching harnesses", () => {
    const previous = { session_id: "claude-thread", harness_name: "claude",
      run_config_json: JSON.stringify({ orchestrationMode: "auto" }) };
    expect(compatibleResumeId(previous, { harness: "codex" })).toBeUndefined();
    expect(compatibleResumeId(previous, { harness: "claude" })).toBe("claude-thread");
  });
  it("persists Task Graph auto mode when a canonical launch omits the planning mode", () => {
    const { config, json } = resolvePrimaryRunConfig(null, { prompt: "Build it" });

    expect(config.orchestrationMode).toBe("auto");
    expect(JSON.parse(json)).toMatchObject({ orchestrationMode: "auto" });
  });

  it("migrates an existing legacy debug mode when updating run config", () => {
    const { config } = resolvePrimaryRunConfig(
      JSON.stringify({ orchestrationMode: "direct", harness: "codex" }),
      { prompt: "Continue" },
    );

    expect(config.orchestrationMode).toBe("auto");
  });

  it("ignores a direct-mode override from an older client", () => {
    const { config } = resolvePrimaryRunConfig(null, { orchestrationMode: "direct" });
    expect(config.orchestrationMode).toBe("auto");
  });

  it("stages bounded connected context and orchestration mode before launch", () => {
    const context = "<connected-context>Design</connected-context>";
    const { config } = resolvePrimaryRunConfig(null, {
      prompt: `Build it\n${context}`,
      orchestrationMode: "plan",
    });

    expect(config).toMatchObject({ orchestrationMode: "plan", planningContext: context });
  });

  it("rejects an oversized pre-launch connected-context block", () => {
    const prompt = `<connected-context>${"x".repeat(2 * 1024 * 1024)}</connected-context>`;
    expect(() => resolvePrimaryRunConfig(null, { prompt, orchestrationMode: "auto" }))
      .toThrow("2 MiB");
  });
});
