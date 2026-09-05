
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSubskillMap,
  formatSubskillLoad,
  resolveSubskillBody,
} from "./subskills.ts";
import type { SkillTemplate, SubSkill } from "./skills.ts";
import { writeSkills } from "./project-store.ts";

function makeSub(over: Partial<SubSkill> = {}): SubSkill {
  return {
    id: "alpha",
    name: "Alpha",
    description: "Does alpha things",
    body: "Alpha body content.",
    ...over,
  };
}

function makeSkill(over: Partial<SkillTemplate> = {}): SkillTemplate {
  return {
    id: "parent",
    name: "Parent",
    description: "A parent skill",
    category: "general",
    icon: "✨",
    accentColor: "#ffffff",
    template: "Parent body.",
    variables: [],
    ...over,
  };
}

describe("buildSubskillMap", () => {
  it("returns empty string when there are no sub-skills", () => {
    expect(buildSubskillMap(makeSkill())).toBe("");
    expect(buildSubskillMap(makeSkill({ subskills: [] }))).toBe("");
  });

  it("lists each sub-skill's id, name and description", () => {
    const out = buildSubskillMap(
      makeSkill({
        subskills: [
          makeSub({ id: "a", name: "Ay", description: "first" }),
          makeSub({ id: "b", name: "Bee", description: "second" }),
        ],
      }),
    );
    expect(out).toContain("### Sub-skills of Parent");
    expect(out).toContain("- `a` — **Ay**: first.");
    expect(out).toContain("- `b` — **Bee**: second.");
  });

  it("emits a load_subskill instruction carrying the parent skillId", () => {
    const out = buildSubskillMap(
      makeSkill({ id: "design", subskills: [makeSub()] }),
    );
    expect(out).toContain("load_subskill");
    expect(out).toContain('skillId: "design"');
  });

  it("appends the when-to-use hint when present", () => {
    const out = buildSubskillMap(
      makeSkill({ subskills: [makeSub({ whenToUse: "when building UI" })] }),
    );
    expect(out).toContain("When to use: when building UI");
  });

  it("eager-inlines an alwaysInclude body and marks it loaded", () => {
    const out = buildSubskillMap(
      makeSkill({
        subskills: [
          makeSub({
            id: "eager",
            name: "Eager",
            body: "EAGER BODY",
            alwaysInclude: true,
          }),
          makeSub({ id: "lazy", name: "Lazy", body: "LAZY BODY" }),
        ],
      }),
    );
    expect(out).toContain("- `eager` — **Eager**"); // listed
    expect(out).toContain("(loaded below)");
    expect(out).toContain("#### Eager");
    expect(out).toContain("EAGER BODY");
    // The lazy body must NOT be inlined.
    expect(out).not.toContain("LAZY BODY");
  });
});

describe("resolveSubskillBody", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "subskills-test-"));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("returns the body on valid skill + sub-skill ids", () => {
    writeSkills(projectDir, [
      makeSkill({
        id: "p",
        name: "Parent",
        subskills: [makeSub({ id: "s", name: "Sub", body: "THE BODY" })],
      }),
    ]);
    const res = resolveSubskillBody(projectDir, "p", "s");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.skillName).toBe("Parent");
      expect(res.subskill.body).toBe("THE BODY");
    }
  });

  it("reports unknown_skill with the valid skill ids", () => {
    writeSkills(projectDir, [makeSkill({ id: "real" })]);
    const res = resolveSubskillBody(projectDir, "ghost", "x");
    expect(res.ok).toBe(false);
    if (!res.ok && res.reason === "unknown_skill") {
      expect(res.validSkillIds).toContain("real");
    } else {
      throw new Error("expected unknown_skill");
    }
  });

  it("reports no_subskills when the skill has none", () => {
    writeSkills(projectDir, [makeSkill({ id: "flat", name: "Flat" })]);
    const res = resolveSubskillBody(projectDir, "flat", "x");
    expect(res.ok).toBe(false);
    if (!res.ok && res.reason === "no_subskills") {
      expect(res.skillName).toBe("Flat");
    } else {
      throw new Error("expected no_subskills");
    }
  });

  it("reports unknown_subskill with the valid sub-skill ids", () => {
    writeSkills(projectDir, [
      makeSkill({
        id: "p",
        subskills: [makeSub({ id: "known" })],
      }),
    ]);
    const res = resolveSubskillBody(projectDir, "p", "missing");
    expect(res.ok).toBe(false);
    if (!res.ok && res.reason === "unknown_subskill") {
      expect(res.validSubskillIds).toEqual(["known"]);
    } else {
      throw new Error("expected unknown_subskill");
    }
  });
});

describe("formatSubskillLoad", () => {
  it("frames the body with a heading on success", () => {
    const out = formatSubskillLoad("p", "s", {
      ok: true,
      skillName: "Parent",
      subskill: makeSub({ name: "Sub", body: "THE BODY" }),
    });
    expect(out).toBe("# Sub-skill: Parent › Sub\n\nTHE BODY");
  });

  it("returns a sub-skill's attached context with its body", () => {
    const out = formatSubskillLoad("p", "s", {
      ok: true,
      skillName: "Parent",
      subskill: makeSub({
        name: "Sub",
        body: "THE BODY",
        attachments: [{
          kind: "text", filename: "example.json", mediaType: "application/json",
          text: '{"safe":true}', truncated: false,
        }],
      }),
    });
    expect(out).toContain("### Attached context (load on demand)");
    expect(out).not.toContain('{"safe":true}');
    expect(out).toContain("example.json");
  });

  it("lists valid skill ids on unknown_skill", () => {
    const out = formatSubskillLoad("ghost", "x", {
      ok: false,
      reason: "unknown_skill",
      validSkillIds: ["a", "b"],
    });
    expect(out).toContain("ghost");
    expect(out).toContain("`a`");
    expect(out).toContain("`b`");
  });

  it("explains a flat skill on no_subskills", () => {
    const out = formatSubskillLoad("flat", "x", {
      ok: false,
      reason: "no_subskills",
      skillName: "Flat",
    });
    expect(out).toContain("no sub-skills");
  });

  it("lists valid sub-skill ids on unknown_subskill", () => {
    const out = formatSubskillLoad("p", "missing", {
      ok: false,
      reason: "unknown_subskill",
      skillName: "Parent",
      validSubskillIds: ["known"],
    });
    expect(out).toContain("missing");
    expect(out).toContain("`known`");
  });
});
