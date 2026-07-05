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

  // Note: an "ignores extraneous values" test was removed per §5.7 — the
  // single-placeholder case above already exercises that the substitution
  // is keyed on placeholder presence, not on input shape.
});

describe("compileSkills", () => {
  // Note: an "empty input" test was removed per §5.7.

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

  it("returns built-in skills when the sidecar has no skills.json", () => {
    expect(loadAllSkills(projectDir).map((skill) => skill.id)).toEqual([
      "system-model-authoring",
    ]);
    expect(loadSkillsByIds(projectDir, ["anything"])).toEqual([]);
  });

  it("loads all valid skills from disk", () => {
    writeSkills(projectDir, [
      makeSkill({ id: "lint", name: "Lint" }),
      makeSkill({ id: "test", name: "Test" }),
    ]);
    const all = loadAllSkills(projectDir);
    expect(all.map((s) => s.id)).toEqual([
      "system-model-authoring",
      "lint",
      "test",
    ]);
  });

  it("filters out malformed entries instead of throwing", () => {
    writeSkills(projectDir, [
      makeSkill({ id: "ok" }),
      { id: "broken" }, // missing name + template
      "not even an object",
    ]);
    const all = loadAllSkills(projectDir);
    expect(all.map((s) => s.id)).toEqual(["system-model-authoring", "ok"]);
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

  it("loads the built-in system model authoring skill by id", () => {
    const got = loadSkillsByIds(projectDir, ["system-model-authoring"]);
    expect(got).toHaveLength(1);
    expect(got[0]!.template).toContain(
      "Capabilities are user-facing powers, not modules.",
    );
    expect(got[0]!.template).toContain(
      "Create an object only if it will change agent behavior",
    );
  });

  it("lets project skills override a built-in skill id", () => {
    writeSkills(projectDir, [
      makeSkill({
        id: "system-model-authoring",
        name: "Custom System Model Authoring",
        template: "Custom instructions",
      }),
    ]);
    const got = loadSkillsByIds(projectDir, ["system-model-authoring"]);
    expect(got.map((s) => s.name)).toEqual(["Custom System Model Authoring"]);
    expect(got[0]!.template).toBe("Custom instructions");
  });

  // Note: an "empty ids" trivial was removed per §5.7.
});
