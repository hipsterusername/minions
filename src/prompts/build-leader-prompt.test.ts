/**
 * Tests for `buildLeaderSystemPrompt`.
 *
 * Pinning behaviour:
 *   - The base LEADER_SYSTEM_PROMPT is always included.
 *   - The arming inventory section appears whenever the registry has
 *     any skills, listing their IDs + names + descriptions.
 *   - Tagged skills (active for the leader itself) are compiled and
 *     appended via the existing Active Skills section.
 *   - When the registry is empty, no Available Skills section appears.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLeaderSystemPrompt } from "./build-leader-prompt.ts";
import { LEADER_SYSTEM_PROMPT } from "./leader-system.ts";
import {
  clearSkills,
  registerSkill,
} from "../skills/registry.ts";
import { buildArmingInventory } from "../skills/types.ts";
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

  it("returns just the base prompt when registry and tags are empty", () => {
    const out = buildLeaderSystemPrompt({ skillIds: [], skillValues: {} });
    expect(out).toBe(LEADER_SYSTEM_PROMPT);
  });

  it("appends the arming inventory when the registry has skills", () => {
    registerSkill(makeSkill({ id: "a", name: "Alpha", description: "First" }));
    registerSkill(makeSkill({ id: "b", name: "Beta", description: "Second" }));

    const out = buildLeaderSystemPrompt({ skillIds: [], skillValues: {} });
    expect(out).toContain(LEADER_SYSTEM_PROMPT);
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
      }),
    );
    registerSkill(makeSkill({ id: "review", name: "Review", description: "Read code" }));

    const out = buildLeaderSystemPrompt({
      skillIds: ["lint"],
      skillValues: {},
    });
    expect(out).toContain("# Active Skills");
    expect(out).toContain("## Skill: Lint");
    expect(out).toContain("Lint hard.");
    expect(out).toContain("# Available Skills (for arming Minions)");
    // Both armed and unarmed skills appear in the inventory
    expect(out).toContain("`lint` — **Lint**: Cleanup");
    expect(out).toContain("`review` — **Review**: Read code");
  });

  it("renders empty descriptions as '(no description)'", () => {
    const text = buildArmingInventory([
      makeSkill({ id: "x", name: "Nameless", description: "" }),
    ]);
    expect(text).toContain("`x` — **Nameless**: (no description)");
  });
});
