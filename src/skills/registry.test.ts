/**
 * Tests for the skill registry's built-in-preset surfacing.
 *
 * Contract:
 *   - getAllSkills() is project-only (the persistence source) — built-ins
 *     must never leak into it, or they'd be written to skills.json.
 *   - getPickableSkills() adds built-in presets a project hasn't overridden.
 *   - getSkill() resolves built-ins as a fallback so tagged built-ins render.
 *   - A same-id project skill overrides (hides) the built-in.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillTemplate } from "./types.ts";
import {
  clearSkills,
  getAllSkills,
  getPickableSkills,
  getSkill,
  registerSkill,
} from "./registry.ts";
import { builtInSkillTemplates } from "./built-in-presets.ts";

const BUILTIN_ID = "skill-builder";

function projectSkill(id: string): SkillTemplate {
  return {
    id,
    name: `Project ${id}`,
    description: "a project skill",
    category: "general",
    icon: "P",
    accentColor: "#000",
    template: "PROJECT BODY",
    variables: [],
  };
}

describe("skill registry built-in surfacing", () => {
  beforeEach(() => clearSkills());
  afterEach(() => clearSkills());

  it("keeps getAllSkills() project-only (built-ins never persist)", () => {
    expect(getAllSkills()).toEqual([]);
    registerSkill(projectSkill("proj-1"));
    const ids = getAllSkills().map((s) => s.id);
    expect(ids).toEqual(["proj-1"]);
    expect(ids).not.toContain(BUILTIN_ID);
  });

  it("getPickableSkills() includes every built-in preset plus project skills", () => {
    registerSkill(projectSkill("proj-1"));
    const ids = getPickableSkills().map((s) => s.id);
    expect(ids).toContain("proj-1");
    for (const b of builtInSkillTemplates) expect(ids).toContain(b.id);
    // Built-ins carry the read-only flag.
    const builder = getPickableSkills().find((s) => s.id === BUILTIN_ID);
    expect(builder?.builtIn).toBe(true);
  });

  it("getSkill() resolves a built-in as a fallback", () => {
    expect(getSkill(BUILTIN_ID)?.name).toBe("Skill Builder");
    expect(getSkill(BUILTIN_ID)?.builtIn).toBe(true);
  });

  it("a same-id project skill overrides the built-in (no duplicate)", () => {
    registerSkill(projectSkill(BUILTIN_ID));
    const pickable = getPickableSkills().filter((s) => s.id === BUILTIN_ID);
    expect(pickable).toHaveLength(1);
    expect(pickable[0]!.template).toBe("PROJECT BODY");
    // getSkill prefers the project override.
    expect(getSkill(BUILTIN_ID)?.template).toBe("PROJECT BODY");
  });
});
