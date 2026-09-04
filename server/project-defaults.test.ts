import { afterEach, describe, expect, it } from "vitest";
import "./harness/register-production.ts";
import { resolveNewProjectDefaults } from "./project-defaults.ts";
import type { HarnessReadinessSnapshot } from "./harness/readiness-types.ts";
import { setOpenCodeModels } from "./harness/opencode/models.ts";
import { setPiModels } from "./harness/pi/models.ts";

function snapshot(readyHarnesses: string[]): HarnessReadinessSnapshot {
  return { schemaVersion: 1, checkedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:00:30.000Z", ready: readyHarnesses.length > 0, readyHarnesses, harnesses: [] };
}

afterEach(() => {
  setOpenCodeModels([]);
  setPiModels([]);
});

describe("resolveNewProjectDefaults", () => {
  it.each([
    [["claude", "codex"], "codex", "claude", "claude-sonnet-5"],
    [["codex"], "codex", "codex", "gpt-5.6-terra"],
    [["claude"], "claude", "claude", "claude-sonnet-5"],
    [["echo"], "echo", "echo", "echo"],
  ] as const)("derives defaults for %j", (ready, leader, minion, model) => {
    const result = resolveNewProjectDefaults(snapshot([...ready]));
    expect(result).toMatchObject({
      defaultLeaderHarness: leader,
      defaultMinionHarness: minion,
      defaultMinionModel: model,
      defaultModel: model,
      defaultSandboxPolicy: {
        filesystemScope: "workspace-write",
        approvalPolicy: "on-failure",
      },
    });
  });

  it("derives defaults from a ready dynamic production harness", () => {
    setOpenCodeModels([
      { id: "openai/leader", label: "Leader" },
      { id: "openai/minion", label: "Minion" },
    ]);
    const result = resolveNewProjectDefaults(snapshot(["opencode", "pi"]));
    expect(result).toMatchObject({
      defaultLeaderHarness: "opencode",
      defaultLeaderModel: "openai/leader",
      defaultMinionHarness: "opencode",
      defaultMinionModel: "openai/leader",
      mechanicalMinionModel: "openai/leader",
      reasoningMinionModel: "openai/leader",
    });
  });

  it("uses Astra for Codex leaders and reasoning minions", () => {
    expect(resolveNewProjectDefaults(snapshot(["codex"]))).toMatchObject({
      defaultLeaderModel: "gpt-6-astra",
      reasoningMinionModel: "gpt-6-astra",
      defaultMinionModel: "gpt-5.6-terra",
      mechanicalMinionModel: "gpt-5.6-luna",
    });
  });

  it("returns null when neither harness is ready", () => expect(resolveNewProjectDefaults(snapshot([]))).toBeNull());
});
