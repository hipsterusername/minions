import { describe, expect, it } from "vitest";

import type { HarnessInfo } from "../harness-list.ts";
import {
  buildLaunchModelGroups,
  launchModelProviderLabel,
  parseLaunchModelValue,
} from "./launch-models.ts";

function harness(overrides: Partial<HarnessInfo> & Pick<HarnessInfo, "name">): HarnessInfo {
  return {
    name: overrides.name,
    capabilities: {
      thinking: true,
      promptCaching: true,
      mcp: true,
      permissionPrompts: true,
      resume: true,
      partialMessages: true,
      builtInFilesystem: true,
    },
    builtInTools: [],
    models: overrides.models ?? [],
    commands: [],
    agents: [],
    account: overrides.account ?? { provider: overrides.name },
  };
}

const CLAUDE = harness({
  name: "claude",
  account: { provider: "anthropic" },
  models: [{ id: "claude-sonnet-5", label: "Sonnet 5" }],
});
const CODEX = harness({
  name: "codex",
  account: { provider: "openai" },
  models: [
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.5-codex", label: "GPT-5.5 Codex" },
  ],
});

describe("launchModelProviderLabel", () => {
  it("maps known providers to display labels", () => {
    expect(launchModelProviderLabel(CLAUDE)).toBe("Anthropic");
    expect(launchModelProviderLabel(CODEX)).toBe("OpenAI");
    expect(launchModelProviderLabel(harness({ name: "echo", account: { provider: "echo" } }))).toBe("Echo");
  });

  it("title-cases the harness name for unknown providers", () => {
    expect(launchModelProviderLabel(harness({ name: "my-cool_harness", account: { provider: "mystery" } }))).toBe(
      "My Cool Harness",
    );
  });
});

describe("buildLaunchModelGroups", () => {
  it("groups every harness's models with encoded option values", () => {
    const groups = buildLaunchModelGroups([CLAUDE, CODEX]);
    expect(groups.map((g) => g.label)).toEqual(["Anthropic", "OpenAI"]);
    expect(groups[1]!.options).toEqual([
      { value: "codex::gpt-5.5", harness: "codex", id: "gpt-5.5", label: "GPT-5.5" },
      { value: "codex::gpt-5.5-codex", harness: "codex", id: "gpt-5.5-codex", label: "GPT-5.5 Codex" },
    ]);
  });

  it("omits harnesses that expose no models", () => {
    const empty = harness({ name: "bare", models: [] });
    expect(buildLaunchModelGroups([empty, CODEX]).map((g) => g.harness)).toEqual(["codex"]);
  });
});

describe("parseLaunchModelValue", () => {
  it("round-trips an encoded value back to harness + model", () => {
    expect(parseLaunchModelValue("codex::gpt-5.5")).toEqual({ harness: "codex", model: "gpt-5.5" });
    expect(parseLaunchModelValue("claude::claude-sonnet-5")).toEqual({
      harness: "claude",
      model: "claude-sonnet-5",
    });
  });

  it("returns null for the Default (empty) value and malformed input", () => {
    expect(parseLaunchModelValue("")).toBeNull();
    expect(parseLaunchModelValue("no-separator")).toBeNull();
    expect(parseLaunchModelValue("::gpt-5.5")).toBeNull();
    expect(parseLaunchModelValue("codex::")).toBeNull();
  });
});
