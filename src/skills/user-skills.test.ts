/**
 * Tests for importUserSkills — focused on preserving the `subskills` field
 * through the JSON round-trip (importUserSkills spreads the whole object into
 * the registry, so nested sub-skills must survive).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the server API boundary so import/persist stays in-memory.
vi.mock("../api.ts", () => ({
  getProjectSkills: vi.fn(async () => []),
  saveProjectSkills: vi.fn(async () => {}),
}));

import { importUserSkills, loadProjectSkills, setSkillsProjectId } from "./user-skills.ts";
import { clearSkills, getAllSkills, getSkill } from "./registry.ts";

describe("importUserSkills", () => {
  beforeEach(() => {
    clearSkills();
    setSkillsProjectId("proj-1");
  });

  afterEach(() => {
    clearSkills();
    setSkillsProjectId(null);
  });

  it("preserves a skill's subskills through import", async () => {
    const json = JSON.stringify([
      {
        id: "design",
        name: "Design",
        description: "Design system",
        category: "design",
        icon: "🎨",
        accentColor: "#000",
        template: "Base.",
        variables: [],
        subskills: [
          {
            id: "layout",
            name: "Layout",
            description: "layout rules",
            body: "LAYOUT BODY",
            whenToUse: "arranging pages",
            alwaysInclude: true,
          },
        ],
      },
    ]);

    const count = await importUserSkills(json);
    expect(count).toBe(1);

    const imported = getSkill("design");
    expect(imported?.subskills).toEqual([
      {
        id: "layout",
        name: "Layout",
        description: "layout rules",
        body: "LAYOUT BODY",
        whenToUse: "arranging pages",
        alwaysInclude: true,
      },
    ]);
  });
});

describe("loadProjectSkills", () => {
  beforeEach(() => clearSkills());
  afterEach(() => clearSkills());

  it("returns built-in presets even when the project library is empty", async () => {
    // The mocked getProjectSkills resolves []; built-ins must still surface to
    // the picker (the mobile LaunchScreen renders this return value directly).
    const pickable = await loadProjectSkills("proj-1");
    expect(pickable.map((s) => s.id)).toContain("skill-builder");
    // ...but the registry (persistence source) stays project-only/empty.
    expect(getAllSkills()).toEqual([]);
  });
});
