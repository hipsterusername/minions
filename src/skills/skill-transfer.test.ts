import { describe, it, expect } from "vitest";
import {
  serializeSkills,
  parseSkillTransfer,
  coerceSkill,
  SKILL_TRANSFER_FORMAT,
  SKILL_TRANSFER_VERSION,
} from "./skill-transfer.ts";
import type { SkillTemplate } from "./types.ts";

const SKILL: SkillTemplate = {
  id: "lint",
  name: "Lint",
  description: "clean it up",
  category: "code",
  icon: "🧹",
  accentColor: "#abc",
  template: "Fix {{target}}",
  variables: [
    { name: "target", label: "Target", type: "text", required: true },
  ],
};

const NOW = "2026-07-07T00:00:00.000Z";

describe("serializeSkills", () => {
  it("wraps skills in the versioned transfer container", () => {
    const parsed = JSON.parse(serializeSkills([SKILL], NOW));
    expect(parsed.format).toBe(SKILL_TRANSFER_FORMAT);
    expect(parsed.version).toBe(SKILL_TRANSFER_VERSION);
    expect(parsed.exportedAt).toBe(NOW);
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.skills[0].id).toBe("lint");
  });

  it("strips the builtIn marker so exports are portable copies", () => {
    const parsed = JSON.parse(
      serializeSkills([{ ...SKILL, builtIn: true }], NOW),
    );
    expect(parsed.skills[0].builtIn).toBeUndefined();
  });
});

describe("parseSkillTransfer", () => {
  it("round-trips the wrapped format", () => {
    const { skills, skipped } = parseSkillTransfer(serializeSkills([SKILL], NOW));
    expect(skipped).toBe(0);
    expect(skills[0]).toMatchObject({ id: "lint", template: "Fix {{target}}" });
  });

  it("accepts the legacy bare-array format", () => {
    const { skills } = parseSkillTransfer(JSON.stringify([SKILL]));
    expect(skills).toHaveLength(1);
    expect(skills[0]!.id).toBe("lint");
  });

  it("skips malformed entries but keeps valid ones", () => {
    const bundle = JSON.stringify({
      format: SKILL_TRANSFER_FORMAT,
      version: 1,
      skills: [SKILL, { name: "no id or template" }, 42, null],
    });
    const { skills, skipped } = parseSkillTransfer(bundle);
    expect(skills).toHaveLength(1);
    expect(skipped).toBe(3);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseSkillTransfer("{not json")).toThrow(/valid JSON/);
  });

  it("throws when the shape is neither array nor bundle", () => {
    expect(() => parseSkillTransfer(JSON.stringify({ foo: 1 }))).toThrow(
      /Unrecognized/,
    );
  });
});

describe("coerceSkill", () => {
  it("defaults missing optional fields", () => {
    const skill = coerceSkill({ id: "x", name: "X", template: "body" });
    expect(skill).not.toBeNull();
    expect(skill!.category).toBe("general");
    expect(skill!.icon).toBe("⚡");
    expect(skill!.variables).toEqual([]);
  });

  it("falls back to 'general' for an unknown category", () => {
    const skill = coerceSkill({ id: "x", name: "X", template: "b", category: "bogus" });
    expect(skill!.category).toBe("general");
  });

  it("strips the builtIn flag on import", () => {
    const skill = coerceSkill({ id: "x", name: "X", template: "b", builtIn: true });
    expect((skill as unknown as Record<string, unknown>)["builtIn"]).toBeUndefined();
  });

  it("rejects entries missing id, name, or template", () => {
    expect(coerceSkill({ name: "X", template: "b" })).toBeNull();
    expect(coerceSkill({ id: "x", template: "b" })).toBeNull();
    expect(coerceSkill({ id: "x", name: "X" })).toBeNull();
    expect(coerceSkill("nope")).toBeNull();
  });

  it("sanitizes variables and drops invalid ones", () => {
    const skill = coerceSkill({
      id: "x",
      name: "X",
      template: "b",
      variables: [
        { name: "ok", type: "select", options: [{ value: "a", label: "A" }, { bad: 1 }] },
        { notName: true },
      ],
    });
    expect(skill!.variables).toHaveLength(1);
    expect(skill!.variables[0]!.name).toBe("ok");
    expect(skill!.variables[0]!.options).toEqual([{ value: "a", label: "A" }]);
  });

  it("preserves subskills with generated ids", () => {
    const skill = coerceSkill({
      id: "x",
      name: "X",
      template: "b",
      subskills: [{ name: "Deep Dive", body: "..." }, { nope: true }],
    });
    expect(skill!.subskills).toHaveLength(1);
    expect(skill!.subskills![0]!.id).toBe("deep-dive");
  });
});
