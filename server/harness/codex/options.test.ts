/**
 * Unit tests for Codex option/model mapping helpers.
 *
 * Table-driven; covers every mapping row and edge case.
 * No I/O — all functions under test are pure.
 */

import { describe, expect, it } from "vitest";
import { CODEX_STATIC_MODELS, resolveCodexModel } from "./models.ts";
import { mapPermission, mapReasoningEffort, mapSandboxMode } from "./options.ts";

// ── resolveCodexModel ─────────────────────────────────────────────────────────

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
    ["codex", "gpt-5.6-sol"],
    ["default", "gpt-5.6-sol"],
    ["codex-default", "gpt-5.6-sol"],
    ["fast", "gpt-5.6-luna"],
    // Bare generation alias routes to the flagship tier.
    ["gpt-5.6", "gpt-5.6-sol"],
    // Canonical tier IDs are identities.
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
    ["CODEX", "gpt-5.6-sol"],
    ["Default", "gpt-5.6-sol"],
    ["FAST", "gpt-5.6-luna"],
    ["Codex", "gpt-5.6-sol"],
    ["GPT-5.6-Sol", "gpt-5.6-sol"],
  ] as const)("resolves alias '%s' case-insensitively", (alias, expected) => {
    expect(resolveCodexModel(alias)).toBe(expected);
  });

  it("passes through unknown aliases unchanged", () => {
    expect(resolveCodexModel("some-custom-model-id")).toBe("some-custom-model-id");
    expect(resolveCodexModel("gpt-4o")).toBe("gpt-4o");
  });
});

// ── CODEX_STATIC_MODELS ───────────────────────────────────────────────────────

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

  it("exposes only the current GPT-5.6 tier options", () => {
    const ids = CODEX_STATIC_MODELS.map((m) => m.id);
    expect(ids).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    // Legacy / bare generation IDs are not exposed as selectable options.
    expect(ids).not.toContain("gpt-5");
    expect(ids).not.toContain("gpt-5.6");
    expect(ids).not.toContain("gpt-5.5");
    expect(ids).not.toContain("gpt-5.3-codex-spark");
  });
});

// ── mapPermission ─────────────────────────────────────────────────────────────

describe("mapPermission", () => {
  it.each([
    [
      "bypassPermissions" as const,
      { approvalPolicy: "never", sandboxMode: "danger-full-access", unsupported: false },
    ],
    [
      "auto" as const,
      { approvalPolicy: "on-failure", sandboxMode: "danger-full-access", unsupported: false },
    ],
    [
      "default" as const,
      { approvalPolicy: "on-request", sandboxMode: "danger-full-access", unsupported: false },
    ],
    [
      "plan" as const,
      { approvalPolicy: "on-request", sandboxMode: "read-only", unsupported: true },
    ],
  ])("maps permissionMode '%s' to the correct Codex options", (mode, expected) => {
    expect(mapPermission(mode)).toEqual(expected);
  });

  it("treats undefined as auto with Claude-equivalent filesystem access", () => {
    expect(mapPermission(undefined)).toEqual({
      approvalPolicy: "on-failure",
      sandboxMode: "danger-full-access",
      unsupported: false,
    });
  });
});

// ── mapReasoningEffort ────────────────────────────────────────────────────────

describe("mapReasoningEffort", () => {
  it.each([
    ["low" as const, "low"],
    ["medium" as const, "medium"],
    ["high" as const, "high"],
    ["xhigh" as const, "xhigh"],
  ] as const)("maps effort '%s' to '%s'", (input, expected) => {
    expect(mapReasoningEffort(input)).toBe(expected);
  });
});

// ── mapSandboxMode ────────────────────────────────────────────────────────────

describe("mapSandboxMode", () => {
  it("returns 'read-only' when permissionMode is 'plan' regardless of worktreeIsolation", () => {
    expect(mapSandboxMode({ worktreeIsolation: false, permissionMode: "plan" })).toBe("read-only");
    expect(mapSandboxMode({ worktreeIsolation: true, permissionMode: "plan" })).toBe("read-only");
  });

  it.each([
    ["bypassPermissions" as const],
    ["auto" as const],
    ["default" as const],
  ])("returns 'danger-full-access' when permissionMode is '%s'", (mode) => {
    expect(mapSandboxMode({ worktreeIsolation: false, permissionMode: mode })).toBe(
      "danger-full-access",
    );
    expect(mapSandboxMode({ worktreeIsolation: true, permissionMode: mode })).toBe(
      "danger-full-access",
    );
  });

  it("returns 'danger-full-access' when permissionMode is undefined", () => {
    expect(mapSandboxMode({ worktreeIsolation: false })).toBe("danger-full-access");
    expect(mapSandboxMode({ worktreeIsolation: true })).toBe("danger-full-access");
  });
});
