import { describe, expect, it } from "vitest";

import {
  captureLeaderPreset,
  applyPresetToLeaderData,
  type LeaderPreset,
} from "./leader-preset.ts";
import type { LeaderData } from "./nodes/LeaderNode.tsx";
import { DEFAULT_THINKING_CONFIG } from "./types.ts";

// ── Helpers ────────────────────────────────────────────────────────────────────

const FIXED_TS = "2024-01-01T00:00:00.000Z";

function makeLeaderData(overrides: Partial<LeaderData> = {}): LeaderData {
  return {
    // runtime / session state
    sessionKey: "live-session",
    status: "running",
    messages: [{ id: "m1", role: "user", content: "hello", timestamp: 1 }],
    streamingText: "partial output",
    streamingBlockIndex: 0,
    totalCost: 3.14,
    turns: 5,
    error: "oops",
    fullError: "stack trace",
    taskPlan: [
      {
        taskId: "t1",
        title: "Task",
        description: "Do work",
        priority: "high",
        status: "running",
        executor: "minion",
        minionSessionKey: "min-1",
        result: null,
        cost: 0,
        createdAt: 1,
        completedAt: null,
        sessionSummary: "",
      },
    ],
    worktreePath: "/tmp/wt",
    worktreeBranch: "branch-1",
    worktreeStatus: "active",
    autoStartPrompt: "run it",
    taskName: "My live task",
    waitUntil: 999,
    waitReason: "polling",
    // config fields
    model: "claude-opus-4-7",
    harness: "claude",
    permissionMode: "bypassPermissions",
    thinkingConfig: { ...DEFAULT_THINKING_CONFIG, effort: "xhigh" },
    worktreeIsolation: true,
    skillIds: ["review", "debug"],
    skillValues: { review: { scope: "api" }, debug: { depth: "full" } },
    skillPanelOpen: true,
    ...overrides,
  };
}

function makePreset(overrides: Partial<LeaderPreset> = {}): LeaderPreset {
  return {
    id: "p1",
    name: "My Preset",
    model: "claude-opus-4-7",
    harness: "claude",
    permissionMode: "bypassPermissions",
    thinkingConfig: { ...DEFAULT_THINKING_CONFIG, effort: "xhigh" },
    worktreeIsolation: true,
    skillIds: ["review"],
    skillValues: { review: { scope: "api" } },
    skillPanelOpen: false,
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
    ...overrides,
  };
}

// ── captureLeaderPreset ────────────────────────────────────────────────────────

describe("captureLeaderPreset", () => {
  it("preserves model, harness, permissionMode, thinkingConfig, worktreeIsolation", () => {
    const preset = captureLeaderPreset(makeLeaderData(), { id: "p1", name: "Test" }, FIXED_TS);

    expect(preset.model).toBe("claude-opus-4-7");
    expect(preset.harness).toBe("claude");
    expect(preset.permissionMode).toBe("bypassPermissions");
    expect(preset.thinkingConfig).toEqual({ ...DEFAULT_THINKING_CONFIG, effort: "xhigh" });
    expect(preset.worktreeIsolation).toBe(true);
  });

  it("preserves skills configuration", () => {
    const preset = captureLeaderPreset(makeLeaderData(), { id: "p1", name: "Test" }, FIXED_TS);

    expect(preset.skillIds).toEqual(["review", "debug"]);
    expect(preset.skillValues).toEqual({ review: { scope: "api" }, debug: { depth: "full" } });
    expect(preset.skillPanelOpen).toBe(true);
  });

  it("strips sessionKey", () => {
    const preset = captureLeaderPreset(makeLeaderData(), { id: "p1", name: "Test" }, FIXED_TS);
    expect(preset).not.toHaveProperty("sessionKey");
  });

  it("strips status", () => {
    const preset = captureLeaderPreset(makeLeaderData(), { id: "p1", name: "Test" }, FIXED_TS);
    expect(preset).not.toHaveProperty("status");
  });

  it("strips messages", () => {
    const preset = captureLeaderPreset(makeLeaderData(), { id: "p1", name: "Test" }, FIXED_TS);
    expect(preset).not.toHaveProperty("messages");
  });

  it("strips streamingText", () => {
    const preset = captureLeaderPreset(makeLeaderData(), { id: "p1", name: "Test" }, FIXED_TS);
    expect(preset).not.toHaveProperty("streamingText");
  });

  it("strips totalCost and turns", () => {
    const preset = captureLeaderPreset(makeLeaderData(), { id: "p1", name: "Test" }, FIXED_TS);
    expect(preset).not.toHaveProperty("totalCost");
    expect(preset).not.toHaveProperty("turns");
  });

  it("strips error / fullError", () => {
    const preset = captureLeaderPreset(makeLeaderData(), { id: "p1", name: "Test" }, FIXED_TS);
    expect(preset).not.toHaveProperty("error");
    expect(preset).not.toHaveProperty("fullError");
  });

  it("strips taskPlan", () => {
    const preset = captureLeaderPreset(makeLeaderData(), { id: "p1", name: "Test" }, FIXED_TS);
    expect(preset).not.toHaveProperty("taskPlan");
  });

  it("strips worktree runtime fields (path, branch, status)", () => {
    const preset = captureLeaderPreset(makeLeaderData(), { id: "p1", name: "Test" }, FIXED_TS);
    expect(preset).not.toHaveProperty("worktreePath");
    expect(preset).not.toHaveProperty("worktreeBranch");
    expect(preset).not.toHaveProperty("worktreeStatus");
  });

  it("strips autoStartPrompt and taskName", () => {
    const preset = captureLeaderPreset(makeLeaderData(), { id: "p1", name: "Test" }, FIXED_TS);
    expect(preset).not.toHaveProperty("autoStartPrompt");
    expect(preset).not.toHaveProperty("taskName");
  });

  it("strips waitUntil and waitReason", () => {
    const preset = captureLeaderPreset(makeLeaderData(), { id: "p1", name: "Test" }, FIXED_TS);
    expect(preset).not.toHaveProperty("waitUntil");
    expect(preset).not.toHaveProperty("waitReason");
  });

  it("captures description and systemPromptPrefix from meta when provided", () => {
    const preset = captureLeaderPreset(
      makeLeaderData(),
      {
        id: "p1",
        name: "Test",
        description: "A useful preset",
        systemPromptPrefix: "You are a TypeScript expert.",
      },
      FIXED_TS,
    );

    expect(preset.description).toBe("A useful preset");
    expect(preset.systemPromptPrefix).toBe("You are a TypeScript expert.");
  });

  it("omits description and systemPromptPrefix keys when not provided in meta", () => {
    const preset = captureLeaderPreset(makeLeaderData(), { id: "p1", name: "Test" }, FIXED_TS);

    expect(preset).not.toHaveProperty("description");
    expect(preset).not.toHaveProperty("systemPromptPrefix");
  });

  it("sets id and name from meta", () => {
    const preset = captureLeaderPreset(
      makeLeaderData(),
      { id: "preset-42", name: "Fancy Preset" },
      FIXED_TS,
    );

    expect(preset.id).toBe("preset-42");
    expect(preset.name).toBe("Fancy Preset");
  });

  it("sets createdAt and updatedAt to the supplied timestamp", () => {
    const preset = captureLeaderPreset(
      makeLeaderData(),
      { id: "p1", name: "Test" },
      "2025-06-15T12:00:00.000Z",
    );

    expect(preset.createdAt).toBe("2025-06-15T12:00:00.000Z");
    expect(preset.updatedAt).toBe("2025-06-15T12:00:00.000Z");
  });

  it("deep-copies skillIds so mutations do not affect the source", () => {
    const source = makeLeaderData();
    const preset = captureLeaderPreset(source, { id: "p1", name: "Test" }, FIXED_TS);

    preset.skillIds.push("extra");

    expect(source.skillIds).toEqual(["review", "debug"]);
  });

  it("deep-copies skillValues so mutations do not affect the source", () => {
    const source = makeLeaderData();
    const preset = captureLeaderPreset(source, { id: "p1", name: "Test" }, FIXED_TS);

    preset.skillValues["review"]!["scope"] = "modified";

    expect(source.skillValues["review"]!["scope"]).toBe("api");
  });

  it("omits harness key when source has no harness field", () => {
    const source = makeLeaderData();
    delete (source as { harness?: string }).harness;

    const preset = captureLeaderPreset(source, { id: "p1", name: "Test" }, FIXED_TS);

    expect(preset).not.toHaveProperty("harness");
  });
});

// ── applyPresetToLeaderData ────────────────────────────────────────────────────

describe("applyPresetToLeaderData", () => {
  it("overlays model, harness, permissionMode, thinkingConfig, worktreeIsolation from preset", () => {
    const base = makeLeaderData({
      model: "claude-sonnet-4-6",
      harness: "echo",
      permissionMode: "auto",
      worktreeIsolation: false,
      thinkingConfig: { ...DEFAULT_THINKING_CONFIG, effort: "low" },
    });
    const preset = makePreset();

    const result = applyPresetToLeaderData(preset, base);

    expect(result.model).toBe("claude-opus-4-7");
    expect(result.harness).toBe("claude");
    expect(result.permissionMode).toBe("bypassPermissions");
    expect(result.thinkingConfig).toEqual({ ...DEFAULT_THINKING_CONFIG, effort: "xhigh" });
    expect(result.worktreeIsolation).toBe(true);
  });

  it("overlays skill config from preset", () => {
    const base = makeLeaderData({
      skillIds: ["old-skill"],
      skillValues: { "old-skill": { x: "1" } },
      skillPanelOpen: true,
    });
    const preset = makePreset({
      skillIds: ["review"],
      skillValues: { review: { scope: "api" } },
      skillPanelOpen: false,
    });

    const result = applyPresetToLeaderData(preset, base);

    expect(result.skillIds).toEqual(["review"]);
    expect(result.skillValues).toEqual({ review: { scope: "api" } });
    expect(result.skillPanelOpen).toBe(false);
  });

  it("overlays systemPromptPrefix from preset", () => {
    const base = makeLeaderData({ systemPromptPrefix: "old prefix" });
    const preset = makePreset({ systemPromptPrefix: "new prefix" });

    const result = applyPresetToLeaderData(preset, base);

    expect(result.systemPromptPrefix).toBe("new prefix");
  });

  it("clears systemPromptPrefix when preset has no prefix", () => {
    const base = makeLeaderData({ systemPromptPrefix: "old prefix" });

    const result = applyPresetToLeaderData(makePreset(), base);

    expect(result.systemPromptPrefix).toBeNull();
  });

  it("preserves session/runtime state from base (sessionKey, status, messages)", () => {
    const base = makeLeaderData();
    const result = applyPresetToLeaderData(makePreset(), base);

    expect(result.sessionKey).toBe("live-session");
    expect(result.status).toBe("running");
    expect(result.messages).toHaveLength(1);
  });

  it("preserves cost and turns from base", () => {
    const result = applyPresetToLeaderData(makePreset(), makeLeaderData());

    expect(result.totalCost).toBe(3.14);
    expect(result.turns).toBe(5);
  });

  it("preserves taskPlan from base", () => {
    const result = applyPresetToLeaderData(makePreset(), makeLeaderData());

    expect(result.taskPlan).toHaveLength(1);
  });

  it("preserves worktree runtime fields from base", () => {
    const result = applyPresetToLeaderData(makePreset(), makeLeaderData());

    expect(result.worktreePath).toBe("/tmp/wt");
    expect(result.worktreeBranch).toBe("branch-1");
    expect(result.worktreeStatus).toBe("active");
  });

  it("deep-copies skillIds so mutations do not affect the preset", () => {
    const preset = makePreset({ skillIds: ["review"] });
    const result = applyPresetToLeaderData(preset, makeLeaderData());

    result.skillIds.push("extra");

    expect(preset.skillIds).toEqual(["review"]);
  });

  it("deep-copies skillValues so mutations do not affect the preset", () => {
    const preset = makePreset({ skillValues: { review: { scope: "api" } } });
    const result = applyPresetToLeaderData(preset, makeLeaderData());

    result.skillValues["review"]!["scope"] = "modified";

    expect(preset.skillValues["review"]!["scope"]).toBe("api");
  });

  it("applies harness from preset when present", () => {
    const base = makeLeaderData({ harness: "echo" });
    const result = applyPresetToLeaderData(makePreset({ harness: "claude" }), base);

    expect(result.harness).toBe("claude");
  });

  it("falls back to base harness when preset has no harness key", () => {
    const base = makeLeaderData({ harness: "echo" });
    const preset = makePreset();
    delete (preset as { harness?: string }).harness;

    const result = applyPresetToLeaderData(preset, base);

    // The spread of base carries harness: "echo"; preset does not override it.
    expect(result.harness).toBe("echo");
  });
});
