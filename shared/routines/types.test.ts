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
  routineRunSnapshotSchema,
  routineSchema,
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
        { name: "topic", type: "string", label: "Topic", required: true },
        {
          name: "depth",
          type: "number",
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

describe("routineSchema — rejects invalid shapes", () => {
  it("rejects a routine with no phases", () => {
    const result = routineSchema.safeParse({
      id: "x",
      name: "X",
      phases: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a phase with no steps", () => {
    const result = routineSchema.safeParse({
      id: "x",
      name: "X",
      phases: [{ id: "p", label: "P", steps: [] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an id with uppercase letters", () => {
    const result = routineSchema.safeParse({
      id: "BadId",
      name: "X",
      phases: [
        {
          id: "p",
          label: "P",
          steps: [{ id: "s", label: "S", routinePrompt: "x" }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty routinePrompt", () => {
    const result = routineSchema.safeParse({
      id: "x",
      name: "X",
      phases: [
        {
          id: "p",
          label: "P",
          steps: [{ id: "s", label: "S", routinePrompt: "" }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown failurePolicy", () => {
    const result = routineSchema.safeParse({
      id: "x",
      name: "X",
      failurePolicy: "continue-with-partial",
      phases: [
        {
          id: "p",
          label: "P",
          steps: [{ id: "s", label: "S", routinePrompt: "x" }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

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
        { name: "a", type: "string", label: "A" },
        { name: "a", type: "string", label: "A2" },
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

// ── Gap 1: Schema regression ─────────────────────────────────────────────────

describe("routineStepSchema — timeoutMs / retries defaults", () => {
  it("timeoutMs is undefined when omitted — the field is absent from JSON output", () => {
    const r = minimalRoutine();
    const step = r.phases[0]!.steps[0]!;
    expect(step.timeoutMs).toBeUndefined();
    // JSON.stringify omits undefined values, so the key must not appear.
    const json = JSON.stringify(step);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect("timeoutMs" in parsed).toBe(false);
  });

  it("retries defaults to 0 when omitted — fail-fast preserved, scheduler sees 0", () => {
    const r = minimalRoutine();
    const step = r.phases[0]!.steps[0]!;
    expect(step.retries).toBe(0);
  });

  it("an existing routine serialised without timeoutMs/retries round-trips cleanly", () => {
    // Simulate a stored routine file that was created before these fields existed.
    const legacyJson = JSON.stringify({
      id: "legacy",
      name: "Legacy routine",
      phases: [
        {
          id: "p1",
          label: "Phase 1",
          steps: [
            { id: "s1", label: "Step 1", routinePrompt: "Do the thing." },
          ],
        },
      ],
    });
    const result = routineSchema.safeParse(JSON.parse(legacyJson));
    expect(result.success).toBe(true);
    if (result.success) {
      const step = result.data.phases[0]!.steps[0]!;
      // New fields must not corrupt the schema: retries gets its default, timeoutMs stays absent.
      expect(step.retries).toBe(0);
      expect(step.timeoutMs).toBeUndefined();
    }
  });
});

// ── Gap 4: routineRunSnapshotSchema round-trip ───────────────────────────────

describe("routineRunSnapshotSchema — attempts + lastError round-trip", () => {
  it("attempts and lastError survive JSON.stringify → safeParse", () => {
    const rawSnapshot = {
      runId: "run-1",
      routineId: "my-routine",
      routineName: "My Routine",
      state: "error",
      inputs: {},
      phases: [
        {
          phaseId: "p1",
          label: "Phase 1",
          state: "error",
          steps: [
            {
              stepId: "s1",
              label: "Step 1",
              outcome: "error",
              summary: "step failed after retries",
              attempts: 3,
              lastError: "attempt-3-failed",
              sessionKey: "sess-abc",
            },
          ],
        },
      ],
      startedAt: "2026-04-26T00:00:00.000Z",
      endedAt: "2026-04-26T00:01:00.000Z",
      error: "step s1 failed",
    };

    const roundTripped = JSON.parse(JSON.stringify(rawSnapshot)) as unknown;
    const result = routineRunSnapshotSchema.safeParse(roundTripped);

    expect(result.success).toBe(true);
    if (result.success) {
      const step = result.data.phases[0]!.steps[0]!;
      expect(step.attempts).toBe(3);
      expect(step.lastError).toBe("attempt-3-failed");
      expect(step.sessionKey).toBe("sess-abc");
    }
  });

  it("attempts and lastError are optional — snapshot without them parses fine", () => {
    const rawSnapshot = {
      runId: "run-2",
      routineId: "my-routine",
      routineName: "My Routine",
      state: "success",
      inputs: {},
      phases: [
        {
          phaseId: "p1",
          label: "Phase 1",
          state: "success",
          steps: [{ stepId: "s1", label: "Step 1", outcome: "success", summary: "done" }],
        },
      ],
      startedAt: "2026-04-26T00:00:00.000Z",
    };

    const result = routineRunSnapshotSchema.safeParse(rawSnapshot);
    expect(result.success).toBe(true);
    if (result.success) {
      const step = result.data.phases[0]!.steps[0]!;
      expect(step.attempts).toBeUndefined();
      expect(step.lastError).toBeUndefined();
    }
  });
});
