import type { HarnessReadinessSnapshot } from "./harness/readiness-types.ts";
import type { ProjectSettings } from "./project-store.ts";

const leaderThinking = { enabled: true, effort: "high" as const, display: "summarized" as const };
const minionThinking = { enabled: true, effort: "medium" as const, display: "summarized" as const };

export function resolveNewProjectDefaults(snapshot: HarnessReadinessSnapshot): ProjectSettings | null {
  const codex = snapshot.readyHarnesses.includes("codex");
  const claude = snapshot.readyHarnesses.includes("claude");
  const echo = snapshot.readyHarnesses.includes("echo");
  if (!codex && !claude && !echo) return null;
  if (!codex && !claude && echo) {
    return {
      defaultModel: "echo",
      defaultLeaderHarness: "echo",
      defaultLeaderModel: "echo",
      defaultLeaderThinkingConfig: leaderThinking,
      defaultMinionHarness: "echo",
      defaultMinionModel: "echo",
      mechanicalMinionModel: "echo",
      reasoningMinionModel: "echo",
      defaultMinionThinkingConfig: minionThinking,
      defaultPermissionMode: "auto",
      defaultWorktreeIsolation: false,
      systemModel: "off",
    };
  }
  const leaderHarness = codex ? "codex" : "claude";
  const minionHarness = claude ? "claude" : "codex";
  const leaderModel = codex ? "gpt-5.6-sol" : "claude-opus-4-8";
  const minionModel = claude ? "claude-sonnet-5" : "gpt-5.6-terra";
  return {
    defaultModel: minionModel,
    defaultLeaderHarness: leaderHarness,
    defaultLeaderModel: leaderModel,
    defaultLeaderThinkingConfig: leaderThinking,
    defaultMinionHarness: minionHarness,
    defaultMinionModel: minionModel,
    mechanicalMinionModel: claude ? "claude-haiku-4-5" : "gpt-5.6-luna",
    reasoningMinionModel: claude ? "claude-opus-4-8" : "gpt-5.6-sol",
    defaultMinionThinkingConfig: minionThinking,
    defaultPermissionMode: "auto",
    defaultWorktreeIsolation: false,
    systemModel: "off",
  };
}
