import { describe, expect, it } from "vitest";
import { resolveNewProjectDefaults } from "./project-defaults.ts";
import type { HarnessReadinessSnapshot } from "./harness/readiness-types.ts";

function snapshot(readyHarnesses: string[]): HarnessReadinessSnapshot {
  return { schemaVersion: 1, checkedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:00:30.000Z", ready: readyHarnesses.length > 0, readyHarnesses, harnesses: [] };
}

describe("resolveNewProjectDefaults", () => {
  it.each([
    [["claude", "codex"], "codex", "claude", "claude-sonnet-5"],
    [["codex"], "codex", "codex", "gpt-5.6-terra"],
    [["claude"], "claude", "claude", "claude-sonnet-5"],
    [["echo"], "echo", "echo", "echo"],
  ] as const)("derives defaults for %j", (ready, leader, minion, model) => {
    const result = resolveNewProjectDefaults(snapshot([...ready]));
    expect(result).toMatchObject({ defaultLeaderHarness: leader, defaultMinionHarness: minion, defaultMinionModel: model, defaultModel: model });
  });
  it("returns null when neither harness is ready", () => expect(resolveNewProjectDefaults(snapshot([]))).toBeNull());
});
