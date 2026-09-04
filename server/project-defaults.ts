import type { HarnessReadinessSnapshot } from "./harness/readiness-types.ts";
import { modelPolicy } from "./harness/model-policy.ts";
import type { ProjectSettings } from "./project-store.ts";
import {
  DEFAULT_SANDBOX_POLICY,
  sandboxPolicySchema,
} from "../shared/workspace-contracts.ts";

const leaderThinking = { enabled: true, effort: "high" as const, display: "summarized" as const };
const minionThinking = { enabled: true, effort: "medium" as const, display: "summarized" as const };

export function resolveNewProjectDefaults(snapshot: HarnessReadinessSnapshot): ProjectSettings | null {
  const codex = snapshot.readyHarnesses.includes("codex");
  const claude = snapshot.readyHarnesses.includes("claude");
  const echo = snapshot.readyHarnesses.includes("echo");
  if (!codex && !claude) {
    const fallback = snapshot.readyHarnesses
      .filter((name) => name !== "echo")
      .map((name) => ({ name, policy: modelPolicy(name) }))
      .find(({ policy }) => policy?.leader[0] && policy.minion.standard[0]);
    if (fallback?.policy) {
      const leaderModel = fallback.policy.leader[0]!;
      const minionModel = fallback.policy.minion.standard[0]!;
      return {
        defaultModel: minionModel,
        defaultLeaderHarness: fallback.name,
        defaultLeaderModel: leaderModel,
        defaultLeaderThinkingConfig: leaderThinking,
        defaultMinionHarness: fallback.name,
        defaultMinionModel: minionModel,
        mechanicalMinionModel: fallback.policy.minion.mechanical[0] ?? minionModel,
        reasoningMinionModel: fallback.policy.minion.reasoning[0] ?? minionModel,
        defaultMinionThinkingConfig: minionThinking,
        defaultPermissionMode: "auto",
        defaultSandboxPolicy: DEFAULT_SANDBOX_POLICY,
        defaultWorktreeIsolation: false,
        systemModel: "off",
      };
    }
  }
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
      defaultSandboxPolicy: DEFAULT_SANDBOX_POLICY,
      defaultWorktreeIsolation: false,
      systemModel: "off",
    };
  }
  if (!codex && !claude) return null;
  const leaderHarness = codex ? "codex" : "claude";
  const minionHarness = claude ? "claude" : "codex";
  const leaderModel = codex ? "gpt-6-astra" : "claude-opus-4-8";
  const minionModel = claude ? "claude-sonnet-5" : "gpt-5.6-terra";
  return {
    defaultModel: minionModel,
    defaultLeaderHarness: leaderHarness,
    defaultLeaderModel: leaderModel,
    defaultLeaderThinkingConfig: leaderThinking,
    defaultMinionHarness: minionHarness,
    defaultMinionModel: minionModel,
    mechanicalMinionModel: claude ? "claude-haiku-4-5" : "gpt-5.6-luna",
    reasoningMinionModel: claude ? "claude-opus-4-8" : "gpt-6-astra",
    defaultMinionThinkingConfig: minionThinking,
    defaultPermissionMode: "auto",
    defaultSandboxPolicy: DEFAULT_SANDBOX_POLICY,
    defaultWorktreeIsolation: false,
    systemModel: "off",
  };
}

export function normalizeProjectSandboxPolicy(settings: ProjectSettings): ProjectSettings {
  const parsed = sandboxPolicySchema.safeParse(settings.defaultSandboxPolicy);
  return {
    ...settings,
    defaultSandboxPolicy: parsed.success ? parsed.data : DEFAULT_SANDBOX_POLICY,
  };
}
