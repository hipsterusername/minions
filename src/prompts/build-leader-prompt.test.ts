/**
 * Tests for `buildLeaderSystemPrompt`.
 *
 * Pinning behaviour:
 *   - The base LEADER_SYSTEM_PROMPT is always included.
 *   - The legacy arming inventory lists skill IDs + names + descriptions.
 *   - Tagged skills (active for the leader itself) are compiled and
 *     appended via the existing Active Skills section.
 *   - Built-in skill presets (e.g. the Skill Builder) always appear in the
 *     arming inventory even when the project registry is empty, so the leader
 *     can discover and grant them by id.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildLeaderSystemPrompt,
  buildLeaderSystemPromptPreview,
} from "./build-leader-prompt.ts";
import { LEADER_SYSTEM_PROMPT } from "./leader-system.ts";
import {
  clearSkills,
  registerSkill,
} from "../skills/registry.ts";
import type { SkillTemplate } from "../skills/types.ts";

function makeSkill(over: Partial<SkillTemplate> = {}): SkillTemplate {
  return {
    id: "demo",
    name: "Demo",
    description: "A demo skill",
    category: "general",
    icon: "✨",
    accentColor: "#fff",
    template: "Do the thing.",
    variables: [],
    ...over,
  };
}

describe("buildLeaderSystemPrompt", () => {
  beforeEach(() => {
    clearSkills();
  });

  afterEach(() => {
    clearSkills();
  });

  it("surfaces built-in presets in the legacy inventory even when the registry is empty", () => {
    const out = buildLeaderSystemPromptPreview({
      skillIds: [], skillValues: {}, orchestrationMode: "direct",
    });
    // Stable core is present, plus the always-available built-in inventory.
    expect(out).toContain("You are the Lead Developer agent");
    expect(out).toContain("## Legacy planning mode (debug)");
    expect(out).toContain("# Available Skills (for arming Minions)");
    expect(out).toContain("`skill-builder`");
    // Nothing tagged → no active section.
    expect(out).not.toContain("# Active Skills");
  });

  it("appends the legacy arming inventory when the registry has skills", () => {
    registerSkill(makeSkill({ id: "a", name: "Alpha", description: "First" }));
    registerSkill(makeSkill({ id: "b", name: "Beta", description: "Second" }));

    const out = buildLeaderSystemPromptPreview({
      skillIds: [], skillValues: {}, orchestrationMode: "direct",
    });
    expect(out).toContain("## Legacy planning mode (debug)");
    expect(out).toContain("# Available Skills (for arming Minions)");
    expect(out).toContain("`a` — **Alpha**: First");
    expect(out).toContain("`b` — **Beta**: Second");
    // No active section when nothing is tagged
    expect(out).not.toContain("# Active Skills");
  });

  it("appends both Active and Available sections when tags are present", () => {
    registerSkill(
      makeSkill({
        id: "lint",
        name: "Lint",
        description: "Cleanup",
        template: "Lint hard.",
        attachments: [{
          kind: "text", filename: "lint-policy.md", mediaType: "text/markdown",
          text: "Warnings block release.", truncated: false,
        }],
      }),
    );
    registerSkill(makeSkill({ id: "review", name: "Review", description: "Read code" }));

    const out = buildLeaderSystemPromptPreview({
      skillIds: ["lint"],
      skillValues: {},
      orchestrationMode: "direct",
    });
    expect(out).toContain("# Active Skills");
    expect(out).toContain("## Skill: Lint");
    expect(out).toContain("Lint hard.");
    expect(out).toContain("Warnings block release.");
    expect(out).toContain("# Available Skills (for arming Minions)");
    // Both armed and unarmed skills appear in the inventory
    expect(out).toContain("`lint` — **Lint**: Cleanup");
    expect(out).toContain("`review` — **Review**: Read code");
  });

  it("uses Task Graph by default while preserving the direct arming inventory", () => {
    registerSkill(makeSkill({ id: "review", name: "Review", description: "Read code" }));
    const out = buildLeaderSystemPromptPreview({ skillIds: [], skillValues: {} });

    expect(out).toContain(LEADER_SYSTEM_PROMPT);
    expect(out).toContain("## Task Graph planning");
    expect(out).toContain("submit_graph_plan");
    expect(out).toContain("# Available Skills (for arming Minions)");
    expect(out).toContain("`review` — **Review**: Read code");
    expect(out).not.toContain("## Legacy planning mode (debug)");
  });

  it("injects a tagged skill's sub-skill map into the Active Skills section", () => {
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
          {
            id: "color",
            name: "Color",
            description: "palette rules",
            body: "COLOR BODY",
            alwaysInclude: true,
          },
        ],
      }),
    );

    const out = buildLeaderSystemPromptPreview({ skillIds: ["design"], skillValues: {} });
    expect(out).toContain("### Sub-skills of Design");
    expect(out).toContain("- `layout` — **Layout**: layout rules.");
    expect(out).toContain("load_subskill");
    // Eager body inlined; on-demand body withheld.
    expect(out).toContain("COLOR BODY");
    expect(out).not.toContain("LAYOUT BODY");
  });

});

describe("buildLeaderSystemPrompt wire customization", () => {
  it("returns only the trimmed user prefix instead of a client-assembled prompt", () => {
    expect(buildLeaderSystemPrompt({
      skillIds: ["review"],
      skillValues: {},
      systemPromptPrefix: "  Focus on accessibility.  ",
    })).toContain("Focus on accessibility.");
    expect(buildLeaderSystemPrompt({
      skillIds: ["review"],
      skillValues: {},
      systemPromptPrefix: "Focus on accessibility.",
    })).not.toContain("You are the Lead Developer");
  });

  it("returns an empty customization when no prefix is configured", () => {
    const wire = buildLeaderSystemPrompt({ skillIds: [], skillValues: {} });
    expect(wire).toContain('"promptPrefix":""');
    expect(wire).not.toContain("You are the Lead Developer");
  });
});
