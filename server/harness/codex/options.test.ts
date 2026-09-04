
import { describe, expect, it } from "vitest";
import {
  CODEX_MODEL_POLICY,
  CODEX_STATIC_MODELS,
  resolveCodexModel,
} from "./models.ts";
import {
  buildCodexConfig,
  mapPermission,
  mapReasoningEffort,
  mapSandboxMode,
} from "./options.ts";

describe("buildCodexConfig", () => {
  it("adds systemPrompt as additive developer instructions", () => {
    const bridgeConfig = {
      "mcp_servers.task-manager": {
        url: "http://127.0.0.1/mcp",
        bearer_token_env_var: "MINIONS_BRIDGE_TOKEN_TASK_MANAGER",
      },
    };

    expect(buildCodexConfig(bridgeConfig, "SYSTEM_PROMPT_SENTINEL")).toEqual({
      ...bridgeConfig,
      developer_instructions: "SYSTEM_PROMPT_SENTINEL",
    });
  });

  it.each([undefined, ""])(
    "omits developer_instructions when systemPrompt is %s",
    (systemPrompt) => {
      expect(buildCodexConfig({}, systemPrompt)).not.toHaveProperty(
        "developer_instructions",
      );
    },
  );
});

describe("resolveCodexModel", () => {
  it("returns null for null", () => {
    expect(resolveCodexModel(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(resolveCodexModel("")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(resolveCodexModel(undefined)).toBeNull();
  });

  it.each([
    // Short harness aliases + flagship default.
    ["codex", "gpt-6-astra"],
    ["default", "gpt-6-astra"],
    ["codex-default", "gpt-6-astra"],
    ["fast", "gpt-5.6-luna"],
    // Bare generation alias routes to the flagship tier.
    ["gpt-5.6", "gpt-5.6-sol"],
    // Canonical model IDs are identities.
    ["gpt-6-astra", "gpt-6-astra"],
    ["gpt-5.6-sol", "gpt-5.6-sol"],
    ["gpt-5.6-terra", "gpt-5.6-terra"],
    ["gpt-5.6-luna", "gpt-5.6-luna"],
    // Legacy persisted IDs resolve forward to the nearest current tier.
    ["gpt-5.5", "gpt-5.6-sol"],
    ["gpt-5.4", "gpt-5.6-terra"],
    ["gpt-5.3-codex-spark", "gpt-5.6-luna"],
    ["gpt-5", "gpt-5.6-sol"],
    ["gpt-5-codex", "gpt-5.6-sol"],
    ["gpt-5-codex-mini", "gpt-5.6-luna"],
  ] as const)("maps alias '%s' to '%s'", (alias, expected) => {
    expect(resolveCodexModel(alias)).toBe(expected);
  });

  it.each([
    ["CODEX", "gpt-6-astra"],
    ["Default", "gpt-6-astra"],
    ["FAST", "gpt-5.6-luna"],
    ["Codex", "gpt-6-astra"],
    ["GPT-6-ASTRA", "gpt-6-astra"],
    ["GPT-5.6-Sol", "gpt-5.6-sol"],
  ] as const)("resolves alias '%s' case-insensitively", (alias, expected) => {
    expect(resolveCodexModel(alias)).toBe(expected);
  });

  it("passes through unknown aliases unchanged", () => {
    expect(resolveCodexModel("some-custom-model-id")).toBe("some-custom-model-id");
    expect(resolveCodexModel("gpt-4o")).toBe("gpt-4o");
  });
});

describe("CODEX_STATIC_MODELS", () => {
  it("contains entries where every id is a non-empty string", () => {
    for (const entry of CODEX_STATIC_MODELS) {
      expect(typeof entry.id).toBe("string");
      expect(entry.id.length).toBeGreaterThan(0);
    }
  });

  it("contains entries where every label is a non-empty string", () => {
    for (const entry of CODEX_STATIC_MODELS) {
      expect(typeof entry.label).toBe("string");
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it("exposes Astra followed by the current GPT-5.6 tier options", () => {
    const ids = CODEX_STATIC_MODELS.map((m) => m.id);
    expect(ids).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    // Legacy / bare generation IDs are not exposed as selectable options.
    expect(ids).not.toContain("gpt-5");
    expect(ids).not.toContain("gpt-5.6");
    expect(ids).not.toContain("gpt-5.5");
    expect(ids).not.toContain("gpt-5.3-codex-spark");
  });

  it("prefers Astra for leaders and reasoning minions without displacing lower-cost tiers", () => {
    expect(CODEX_MODEL_POLICY.leader[0]).toBe("gpt-6-astra");
    expect(CODEX_MODEL_POLICY.minion.reasoning[0]).toBe("gpt-6-astra");
    expect(CODEX_MODEL_POLICY.minion.standard[0]).toBe("gpt-5.6-terra");
    expect(CODEX_MODEL_POLICY.minion.mechanical[0]).toBe("gpt-5.6-luna");
  });
});

describe("mapPermission", () => {
  it.each([
    [
      { filesystemScope: "read-only", approvalPolicy: "always" } as const,
      { approvalPolicy: "untrusted", sandboxMode: "read-only" },
    ],
    [
      { filesystemScope: "workspace-write", approvalPolicy: "on-failure" } as const,
      { approvalPolicy: "on-failure", sandboxMode: "workspace-write" },
    ],
    [
      { filesystemScope: "unrestricted", approvalPolicy: "never" } as const,
      { approvalPolicy: "never", sandboxMode: "danger-full-access" },
    ],
  ])("maps explicit policy %# to Codex options", (policy, expected) => {
    expect(mapPermission(policy)).toEqual(expected);
  });

  it("lets an explicit policy override a conflicting legacy plan mode", () => {
    expect(mapPermission({
      filesystemScope: "unrestricted", approvalPolicy: "never",
    }, "plan")).toEqual({
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
    });
  });

  it("fails closed when no explicit policy reaches the adapter", () => {
    expect(mapPermission(undefined)).toEqual({
      approvalPolicy: "on-failure",
      sandboxMode: "read-only",
    });
  });

  it("keeps legacy approval fallback independent from sandbox access", () => {
    expect(mapPermission(undefined, "plan")).toEqual({
      approvalPolicy: "on-request",
      sandboxMode: "read-only",
    });
  });
});

describe("mapReasoningEffort", () => {
  it.each([
    ["low" as const, "low"],
    ["medium" as const, "medium"],
    ["high" as const, "high"],
    ["xhigh" as const, "xhigh"],
    ["max" as const, "max"],
  ] as const)("maps effort '%s' to '%s'", (input, expected) => {
    expect(mapReasoningEffort(input)).toBe(expected);
  });
});

describe("mapSandboxMode", () => {
  it("returns 'read-only' when permissionMode is 'plan' regardless of worktreeIsolation", () => {
    expect(mapSandboxMode({ worktreeIsolation: false, permissionMode: "plan" })).toBe("read-only");
    expect(mapSandboxMode({ worktreeIsolation: true, permissionMode: "plan" })).toBe("read-only");
  });

  it.each([
    ["bypassPermissions" as const],
    ["auto" as const],
    ["default" as const],
  ])("does not let permissionMode '%s' imply full-host access", (mode) => {
    expect(mapSandboxMode({ worktreeIsolation: false, permissionMode: mode })).toBe(
      "workspace-write",
    );
    expect(mapSandboxMode({ worktreeIsolation: true, permissionMode: mode })).toBe(
      "workspace-write",
    );
  });

  it("uses workspace-write for every authorized execution root", () => {
    expect(mapSandboxMode({ worktreeIsolation: false })).toBe("workspace-write");
    expect(mapSandboxMode({ worktreeIsolation: true })).toBe("workspace-write");
  });
});
