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
  getBuiltInRoutine,
  seedBuiltInRoutine,
} from "./templates.ts";
import { findDuplicateIds } from "../../shared/routines/types.ts";
import { loadRoutineById } from "../routine-store.ts";

describe("BUILT_IN_ROUTINES", () => {
  it("contains the research-analyze-report starter", () => {
    expect(BUILT_IN_ROUTINES.length).toBeGreaterThan(0);
    expect(getBuiltInRoutine("research-analyze-report")).toBeDefined();
  });

  // Note: a "every built-in routine round-trips through the schema" check
  // was removed per testing-strategy.md §5.4 — BUILT_IN_ROUTINES is typed
  // at construction; if a template stops parsing, TypeScript catches it
  // before vitest runs.

  it("every built-in routine has unique phase + step + input ids", () => {
    for (const r of BUILT_IN_ROUTINES) {
      expect(findDuplicateIds(r)).toEqual([]);
    }
  });

  it("getBuiltInRoutine returns undefined for an unknown id", () => {
    expect(getBuiltInRoutine("ghost")).toBeUndefined();
  });
});

// Note: a `describe("RESEARCH_ANALYZE_REPORT")` block was removed per
// testing-strategy.md §5.7 — every assertion pinned literal content of
// the template (phase ids, step counts, {{handoff.brief}} mentions). A
// template change in normal authoring should not require a test diff.

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
