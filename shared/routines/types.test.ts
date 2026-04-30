/**
 * Routine schema parity tests.
 *
 * These exercise the zod schema for round-trip correctness, default
 * application, and the structural duplicate-id check that zod can't
 * express by itself.
 */

import { describe, expect, it } from "vitest";
import {
  findDuplicateIds,
  parseRoutine,
  safeParseRoutine,
  type Routine,
} from "./types.ts";

function minimalRoutine(): Routine {
  return parseRoutine({
    id: "demo",
    name: "Demo",
    phases: [
      {
        id: "p1",
        label: "Phase 1",
        steps: [
          {
            id: "s1",
            label: "Step 1",
            routinePrompt: "Do the thing.",
          },
        ],
      },
    ],
  });
}

describe("routineSchema — happy path", () => {
  it("parses a minimal routine and applies defaults", () => {
    const r = minimalRoutine();
    expect(r.id).toBe("demo");
    expect(r.version).toBe(1);
    expect(r.failurePolicy).toBe("fail-fast");
    expect(r.inputs).toEqual([]);
    expect(r.phases[0]!.steps[0]!.skillIds).toEqual([]);
    expect(r.phases[0]!.steps[0]!.skillValues).toEqual({});
    expect(r.phases[0]!.steps[0]!.mcpServerIds).toEqual([]);
    expect(r.phases[0]!.steps[0]!.agent).toBe("leader");
  });

  it("parses a routine with inputs and multiple phases", () => {
    const r = parseRoutine({
      id: "research-flow",
      name: "Research Flow",
      description: "Research, analyze, report",
      inputs: [
        { name: "topic", label: "Topic", required: true },
        {
          name: "depth",
          label: "Depth",
          required: false,
          defaultValue: 3,
        },
      ],
      phases: [
        {
          id: "research",
          label: "Research",
          steps: [
            {
              id: "web",
              label: "Web research",
              routinePrompt: "Research {{inputs.topic}}",
              skillIds: ["exa-search"],
            },
            {
              id: "repo",
              label: "Repo research",
              routinePrompt: "Find prior art for {{inputs.topic}}",
            },
          ],
        },
        {
          id: "report",
          label: "Report",
          steps: [
            {
              id: "write",
              label: "Write report",
              routinePrompt: "Write a report from {{handoff.brief}}",
            },
          ],
        },
      ],
    });
    expect(r.inputs).toHaveLength(2);
    expect(r.phases).toHaveLength(2);
    expect(r.phases[0]!.steps).toHaveLength(2);
  });
});

// Note: a "rejects invalid shapes" describe block was removed per
// testing-strategy.md §5.4 — every assertion re-asserted a zod rule
// (.min(1), .regex(...), .enum(...)) against a hand-built literal
// parsed through its own schema. The §2.2 rewrite ("one round-trip per
// failure-policy / step-type combination, exercising a real producer
// and the scheduler consumer") lands in Wave 2.

describe("safeParseRoutine", () => {
  it("returns ok=true and the parsed routine on success", () => {
    const result = safeParseRoutine({
      id: "ok",
      name: "Ok",
      phases: [
        {
          id: "p",
          label: "P",
          steps: [{ id: "s", label: "S", routinePrompt: "go" }],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.routine.id).toBe("ok");
  });

  it("returns ok=false with structured paths on failure", () => {
    const result = safeParseRoutine({ id: "Bad", name: "x", phases: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => e.path);
      expect(paths.some((p) => p === "id" || p === "phases")).toBe(true);
    }
  });
});

describe("findDuplicateIds", () => {
  it("returns [] for a routine with all unique ids", () => {
    expect(findDuplicateIds(minimalRoutine())).toEqual([]);
  });

  it("flags duplicate phase ids", () => {
    const r = parseRoutine({
      id: "x",
      name: "X",
      phases: [
        {
          id: "dup",
          label: "A",
          steps: [{ id: "s1", label: "s", routinePrompt: "x" }],
        },
        {
          id: "dup",
          label: "B",
          steps: [{ id: "s1", label: "s", routinePrompt: "x" }],
        },
      ],
    });
    expect(findDuplicateIds(r)).toContain("phase:dup");
  });

  it("flags duplicate step ids inside a phase", () => {
    const r = parseRoutine({
      id: "x",
      name: "X",
      phases: [
        {
          id: "p",
          label: "P",
          steps: [
            { id: "dup", label: "A", routinePrompt: "x" },
            { id: "dup", label: "B", routinePrompt: "x" },
          ],
        },
      ],
    });
    expect(findDuplicateIds(r)).toContain("step:p/dup");
  });

  it("flags duplicate input names", () => {
    const r = parseRoutine({
      id: "x",
      name: "X",
      inputs: [
        { name: "a", label: "A" },
        { name: "a", label: "A2" },
      ],
      phases: [
        {
          id: "p",
          label: "P",
          steps: [{ id: "s", label: "s", routinePrompt: "x" }],
        },
      ],
    });
    expect(findDuplicateIds(r)).toContain("input:a");
  });

  it("permits the same step id across different phases", () => {
    const r = parseRoutine({
      id: "x",
      name: "X",
      phases: [
        {
          id: "a",
          label: "A",
          steps: [{ id: "shared", label: "x", routinePrompt: "x" }],
        },
        {
          id: "b",
          label: "B",
          steps: [{ id: "shared", label: "y", routinePrompt: "y" }],
        },
      ],
    });
    expect(findDuplicateIds(r)).toEqual([]);
  });
});

// Note: the "routineStepSchema — timeoutMs / retries defaults" and
// "routineRunSnapshotSchema — attempts + lastError round-trip" describe
// blocks were removed per testing-strategy.md §5.4 — they re-asserted
// zod's `.default(0)` / `.optional()` rules against literals authored
// next to the schema. The §2.2 rewrite (real-producer round-trips)
// lands in Wave 2.
