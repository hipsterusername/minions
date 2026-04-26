/**
 * Tests for the server-side skill loader and compiler.
 *
 * These mirror the behaviour of `src/skills/types.ts` (whose pure
 * helpers we re-implement on the server) plus the project-store
 * disk loader integration.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compileSkillTemplate,
  compileSkills,
  loadAllSkills,
  loadSkillsByIds,
  type SkillTemplate,
} from "./skills.ts";
import { writeSkills } from "./project-store.ts";

function makeSkill(over: Partial<SkillTemplate> = {}): SkillTemplate {
  return {
    id: "demo",
    name: "Demo",
    description: "A demo skill",
    category: "general",
    icon: "✨",
    accentColor: "#ffffff",
    template: "Hello {{name}}.",
    variables: [],
    ...over,
  };
}

describe("compileSkillTemplate", () => {
  it("substitutes a single placeholder", () => {
    const out = compileSkillTemplate(makeSkill(), { name: "World" });
    expect(out).toBe("Hello World.");
  });

  it("treats missing variables as empty strings", () => {
    const out = compileSkillTemplate(
      makeSkill({ template: "Hi {{name}}, you are {{role}}." }),
      { name: "Ada" },
    );
    expect(out).toBe("Hi Ada, you are .");
  });

  it("collapses runs of blank lines from omitted optionals", () => {
    const skill = makeSkill({
      template: "Header\n\n{{a}}\n\n{{b}}\n\nFooter",
    });
    const out = compileSkillTemplate(skill, {});
    expect(out).toBe("Header\n\nFooter");
  });

  it("ignores extraneous values not referenced by the template", () => {
    const out = compileSkillTemplate(makeSkill(), {
      name: "x",
      unrelated: "y",
    });
    expect(out).toBe("Hello x.");
  });
});

describe("compileSkills", () => {
  it("returns empty string when no skills are passed", () => {
    expect(compileSkills([], {})).toBe("");
  });

  it("wraps each skill in an Active Skills section header", () => {
    const out = compileSkills(
      [makeSkill({ id: "a", name: "Alpha" })],
      { a: { name: "World" } },
    );
    expect(out).toContain("# Active Skills");
    expect(out).toContain("## Skill: Alpha");
    expect(out).toContain("Hello World.");
  });

  it("joins multiple skills with a horizontal rule", () => {
    const out = compileSkills(
      [
        makeSkill({ id: "a", name: "Alpha", template: "First" }),
        makeSkill({ id: "b", name: "Beta", template: "Second" }),
      ],
      {},
    );
    expect(out).toContain("First\n\n---\n\n## Skill: Beta");
  });
});

describe("loadAllSkills + loadSkillsByIds", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-test-"));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("returns [] when the sidecar has no skills.json", () => {
    expect(loadAllSkills(projectDir)).toEqual([]);
    expect(loadSkillsByIds(projectDir, ["anything"])).toEqual([]);
  });

  it("loads all valid skills from disk", () => {
    writeSkills(projectDir, [
      makeSkill({ id: "lint", name: "Lint" }),
      makeSkill({ id: "test", name: "Test" }),
    ]);
    const all = loadAllSkills(projectDir);
    expect(all.map((s) => s.id)).toEqual(["lint", "test"]);
  });

  it("filters out malformed entries instead of throwing", () => {
    writeSkills(projectDir, [
      makeSkill({ id: "ok" }),
      { id: "broken" }, // missing name + template
      "not even an object",
    ]);
    const all = loadAllSkills(projectDir);
    expect(all.map((s) => s.id)).toEqual(["ok"]);
  });

  it("loads skills by id in the order requested", () => {
    writeSkills(projectDir, [
      makeSkill({ id: "a", name: "Alpha" }),
      makeSkill({ id: "b", name: "Beta" }),
      makeSkill({ id: "c", name: "Gamma" }),
    ]);
    const got = loadSkillsByIds(projectDir, ["c", "a"]);
    expect(got.map((s) => s.id)).toEqual(["c", "a"]);
  });

  it("silently skips unknown ids", () => {
    writeSkills(projectDir, [makeSkill({ id: "real" })]);
    const got = loadSkillsByIds(projectDir, ["real", "ghost"]);
    expect(got.map((s) => s.id)).toEqual(["real"]);
  });

  it("returns [] when ids array is empty without reading disk", () => {
    expect(loadSkillsByIds(projectDir, [])).toEqual([]);
  });
});
