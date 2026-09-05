/**
 * Colocated tests for the client-side skill compile helpers, focused on the
 * sub-skill map folded into `compileSkills`.
 */

import { describe, expect, it } from "vitest";
import {
  buildSubskillMap,
  compileSkills,
  type SkillTemplate,
} from "./types.ts";

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
  it("returns empty string with no sub-skills", () => {
    expect(buildSubskillMap(makeSkill())).toBe("");
  });

  it("lists sub-skills and the load_subskill instruction", () => {
    const out = buildSubskillMap(
      makeSkill({
        id: "design",
        subskills: [
          {
            id: "layout",
            name: "Layout",
            description: "layout rules",
            body: "LAYOUT BODY",
            whenToUse: "arranging pages",
          },
        ],
      }),
    );
    expect(out).toContain("### Sub-skills of Parent");
    expect(out).toContain("- `layout` — **Layout**: layout rules.");
    expect(out).toContain("When to use: arranging pages");
    expect(out).toContain("load_subskill");
    expect(out).toContain('skillId: "design"');
    expect(out).not.toContain("LAYOUT BODY");
  });
});

describe("compileSkills with sub-skills", () => {
  it("folds the map into the skill section and keeps on-demand bodies out", () => {
    const out = compileSkills(
      [
        makeSkill({
          id: "map",
          name: "Mapper",
          subskills: [
            {
              id: "deep",
              name: "Deep",
              description: "deep dive",
              body: "DEEP BODY",
            },
          ],
        }),
      ],
      {},
    );
    expect(out).toContain("## Skill: Mapper");
    expect(out).toContain("### Sub-skills of Mapper");
    expect(out).not.toContain("DEEP BODY");
  });

  it("eager-inlines alwaysInclude bodies", () => {
    const out = compileSkills(
      [
        makeSkill({
          id: "map",
          name: "Mapper",
          subskills: [
            {
              id: "eager",
              name: "Eager",
              description: "always",
              body: "EAGER BODY",
              alwaysInclude: true,
            },
          ],
        }),
      ],
      {},
    );
    expect(out).toContain("#### Eager");
    expect(out).toContain("EAGER BODY");
  });

  it("includes skill and eager sub-skill attachments", () => {
    const attachment = {
      kind: "text" as const, filename: "guide.md", mediaType: "text/markdown",
      text: "Follow this guide.", truncated: false,
    };
    const out = compileSkills([makeSkill({
      attachments: [attachment],
      subskills: [{
        id: "eager", name: "Eager", description: "always", body: "BODY",
        alwaysInclude: true,
        attachments: [{ ...attachment, filename: "example.json", mediaType: "application/json", text: "{}" }],
      }],
    })], {});
    expect(out).toContain("### Attached context (load on demand)");
    expect(out).not.toContain("Follow this guide.");
    expect(out).toContain("### Attached context (load on demand)");
    expect(out).toContain("example.json");
    expect(out).toContain('"subskillId":"eager"');
  });
});
