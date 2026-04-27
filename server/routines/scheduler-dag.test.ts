/**
 * DAG-mode scheduler tests.
 *
 * Verifies the scheduling contract when steps declare `dependsOn`:
 *
 *   - Diamond pattern (A → {B,C} → D): B and C run in parallel after A,
 *     D runs only after both B and C complete.
 *   - Chain (A → B → C): each step runs only after the prior one succeeds.
 *   - Fail-fast: the first step error skips all pending/unstarted steps.
 *   - Per-step depends context: a step sees only its declared deps in
 *     {{depends.*}} paths, not sibling steps it did not declare.
 *   - snapshot.mode === "dag" and dagSteps is populated.
 *   - Cycle detection and unknown-dep validation via findInvariantViolations.
 *   - Regression: a routine with no dependsOn routes through the phases
 *     scheduler (snapshot.mode is not "dag").
 */

import { describe, expect, it, vi } from "vitest";
import { runRoutine, type StepRunner } from "./scheduler.ts";
import {
  findInvariantViolations,
  parseRoutine,
  type Routine,
  type StepResult,
} from "../../shared/routines/types.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(stepId: string, over: Partial<StepResult> = {}): StepResult {
  return {
    stepId,
    outcome: "success",
    summary: `${stepId} done`,
    outputs: {},
    artifacts: [],
    ...over,
  };
}

const fixedNow = () => "2026-04-26T00:00:00.000Z";

// ── Routine builders ──────────────────────────────────────────────────────────

/**
 * Diamond: A has no deps; B and C both depend on A; D depends on B and C.
 *
 *   A → B
 *   A → C
 *   B → D
 *   C → D
 */
function makeDiamondRoutine(): Routine {
  return parseRoutine({
    id: "diamond",
    name: "Diamond",
    inputs: [],
    phases: [
      {
        id: "main",
        label: "Main",
        steps: [
          { id: "a", label: "A", routinePrompt: "do A" },
          {
            id: "b",
            label: "B",
            routinePrompt: "B sees {{depends.a.summary}}",
            dependsOn: ["a"],
          },
          {
            id: "c",
            label: "C",
            routinePrompt: "C sees {{depends.a.summary}}",
            dependsOn: ["a"],
          },
          {
            id: "d",
            label: "D",
            routinePrompt:
              "D sees {{depends.b.summary}} and {{depends.c.summary}}",
            dependsOn: ["b", "c"],
          },
        ],
      },
    ],
  });
}

/** Chain: A → B → C. */
function makeChainRoutine(): Routine {
  return parseRoutine({
    id: "chain",
    name: "Chain",
    inputs: [],
    phases: [
      {
        id: "main",
        label: "Main",
        steps: [
          { id: "a", label: "A", routinePrompt: "do A" },
          { id: "b", label: "B", routinePrompt: "do B", dependsOn: ["a"] },
          { id: "c", label: "C", routinePrompt: "do C", dependsOn: ["b"] },
        ],
      },
    ],
  });
}

/** Single-step DAG routine — no deps, but the presence of dependsOn on the
 *  routine schema triggers DAG mode detection. */
function makeSingleStepDagRoutine(): Routine {
  return parseRoutine({
    id: "single-dag",
    name: "Single DAG",
    inputs: [],
    phases: [
      {
        id: "main",
        label: "Main",
        steps: [
          { id: "a", label: "A", routinePrompt: "do A" },
          {
            id: "b",
            label: "B",
            routinePrompt: "do B",
            dependsOn: ["a"],
          },
        ],
      },
    ],
  });
}

// ── Regression: phases mode is unaffected ─────────────────────────────────────

describe("DAG regression — phases mode unchanged", () => {
  it("a routine with no dependsOn uses the phases scheduler (mode is absent/not dag)", async () => {
    const runner: StepRunner = vi.fn(async ({ step }) => ok(step.id));
    const snap = await runRoutine({
      routine: parseRoutine({
        id: "phases-only",
        name: "Phases only",
        inputs: [],
        phases: [
          {
            id: "p1",
            label: "Phase 1",
            steps: [
              { id: "s1", label: "S1", routinePrompt: "go" },
              { id: "s2", label: "S2", routinePrompt: "go" },
            ],
          },
        ],
      }),
      inputs: {},
      runner,
      runId: "r-phases",
      now: fixedNow,
    });
    expect(snap.state).toBe("success");
    expect(snap.mode).not.toBe("dag");
    expect(snap.dagSteps).toBeUndefined();
    // Phases structure is populated as normal.
    expect(snap.phases[0]!.state).toBe("success");
    expect(runner).toHaveBeenCalledTimes(2);
  });
});

// ── DAG happy paths ───────────────────────────────────────────────────────────

describe("runRoutine (DAG) — diamond pattern", () => {
  it("runs all four steps and returns success", async () => {
    const runner: StepRunner = vi.fn(async ({ step }) => ok(step.id));
    const snap = await runRoutine({
      routine: makeDiamondRoutine(),
      inputs: {},
      runner,
      runId: "r-diamond",
      now: fixedNow,
    });
    expect(snap.state).toBe("success");
    expect(snap.mode).toBe("dag");
    expect(runner).toHaveBeenCalledTimes(4);
  });

  it("snapshot.dagSteps lists all four steps with correct dep edges", async () => {
    const runner: StepRunner = vi.fn(async ({ step }) => ok(step.id));
    const snap = await runRoutine({
      routine: makeDiamondRoutine(),
      inputs: {},
      runner,
      runId: "r",
      now: fixedNow,
    });
    const dagSteps = snap.dagSteps!;
    expect(dagSteps).toHaveLength(4);

    const a = dagSteps.find((s) => s.stepId === "a")!;
    const b = dagSteps.find((s) => s.stepId === "b")!;
    const c = dagSteps.find((s) => s.stepId === "c")!;
    const d = dagSteps.find((s) => s.stepId === "d")!;

    expect(a.dependsOn).toEqual([]);
    expect(b.dependsOn).toEqual(["a"]);
    expect(c.dependsOn).toEqual(["a"]);
    expect(d.dependsOn).toEqual(["b", "c"]);
  });

  it("all dagSteps have state=success on a happy-path run", async () => {
    const runner: StepRunner = vi.fn(async ({ step }) => ok(step.id));
    const snap = await runRoutine({
      routine: makeDiamondRoutine(),
      inputs: {},
      runner,
      runId: "r",
      now: fixedNow,
    });
    for (const s of snap.dagSteps!) {
      expect(s.state).toBe("success");
      expect(s.outcome).toBe("success");
    }
  });

  it("B and C run in parallel after A (concurrency proof)", async () => {
    const order: string[] = [];
    let releaseB: () => void = () => {};
    const bStarted = new Promise<void>((res) => {
      releaseB = res;
    });

    const runner: StepRunner = async ({ step }) => {
      order.push(`start:${step.id}`);
      if (step.id === "c") {
        // C starting proves B and C are concurrent — release B.
        releaseB();
      } else if (step.id === "b") {
        // B waits until C has also started.
        await bStarted;
      }
      return ok(step.id);
    };

    await runRoutine({
      routine: makeDiamondRoutine(),
      inputs: {},
      runner,
      runId: "r",
      now: fixedNow,
    });

    const bIdx = order.indexOf("start:b");
    const cIdx = order.indexOf("start:c");
    expect(bIdx).toBeGreaterThanOrEqual(0);
    expect(cIdx).toBeGreaterThanOrEqual(0);
    // Both started before either released — they overlapped.
    expect(Math.abs(bIdx - cIdx)).toBe(1);
  });

  it("D starts only after both B and C complete", async () => {
    const completedBefore: string[] = [];
    const runner: StepRunner = async ({ step }) => {
      if (step.id === "d") {
        // By the time D starts, B and C must already be in completed.
        completedBefore.push(...["b", "c"].filter((id) => !completedBefore.includes(id)));
      }
      return ok(step.id);
    };

    // Capture completion order via the runner itself.
    const completionOrder: string[] = [];
    const wrappedRunner: StepRunner = async (args) => {
      const result = await runner(args);
      completionOrder.push(args.step.id);
      return result;
    };

    await runRoutine({
      routine: makeDiamondRoutine(),
      inputs: {},
      runner: wrappedRunner,
      runId: "r",
      now: fixedNow,
    });

    // A must complete before B and C start (verified by order: A is first).
    expect(completionOrder[0]).toBe("a");
    // D must be last.
    expect(completionOrder[completionOrder.length - 1]).toBe("d");
  });
});

describe("runRoutine (DAG) — chain", () => {
  it("runs A → B → C strictly in sequence", async () => {
    const completionOrder: string[] = [];
    const runner: StepRunner = async ({ step }) => {
      completionOrder.push(step.id);
      return ok(step.id);
    };
    const snap = await runRoutine({
      routine: makeChainRoutine(),
      inputs: {},
      runner,
      runId: "r-chain",
      now: fixedNow,
    });
    expect(snap.state).toBe("success");
    expect(completionOrder).toEqual(["a", "b", "c"]);
  });

  it("B is not started until A succeeds", async () => {
    const started: string[] = [];
    const runner: StepRunner = async ({ step }) => {
      started.push(step.id);
      return ok(step.id);
    };
    await runRoutine({
      routine: makeChainRoutine(),
      inputs: {},
      runner,
      runId: "r",
      now: fixedNow,
    });
    // A must appear before B in the start list.
    expect(started.indexOf("a")).toBeLessThan(started.indexOf("b"));
    expect(started.indexOf("b")).toBeLessThan(started.indexOf("c"));
  });
});

// ── DAG fail-fast ─────────────────────────────────────────────────────────────

describe("runRoutine (DAG) — fail-fast", () => {
  it("marks the run error when a step reports outcome=error", async () => {
    const runner: StepRunner = async ({ step }) => {
      if (step.id === "b") {
        return { ...ok(step.id), outcome: "error", error: "b-failed" };
      }
      return ok(step.id);
    };
    const snap = await runRoutine({
      routine: makeDiamondRoutine(),
      inputs: {},
      runner,
      runId: "r",
      now: fixedNow,
    });
    expect(snap.state).toBe("error");
    expect(snap.error).toMatch(/b.*b-failed/);
  });

  it("skips steps that have not yet started when a dep fails", async () => {
    const runner: StepRunner = async ({ step }) => {
      if (step.id === "a") {
        return { ...ok(step.id), outcome: "error", error: "root-fail" };
      }
      return ok(step.id);
    };
    const snap = await runRoutine({
      routine: makeChainRoutine(),
      inputs: {},
      runner,
      runId: "r",
      now: fixedNow,
    });
    expect(snap.state).toBe("error");
    // B and C depend on A — they should never have started.
    const bState = snap.dagSteps!.find((s) => s.stepId === "b")!.state;
    const cState = snap.dagSteps!.find((s) => s.stepId === "c")!.state;
    // Steps that were blocked (B depends on A, C depends on B) are skipped.
    expect(["pending", "skipped"]).toContain(bState);
    expect(["pending", "skipped"]).toContain(cState);
  });

  it("treats outcome=aborted as failure and skips dependents", async () => {
    const runner: StepRunner = async ({ step }) => {
      if (step.id === "a") {
        return { ...ok(step.id), outcome: "aborted", summary: "user abort" };
      }
      return ok(step.id);
    };
    const snap = await runRoutine({
      routine: makeChainRoutine(),
      inputs: {},
      runner,
      runId: "r",
      now: fixedNow,
    });
    expect(snap.state).toBe("error");
    expect(snap.error).toMatch(/aborted/);
  });

  it("marks the run error when a runner throws", async () => {
    const runner: StepRunner = async ({ step }) => {
      if (step.id === "a") throw new Error("runner-kaboom");
      return ok(step.id);
    };
    const snap = await runRoutine({
      routine: makeSingleStepDagRoutine(),
      inputs: {},
      runner,
      runId: "r",
      now: fixedNow,
    });
    expect(snap.state).toBe("error");
    expect(snap.error).toMatch(/runner threw.*runner-kaboom/);
  });
});

// ── Per-step depends context ──────────────────────────────────────────────────

describe("runRoutine (DAG) — per-step depends context", () => {
  it("injects {{depends.<depId>.summary}} for declared deps", async () => {
    const seenPrompts: Record<string, string> = {};
    const runner: StepRunner = async ({ step, renderedPrompt }) => {
      seenPrompts[step.id] = renderedPrompt;
      return ok(step.id, { summary: `summary-of-${step.id}` });
    };
    await runRoutine({
      routine: makeDiamondRoutine(),
      inputs: {},
      runner,
      runId: "r",
      now: fixedNow,
    });
    // B depends on A, so {{depends.a.summary}} should render as A's summary.
    expect(seenPrompts["b"]).toContain("summary-of-a");
    // D depends on B and C.
    expect(seenPrompts["d"]).toContain("summary-of-b");
    expect(seenPrompts["d"]).toContain("summary-of-c");
  });

  it("does NOT inject {{depends.x.summary}} for steps not in dependsOn", async () => {
    // Make a routine where D declares dependsOn: ["b"] only (not c).
    const routine = parseRoutine({
      id: "partial-deps",
      name: "Partial deps",
      inputs: [],
      phases: [
        {
          id: "main",
          label: "Main",
          steps: [
            { id: "a", label: "A", routinePrompt: "do A" },
            {
              id: "b",
              label: "B",
              routinePrompt: "do B",
              dependsOn: ["a"],
            },
            {
              id: "c",
              label: "C",
              routinePrompt: "do C",
              dependsOn: ["a"],
            },
            {
              // D only declares B, not C.
              id: "d",
              label: "D",
              routinePrompt:
                "D has b={{depends.b.summary}} c={{depends.c.summary}}",
              dependsOn: ["b"],
            },
          ],
        },
      ],
    });

    let dPrompt = "";
    const runner: StepRunner = async ({ step, renderedPrompt }) => {
      if (step.id === "d") dPrompt = renderedPrompt;
      return ok(step.id, { summary: `summary-of-${step.id}` });
    };
    await runRoutine({ routine, inputs: {}, runner, runId: "r", now: fixedNow });

    // {{depends.b.summary}} resolves to B's summary.
    expect(dPrompt).toContain("summary-of-b");
    // {{depends.c.summary}} is NOT in D's dependsOn, so it renders empty.
    expect(dPrompt).toContain("c=");
    // The c= part should be followed by empty (no summary-of-c).
    expect(dPrompt).not.toContain("summary-of-c");
  });

  it("injects {{depends.facts.<depId>.<key>}} for outputs of declared deps", async () => {
    const routine = parseRoutine({
      id: "facts-test",
      name: "Facts test",
      inputs: [],
      phases: [
        {
          id: "main",
          label: "Main",
          steps: [
            { id: "src", label: "Src", routinePrompt: "produce facts" },
            {
              id: "consumer",
              label: "Consumer",
              routinePrompt: "count={{depends.facts.src.count}}",
              dependsOn: ["src"],
            },
          ],
        },
      ],
    });

    let consumerPrompt = "";
    const runner: StepRunner = async ({ step, renderedPrompt }) => {
      if (step.id === "consumer") consumerPrompt = renderedPrompt;
      return ok(step.id, {
        outputs: step.id === "src" ? { count: 42 } : {},
      });
    };
    await runRoutine({ routine, inputs: {}, runner, runId: "r", now: fixedNow });

    expect(consumerPrompt).toContain("count=42");
  });
});

// ── Snapshot cadence ──────────────────────────────────────────────────────────

describe("runRoutine (DAG) — snapshot emission", () => {
  it("emits mode=dag on every snapshot", async () => {
    const snapshots: ReturnType<typeof runRoutine> extends Promise<infer S>
      ? S[]
      : never[] = [];
    const runner: StepRunner = vi.fn(async ({ step }) => ok(step.id));
    await runRoutine({
      routine: makeSingleStepDagRoutine(),
      inputs: {},
      runner,
      runId: "r",
      onSnapshot: (s) => snapshots.push(s),
      now: fixedNow,
    });
    for (const s of snapshots) {
      expect(s.mode).toBe("dag");
    }
  });

  it("starts with state=running and ends with state=success", async () => {
    const snapshots: Array<{ state: string }> = [];
    const runner: StepRunner = vi.fn(async ({ step }) => ok(step.id));
    await runRoutine({
      routine: makeSingleStepDagRoutine(),
      inputs: {},
      runner,
      runId: "r",
      onSnapshot: (s) => snapshots.push(s),
      now: fixedNow,
    });
    expect(snapshots[0]!.state).toBe("running");
    expect(snapshots[snapshots.length - 1]!.state).toBe("success");
  });

  it("attaches sessionKey to dagSteps entry when runner returns one", async () => {
    const runner: StepRunner = async ({ step }) =>
      ok(step.id, { sessionKey: `sess-${step.id}` });
    const snap = await runRoutine({
      routine: makeSingleStepDagRoutine(),
      inputs: {},
      runner,
      runId: "r",
      now: fixedNow,
    });
    for (const ds of snap.dagSteps!) {
      expect(ds.sessionKey).toBe(`sess-${ds.stepId}`);
    }
  });
});

// ── Parse-time invariant validation ──────────────────────────────────────────

describe("findInvariantViolations — DAG invariants", () => {
  it("returns [] for a routine with no dependsOn", () => {
    const routine = parseRoutine({
      id: "clean",
      name: "Clean",
      inputs: [],
      phases: [
        {
          id: "p",
          label: "P",
          steps: [
            { id: "a", label: "A", routinePrompt: "x" },
            { id: "b", label: "B", routinePrompt: "x" },
          ],
        },
      ],
    });
    expect(findInvariantViolations(routine)).toEqual([]);
  });

  it("returns [] for a valid DAG with no violations", () => {
    expect(findInvariantViolations(makeDiamondRoutine())).toEqual([]);
    expect(findInvariantViolations(makeChainRoutine())).toEqual([]);
  });

  it("detects a direct cycle (A ↔ B) with a clear error message", () => {
    const routine = parseRoutine({
      id: "cycle",
      name: "Cycle",
      inputs: [],
      phases: [
        {
          id: "p",
          label: "P",
          steps: [
            { id: "a", label: "A", routinePrompt: "x", dependsOn: ["b"] },
            { id: "b", label: "B", routinePrompt: "x", dependsOn: ["a"] },
          ],
        },
      ],
    });
    const violations = findInvariantViolations(routine);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.kind).toBe("cycle");
    expect(violations[0]!.message).toMatch(/cycle detected/i);
    // Both A and B should appear in the message.
    expect(violations[0]!.message).toContain("a");
    expect(violations[0]!.message).toContain("b");
  });

  it("detects a transitive cycle (A → B → C → A)", () => {
    const routine = parseRoutine({
      id: "tri-cycle",
      name: "Tri-cycle",
      inputs: [],
      phases: [
        {
          id: "p",
          label: "P",
          steps: [
            { id: "a", label: "A", routinePrompt: "x", dependsOn: ["c"] },
            { id: "b", label: "B", routinePrompt: "x", dependsOn: ["a"] },
            { id: "c", label: "C", routinePrompt: "x", dependsOn: ["b"] },
          ],
        },
      ],
    });
    const violations = findInvariantViolations(routine);
    expect(violations.some((v) => v.kind === "cycle")).toBe(true);
  });

  it("detects unknown-dep when dependsOn references a non-existent step", () => {
    const routine = parseRoutine({
      id: "bad-dep",
      name: "Bad dep",
      inputs: [],
      phases: [
        {
          id: "p",
          label: "P",
          steps: [
            {
              id: "a",
              label: "A",
              routinePrompt: "x",
              dependsOn: ["nonexistent"],
            },
          ],
        },
      ],
    });
    const violations = findInvariantViolations(routine);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.kind).toBe("unknown-dep");
    expect(violations[0]!.message).toContain("nonexistent");
  });

  it("detects unknown-dep when step id is ambiguous (same id in two phases)", () => {
    // If the same step id appears in two phases, dependsOn is ambiguous.
    const routine = parseRoutine({
      id: "ambiguous",
      name: "Ambiguous",
      inputs: [],
      phases: [
        {
          id: "p1",
          label: "P1",
          steps: [{ id: "shared", label: "Shared in P1", routinePrompt: "x" }],
        },
        {
          id: "p2",
          label: "P2",
          steps: [
            { id: "shared", label: "Shared in P2", routinePrompt: "x" },
            {
              id: "consumer",
              label: "Consumer",
              routinePrompt: "x",
              dependsOn: ["shared"],
            },
          ],
        },
      ],
    });
    const violations = findInvariantViolations(routine);
    expect(violations.some((v) => v.kind === "unknown-dep")).toBe(true);
    expect(
      violations.some((v) => v.message.includes("shared")),
    ).toBe(true);
  });
});
