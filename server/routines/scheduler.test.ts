/**
 * Phase scheduler tests.
 *
 * Use a fake step runner — no SDK loop, no network, no worktrees. Each
 * test wires the fake to demonstrate one piece of the contract:
 *   - parallelism within a phase
 *   - sequential progression between phases
 *   - handoff injection from phase N to phase N+1
 *   - fail-fast on step error / runner throw / aborted outcome
 *   - input validation
 *   - snapshot emission cadence
 */

import { describe, expect, it, vi } from "vitest";
import {
  runRoutine,
  validateInputs,
  type StepRunner,
} from "./scheduler.ts";
import {
  parseRoutine,
  type Routine,
  type RoutineRunSnapshot,
  type StepResult,
} from "../../shared/routines/types.ts";

function makeRoutine(): Routine {
  return parseRoutine({
    id: "two-phase",
    name: "Two phase",
    inputs: [{ name: "topic", label: "Topic" }],
    phases: [
      {
        id: "phase-a",
        label: "Phase A",
        steps: [
          {
            id: "a1",
            label: "A one",
            routinePrompt: "A1 with {{inputs.topic}}",
          },
          {
            id: "a2",
            label: "A two",
            routinePrompt: "A2 with {{inputs.topic}}",
          },
        ],
      },
      {
        id: "phase-b",
        label: "Phase B",
        steps: [
          {
            id: "b1",
            label: "B one",
            routinePrompt:
              "B1 reads {{handoff.brief}} and {{handoff.facts.a1.k}}",
          },
        ],
      },
    ],
  });
}

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

describe("validateInputs", () => {
  it("returns the validated bag when all required inputs present", () => {
    const out = validateInputs(
      [{ name: "x", label: "X", required: true }],
      { x: "hello" },
    );
    expect(out).toEqual({ x: "hello" });
  });

  it("applies string defaults for absent values", () => {
    const out = validateInputs(
      [
        {
          name: "depth",
          label: "D",
          required: false,
          defaultValue: "3",
        },
      ],
      {},
    );
    expect(out).toEqual({ depth: "3" });
  });

  it("throws listing every missing required input at once", () => {
    expect(() =>
      validateInputs(
        [
          { name: "a", label: "A", required: true },
          { name: "b", label: "B", required: true },
        ],
        {},
      ),
    ).toThrow(/missing required input "a".*missing required input "b"/);
  });

  it("coerces non-string supplied values to strings", () => {
    // Inputs are stringly-typed: a number or boolean from JSON survives by
    // being coerced, rather than bouncing the whole request.
    const out = validateInputs(
      [
        { name: "depth", label: "Depth", required: true },
        { name: "verbose", label: "Verbose", required: true },
      ],
      { depth: 3, verbose: true },
    );
    expect(out).toEqual({ depth: "3", verbose: "true" });
  });
});

describe("runRoutine — happy path", () => {
  it("runs phases in order and returns success", async () => {
    const runner: StepRunner = vi.fn(async ({ step }) => ok(step.id));
    const snap = await runRoutine({
      routine: makeRoutine(),
      inputs: { topic: "widgets" },
      runner,
      runId: "run-1",
      now: fixedNow,
    });
    expect(snap.state).toBe("success");
    expect(snap.phases.map((p) => p.state)).toEqual(["success", "success"]);
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it("renders {{inputs.x}} into the prompt the runner receives", async () => {
    const seen: string[] = [];
    const runner: StepRunner = async ({ step, renderedPrompt }) => {
      seen.push(renderedPrompt);
      return ok(step.id);
    };
    await runRoutine({
      routine: makeRoutine(),
      inputs: { topic: "widgets" },
      runner,
      runId: "r",
      now: fixedNow,
    });
    expect(seen).toContain("A1 with widgets");
    expect(seen).toContain("A2 with widgets");
  });

  it("injects the handoff from phase N into phase N+1 step prompts", async () => {
    const phaseBPrompts: string[] = [];
    const runner: StepRunner = async ({ step, phase, renderedPrompt }) => {
      if (phase.id === "phase-b") phaseBPrompts.push(renderedPrompt);
      if (step.id === "a1") return ok(step.id, { outputs: { k: "VALUE" } });
      return ok(step.id);
    };
    await runRoutine({
      routine: makeRoutine(),
      inputs: { topic: "x" },
      runner,
      runId: "r",
      now: fixedNow,
    });
    expect(phaseBPrompts).toHaveLength(1);
    const prompt = phaseBPrompts[0]!;
    // brief was injected
    expect(prompt).toContain("# Handoff from phase: Phase A");
    // namespaced fact was injected
    expect(prompt).toContain("VALUE");
  });

  it("runs steps within a phase in parallel (Promise.all)", async () => {
    const order: string[] = [];
    let releaseA1: () => void = () => {};
    const a1Started = new Promise<void>((res) => {
      releaseA1 = res;
    });

    const runner: StepRunner = async ({ step }) => {
      order.push(`start:${step.id}`);
      if (step.id === "a1") {
        // Block A1 until A2 has at least started.
        await a1Started;
      } else if (step.id === "a2") {
        // Releasing A1 once A2 reaches here proves they ran concurrently.
        releaseA1();
      }
      return ok(step.id);
    };
    await runRoutine({
      routine: makeRoutine(),
      inputs: { topic: "x" },
      runner,
      runId: "r",
      now: fixedNow,
    });
    // Both phase-A steps started before either completed → parallel.
    const a1Idx = order.indexOf("start:a1");
    const a2Idx = order.indexOf("start:a2");
    expect(a1Idx).toBeGreaterThanOrEqual(0);
    expect(a2Idx).toBeGreaterThanOrEqual(0);
    expect(Math.abs(a1Idx - a2Idx)).toBe(1);
  });

  it("emits a snapshot on every state transition", async () => {
    const snapshots: RoutineRunSnapshot[] = [];
    const runner: StepRunner = async ({ step }) => ok(step.id);
    await runRoutine({
      routine: makeRoutine(),
      inputs: { topic: "x" },
      runner,
      runId: "r",
      onSnapshot: (s) => snapshots.push(s),
      now: fixedNow,
    });
    // Cadence: run started, A started, A reduced, B started, B reduced, run ended.
    // We don't pin the exact count (the impl may emit slightly more), only
    // that we see the meaningful state transitions in order.
    const states = snapshots.map((s) => s.state);
    expect(states[0]).toBe("running");
    expect(states[states.length - 1]).toBe("success");
    const phaseAStates = snapshots.map((s) => s.phases[0]!.state);
    expect(phaseAStates).toContain("running");
    expect(phaseAStates).toContain("success");
  });

  it("attaches sessionKey on snapshot when the runner returns one", async () => {
    const runner: StepRunner = async ({ step }) =>
      ok(step.id, { sessionKey: `session-${step.id}` });
    const snap = await runRoutine({
      routine: makeRoutine(),
      inputs: { topic: "x" },
      runner,
      runId: "r",
      now: fixedNow,
    });
    expect(snap.phases[0]!.steps[0]!.sessionKey).toBe("session-a1");
    expect(snap.phases[1]!.steps[0]!.sessionKey).toBe("session-b1");
  });
});

describe("runRoutine — fail-fast", () => {
  it("halts the run and skips later phases when a step reports error", async () => {
    const runner: StepRunner = async ({ step }) => {
      if (step.id === "a2") {
        return {
          ...ok(step.id),
          outcome: "error",
          error: "boom",
          summary: "",
        };
      }
      return ok(step.id);
    };
    const snap = await runRoutine({
      routine: makeRoutine(),
      inputs: { topic: "x" },
      runner,
      runId: "r",
      now: fixedNow,
    });
    expect(snap.state).toBe("error");
    expect(snap.error).toMatch(/a2.*boom/);
    expect(snap.phases[0]!.state).toBe("error");
    expect(snap.phases[1]!.state).toBe("skipped");
  });

  it("halts when a runner throws", async () => {
    const runner: StepRunner = async ({ step }) => {
      if (step.id === "a1") throw new Error("kaboom");
      return ok(step.id);
    };
    const snap = await runRoutine({
      routine: makeRoutine(),
      inputs: { topic: "x" },
      runner,
      runId: "r",
      now: fixedNow,
    });
    expect(snap.state).toBe("error");
    expect(snap.error).toMatch(/runner threw.*kaboom/);
    expect(snap.phases[1]!.state).toBe("skipped");
  });

  it("treats outcome=aborted as a phase failure", async () => {
    const runner: StepRunner = async ({ step }) => {
      if (step.id === "a1") {
        return { ...ok(step.id), outcome: "aborted", summary: "" };
      }
      return ok(step.id);
    };
    const snap = await runRoutine({
      routine: makeRoutine(),
      inputs: { topic: "x" },
      runner,
      runId: "r",
      now: fixedNow,
    });
    expect(snap.state).toBe("error");
    expect(snap.error).toMatch(/a1.*aborted/);
  });

  it("rejects the run when required inputs are missing", async () => {
    const runner: StepRunner = vi.fn(async ({ step }) => ok(step.id));
    await expect(
      runRoutine({
        routine: makeRoutine(),
        inputs: {},
        runner,
        runId: "r",
        now: fixedNow,
      }),
    ).rejects.toThrow(/missing required input "topic"/);
    expect(runner).not.toHaveBeenCalled();
  });
});

// ── Retry tests ──────────────────────────────────────────────────────────────

/** Build a single-phase, single-step routine for retry-focused tests. */
function makeRetryRoutine(retries: number): Routine {
  return parseRoutine({
    id: "retry-routine",
    name: "Retry routine",
    inputs: [],
    phases: [
      {
        id: "phase-a",
        label: "Phase A",
        steps: [
          {
            id: "s1",
            label: "S one",
            routinePrompt: "do it",
            retries,
          },
        ],
      },
    ],
  });
}

describe("runRoutine — retries", () => {
  it("succeeds on attempt 2 of 3 and snapshot shows attempts=2", async () => {
    let calls = 0;
    const runner: StepRunner = async ({ step }) => {
      calls += 1;
      if (calls < 2) {
        return { ...ok(step.id), outcome: "error", error: "transient" };
      }
      return ok(step.id);
    };

    const snap = await runRoutine({
      routine: makeRetryRoutine(2),
      inputs: {},
      runner,
      runId: "r",
      now: fixedNow,
    });

    expect(snap.state).toBe("success");
    expect(calls).toBe(2);
    expect(snap.phases[0]!.steps[0]!.attempts).toBe(2);
  });

  it("fails after all retries exhausted and lastError reflects the final error", async () => {
    let calls = 0;
    const runner: StepRunner = async ({ step }) => {
      calls += 1;
      return {
        ...ok(step.id),
        outcome: "error",
        error: `attempt-${calls}-failed`,
      };
    };

    const snap = await runRoutine({
      routine: makeRetryRoutine(2),
      inputs: {},
      runner,
      runId: "r",
      now: fixedNow,
    });

    expect(snap.state).toBe("error");
    expect(calls).toBe(3); // 1 initial + 2 retries
    expect(snap.phases[0]!.steps[0]!.attempts).toBe(3);
    expect(snap.phases[0]!.steps[0]!.lastError).toContain("attempt-3-failed");
  });

  it("does NOT retry outcome=aborted — abort is intentional", async () => {
    let calls = 0;
    const runner: StepRunner = async ({ step }) => {
      calls += 1;
      return { ...ok(step.id), outcome: "aborted", summary: "user stopped" };
    };

    const snap = await runRoutine({
      routine: makeRetryRoutine(3),
      inputs: {},
      runner,
      runId: "r",
      now: fixedNow,
    });

    expect(snap.state).toBe("error");
    expect(calls).toBe(1); // no retries for aborted
  });

  it("emits intermediate snapshots showing retry state during retries", async () => {
    let calls = 0;
    const runner: StepRunner = async ({ step }) => {
      calls += 1;
      if (calls < 3) {
        return { ...ok(step.id), outcome: "error", error: `err-${calls}` };
      }
      return ok(step.id);
    };

    const snapshots: RoutineRunSnapshot[] = [];
    const snap = await runRoutine({
      routine: makeRetryRoutine(3),
      inputs: {},
      runner,
      runId: "r",
      onSnapshot: (s) => snapshots.push(s),
      now: fixedNow,
    });

    expect(snap.state).toBe("success");
    // At least one intermediate snapshot should show a partial attempts count.
    const retrySnapshots = snapshots.filter(
      (s) => (s.phases[0]?.steps[0]?.attempts ?? 0) > 0 &&
        s.phases[0]?.state === "running",
    );
    expect(retrySnapshots.length).toBeGreaterThan(0);
  });

  it("default (retries=0) preserves fail-fast on first error — byte-identical", async () => {
    // This ensures the no-retry path is unchanged from the original behaviour.
    const runner: StepRunner = async ({ step }) => {
      if (step.id === "a2") {
        return { ...ok(step.id), outcome: "error", error: "boom" };
      }
      return ok(step.id);
    };
    const snap = await runRoutine({
      routine: makeRoutine(),
      inputs: { topic: "x" },
      runner,
      runId: "r",
      now: fixedNow,
    });
    expect(snap.state).toBe("error");
    expect(snap.error).toMatch(/a2.*boom/);
    expect(snap.phases[1]!.state).toBe("skipped");
  });
});
