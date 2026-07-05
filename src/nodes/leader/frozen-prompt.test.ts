import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildFrozenLeaderFollowUpPrompt,
  buildSkillDeltaReminder,
  freezeLeaderSystemPrompt,
} from "./frozen-prompt.ts";
import { clearSkills, registerSkill } from "../../skills/registry.ts";
import type { SkillTemplate } from "../../skills/types.ts";

function makeSkill(overrides: Partial<SkillTemplate> = {}): SkillTemplate {
  return {
    id: "demo",
    name: "Demo",
    description: "A demo skill",
    category: "general",
    icon: "*",
    accentColor: "#fff",
    template: "Do {{thing}}.",
    variables: [],
    ...overrides,
  };
}

describe("frozen leader prompts", () => {
  beforeEach(() => {
    clearSkills();
  });

  afterEach(() => {
    clearSkills();
  });

  it("keeps follow-up systemPrompt bytes identical to the session-start prompt", () => {
    registerSkill(makeSkill({ id: "review", name: "Review", template: "Review {{target}}." }));
    const frozen = freezeLeaderSystemPrompt({
      skillIds: ["review"],
      skillValues: { review: { target: "API" } },
      systemPromptPrefix: "Initial prefix",
    });

    registerSkill(makeSkill({ id: "docs", name: "Docs", template: "Write docs." }));
    const followUp = buildFrozenLeaderFollowUpPrompt({
      frozen,
      current: {
        skillIds: ["docs"],
        skillValues: {},
        systemPromptPrefix: "Edited prefix",
      },
      prompt: "Continue.",
    });

    expect(followUp.systemPrompt).toBe(frozen.systemPrompt);
    expect(followUp.systemPrompt).toContain("Initial prefix");
    expect(followUp.systemPrompt).not.toContain("Edited prefix");
  });

  it("delivers mid-session skill changes as user-turn reminder context", () => {
    registerSkill(makeSkill({ id: "review", name: "Review", template: "Review {{target}}." }));
    const frozen = freezeLeaderSystemPrompt({
      skillIds: ["review"],
      skillValues: { review: { target: "API" } },
    });

    registerSkill(makeSkill({ id: "docs", name: "Docs", description: "Documentation", template: "Write docs." }));
    const followUp = buildFrozenLeaderFollowUpPrompt({
      frozen,
      current: {
        skillIds: ["review", "docs"],
        skillValues: { review: { target: "UI" } },
      },
      prompt: "Use the latest setup.",
    });

    expect(followUp.prompt).toContain("<system-reminder>");
    expect(followUp.prompt).toContain("Newly available skills for delegation");
    expect(followUp.prompt).toContain("`docs` (Docs: Documentation)");
    expect(followUp.prompt).toContain("# Active Skills");
    expect(followUp.prompt).toContain("Review UI.");
    expect(followUp.prompt).toContain("Write docs.");
    expect(followUp.prompt).toMatch(/\n\nUse the latest setup\.$/);
  });

  it("omits the reminder when skills are unchanged since session start", () => {
    registerSkill(makeSkill({ id: "review", name: "Review", template: "Review {{target}}." }));
    const frozen = freezeLeaderSystemPrompt({
      skillIds: ["review"],
      skillValues: { review: { target: "API" } },
    });

    expect(
      buildSkillDeltaReminder(frozen, {
        skillIds: ["review"],
        skillValues: { review: { target: "API" } },
      }),
    ).toBeNull();
  });
});
