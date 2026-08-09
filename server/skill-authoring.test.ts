import { describe, it, expect } from "vitest";
import {
  slugifySkillId,
  extractTemplateVariableNames,
  isRawSkill,
  buildSkillDraft,
  upsertSkillInArray,
  removeSkillFromArray,
  summarizeSkillLibrary,
} from "./skill-authoring.ts";
import type { SkillTemplate } from "./skills.ts";

const sampleSkill: SkillTemplate = {
  id: "lint-cleanup",
  name: "Lint Cleanup",
  description: "Fix lint",
  category: "code",
  icon: "LC",
  accentColor: "#000",
  template: "Do the thing.",
  variables: [],
};

describe("slugifySkillId", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifySkillId("My Cool Skill!")).toBe("my-cool-skill");
  });
  it("collapses runs and trims edges", () => {
    expect(slugifySkillId("  --Foo   Bar-- ")).toBe("foo-bar");
  });
  it("falls back to 'skill' for empty input", () => {
    expect(slugifySkillId("   ")).toBe("skill");
    expect(slugifySkillId("!!!")).toBe("skill");
  });
});

describe("extractTemplateVariableNames", () => {
  it("returns unique names in first-seen order", () => {
    expect(
      extractTemplateVariableNames("{{a}} then {{b}} then {{a}} again"),
    ).toEqual(["a", "b"]);
  });
  it("returns empty for no placeholders", () => {
    expect(extractTemplateVariableNames("no vars here")).toEqual([]);
  });
});

describe("isRawSkill", () => {
  it("accepts objects with id/name/template", () => {
    expect(isRawSkill(sampleSkill)).toBe(true);
  });
  it("rejects non-skills", () => {
    expect(isRawSkill(null)).toBe(false);
    expect(isRawSkill({ id: "x" })).toBe(false);
    expect(isRawSkill("nope")).toBe(false);
  });
});

describe("buildSkillDraft", () => {
  it("requires a name", () => {
    const r = buildSkillDraft({ template: "hi" });
    expect(r.ok).toBe(false);
  });
  it("requires a non-empty template", () => {
    expect(buildSkillDraft({ name: "X", template: "  " }).ok).toBe(false);
    expect(buildSkillDraft({ name: "X" }).ok).toBe(false);
  });
  it("derives an id from the name", () => {
    const r = buildSkillDraft({ name: "Doc Writer", template: "body" });
    expect(r.ok && r.skill.id).toBe("doc-writer");
  });
  it("auto-declares implicit template placeholders as text variables", () => {
    const r = buildSkillDraft({
      name: "T",
      template: "Use {{repo}} and {{scope}}.",
      variables: [{ name: "repo", label: "Repo", type: "text" }],
    });
    if (!r.ok) throw new Error("expected ok");
    const names = r.skill.variables.map((v) => v.name);
    expect(names).toContain("repo");
    expect(names).toContain("scope");
    // scope was implicit → defaulted to a text input
    expect(r.skill.variables.find((v) => v.name === "scope")).toMatchObject({
      type: "text",
    });
  });
  it("defaults category to general when unknown", () => {
    const r = buildSkillDraft({ name: "T", template: "b", category: "bogus" });
    expect(r.ok && r.skill.category).toBe("general");
  });
  it("normalizes subskills and generates ids", () => {
    const r = buildSkillDraft({
      name: "Parent",
      template: "b",
      subskills: [
        { name: "Sub One", description: "d", body: "x" },
        { name: "Sub One", description: "d", body: "y" },
      ],
    });
    if (!r.ok) throw new Error("expected ok");
    const ids = r.skill.subskills?.map((s) => s.id);
    expect(ids).toEqual(["sub-one", "sub-one-2"]);
  });
  it("inherits unspecified fields from base on update", () => {
    const r = buildSkillDraft({ description: "new desc" }, sampleSkill);
    if (!r.ok) throw new Error("expected ok");
    expect(r.skill.id).toBe("lint-cleanup");
    expect(r.skill.name).toBe("Lint Cleanup");
    expect(r.skill.description).toBe("new desc");
    expect(r.skill.template).toBe("Do the thing.");
  });
});

describe("upsertSkillInArray", () => {
  it("appends a new skill", () => {
    const { next, created } = upsertSkillInArray([], sampleSkill);
    expect(created).toBe(true);
    expect(next).toHaveLength(1);
  });
  it("replaces an existing skill in place, preserving other entries", () => {
    const other = { id: "keep", name: "Keep", template: "t" };
    const updated = { ...sampleSkill, name: "Renamed" };
    const { next, created } = upsertSkillInArray(
      [sampleSkill, other],
      updated,
    );
    expect(created).toBe(false);
    expect(next[0]).toMatchObject({ name: "Renamed" });
    expect(next[1]).toBe(other);
  });
});

describe("removeSkillFromArray", () => {
  it("removes a matching skill", () => {
    const { next, removed } = removeSkillFromArray([sampleSkill], "lint-cleanup");
    expect(removed).toBe(true);
    expect(next).toHaveLength(0);
  });
  it("reports removed=false when id absent", () => {
    const { removed } = removeSkillFromArray([sampleSkill], "nope");
    expect(removed).toBe(false);
  });
});

describe("summarizeSkillLibrary", () => {
  it("includes built-ins and project skills, tagging source", () => {
    const summaries = summarizeSkillLibrary([sampleSkill]);
    const project = summaries.find((s) => s.id === "lint-cleanup");
    expect(project?.source).toBe("project");
    // At least one built-in preset should be present.
    expect(summaries.some((s) => s.source === "built-in")).toBe(true);
  });
  it("tags a project override of a built-in id as project", () => {
    const override: SkillTemplate = {
      ...sampleSkill,
      id: "skill-builder",
    };
    const summaries = summarizeSkillLibrary([override]);
    const match = summaries.filter((s) => s.id === "skill-builder");
    expect(match).toHaveLength(1);
    expect(match[0]?.source).toBe("project");
  });
});
