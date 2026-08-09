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
    expect(frozen.systemPrompt).toContain("Initial prefix");
    expect(frozen.systemPrompt).toContain("Review API.");
    expect(frozen.systemPrompt).not.toContain("You are the Lead Developer");
    expect(frozen.preview).toContain("Initial prefix");
    expect(frozen.preview).toContain("Review API.");
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

  it("treats a sub-skill edit on a tagged skill as an active change and emits the map", () => {
    registerSkill(
      makeSkill({ id: "design", name: "Design", template: "Design base." }),
    );
    const frozen = freezeLeaderSystemPrompt({
      skillIds: ["design"],
      skillValues: {},
    });

    // Same id/template, but now the skill grows a sub-skill mid-session.
    registerSkill(
      makeSkill({
        id: "design",
        name: "Design",
        template: "Design base.",
        subskills: [
          {
            id: "layout",
            name: "Layout",
            description: "layout rules",
            body: "LAYOUT BODY",
          },
        ],
      }),
    );

    const reminder = buildSkillDeltaReminder(frozen, {
      skillIds: ["design"],
      skillValues: {},
    });
    expect(reminder).not.toBeNull();
    expect(reminder!).toContain("### Sub-skills of Design");
    expect(reminder!).toContain("- `layout` — **Layout**: layout rules.");
    expect(reminder!).toContain("load_subskill");
    // On-demand body stays out of the map.
    expect(reminder!).not.toContain("LAYOUT BODY");
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
