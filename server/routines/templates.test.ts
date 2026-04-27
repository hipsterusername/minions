/**
 * Built-in template tests. Validates the shipped templates parse cleanly
 * and the seeder copies one to disk verbatim.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BUILT_IN_ROUTINES,
  RESEARCH_ANALYZE_REPORT,
  getBuiltInRoutine,
  seedBuiltInRoutine,
} from "./templates.ts";
import { findDuplicateIds, parseRoutine } from "../../shared/routines/types.ts";
import { loadRoutineById } from "../routine-store.ts";

describe("BUILT_IN_ROUTINES", () => {
  it("contains the research-analyze-report starter", () => {
    expect(BUILT_IN_ROUTINES.length).toBeGreaterThan(0);
    expect(getBuiltInRoutine("research-analyze-report")).toBeDefined();
  });

  it("every built-in routine round-trips through the schema", () => {
    for (const r of BUILT_IN_ROUTINES) {
      expect(() => parseRoutine(r)).not.toThrow();
    }
  });

  it("every built-in routine has unique phase + step + input ids", () => {
    for (const r of BUILT_IN_ROUTINES) {
      expect(findDuplicateIds(r)).toEqual([]);
    }
  });

  it("getBuiltInRoutine returns undefined for an unknown id", () => {
    expect(getBuiltInRoutine("ghost")).toBeUndefined();
  });
});

describe("RESEARCH_ANALYZE_REPORT", () => {
  it("declares three phases with the expected ids", () => {
    expect(RESEARCH_ANALYZE_REPORT.phases.map((p) => p.id)).toEqual([
      "source",
      "analyze",
      "report",
    ]);
  });

  it("first phase runs two parallel sourcing steps", () => {
    expect(RESEARCH_ANALYZE_REPORT.phases[0]!.steps).toHaveLength(2);
    expect(
      RESEARCH_ANALYZE_REPORT.phases[0]!.steps.map((s) => s.id).sort(),
    ).toEqual(["external", "internal"]);
  });

  it("phase 2 and 3 reference {{handoff.brief}} for context flow", () => {
    expect(RESEARCH_ANALYZE_REPORT.phases[1]!.steps[0]!.routinePrompt).toContain(
      "{{handoff.brief}}",
    );
    expect(RESEARCH_ANALYZE_REPORT.phases[2]!.steps[0]!.routinePrompt).toContain(
      "{{handoff.brief}}",
    );
  });
});

describe("seedBuiltInRoutine", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "routine-seed-"));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("writes the template to the project sidecar", () => {
    const seeded = seedBuiltInRoutine(projectDir, "research-analyze-report");
    expect(seeded.id).toBe("research-analyze-report");
    expect(seeded.updatedAt).toBeDefined();
    const loaded = loadRoutineById(projectDir, "research-analyze-report");
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("Research → Analyze → Report");
  });

  it("throws on unknown built-in id", () => {
    expect(() => seedBuiltInRoutine(projectDir, "ghost")).toThrow(
      /Unknown built-in routine/,
    );
  });
});
