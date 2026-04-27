/**
 * Tests for leader-runner timeout behaviour.
 *
 * We use a fake `LeaderRunnerDeps` that never naturally resolves the step
 * (simulates a hung agent) so the only resolution path is the timeout.
 * Real timers, small timeout values — no fake-timer ceremony needed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLeaderStepRunner,
  type LeaderRunnerDeps,
} from "./leader-runner.ts";
import {
  __resetStepContextsForTests,
  getStepContext,
} from "./step-tools.ts";
import type { RoutinePhase, RoutineStep } from "../../shared/routines/types.ts";
import type { Bus } from "../bus.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const fakeBus: Bus = {
  emitToSession: () => {},
  emitToProject: () => {},
  emitGlobal: () => {},
} as unknown as Bus;

/** Returns deps whose session never ends on its own (hung agent). */
function makeHangingDeps(abortSession = vi.fn()): LeaderRunnerDeps {
  return {
    projectPath: "/fake",
    cwd: "/fake",
    bus: fakeBus,
    startLeaderSession: vi.fn(),
    abortSession,
    subscribeSessionEnded: (_key, _handler) => () => {},
    generateSessionKey: ({ runId, stepId }) => `${runId}-${stepId}`,
  };
}

const baseStep: RoutineStep = {
  id: "s1",
  label: "S one",
  agent: "leader",
  routinePrompt: "do stuff",
  skillIds: [],
  skillValues: {},
  mcpServerIds: [],
  retries: 0,
};

const basePhase: RoutinePhase = {
  id: "p1",
  label: "Phase one",
  steps: [baseStep],
};

const baseRunArgs = {
  step: baseStep,
  phase: basePhase,
  renderedPrompt: "do stuff",
  unresolved: [],
  handoff: undefined,
  inputs: {},
  runId: "run-1",
};

afterEach(() => {
  __resetStepContextsForTests();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("leader-runner — timeout", () => {
  it(
    "returns error outcome with timeout message when step hangs past timeoutMs",
    async () => {
      const abortSession = vi.fn();
      const { runner } = createLeaderStepRunner(makeHangingDeps(abortSession));

      const result = await runner({
        ...baseRunArgs,
        step: { ...baseStep, timeoutMs: 30 },
      });

      expect(result.outcome).toBe("error");
      expect(result.summary).toContain("timed out after 30ms");
      expect(result.error).toContain("timed out after 30ms");
      expect(abortSession).toHaveBeenCalledWith("run-1-s1");
    },
    2000,
  );

  it(
    "does NOT include 'timed out' when step ends before deadline",
    async () => {
      const deps: LeaderRunnerDeps = {
        ...makeHangingDeps(),
        // Fire the session-ended signal almost immediately — well before 500ms.
        subscribeSessionEnded: (_key, handler) => {
          const handle = setTimeout(
            () => handler({ reason: "completed", isError: false }),
            20,
          );
          return () => clearTimeout(handle);
        },
      };
      const { runner } = createLeaderStepRunner(deps);

      const result = await runner({
        ...baseRunArgs,
        step: { ...baseStep, timeoutMs: 500 },
      });

      // Resolved via session-ended fallback (no report_phase_result call).
      expect(result.outcome).toBe("error");
      expect(result.summary).not.toContain("timed out");
    },
    2000,
  );

  it(
    "preserves existing no-timeout behaviour when timeoutMs is undefined",
    async () => {
      const deps: LeaderRunnerDeps = {
        ...makeHangingDeps(),
        subscribeSessionEnded: (_key, handler) => {
          const handle = setTimeout(
            () => handler({ reason: "completed", isError: false }),
            20,
          );
          return () => clearTimeout(handle);
        },
      };
      const { runner } = createLeaderStepRunner(deps);

      // No timeoutMs on the step.
      const result = await runner({ ...baseRunArgs, step: baseStep });

      expect(result.summary).not.toContain("timed out");
    },
    2000,
  );
});

// ── Gap 2: Timeout cleanup race ──────────────────────────────────────────────

describe("leader-runner — timeout context cleanup", () => {
  it(
    "unregisters the step context after timeout fires",
    async () => {
      const { runner } = createLeaderStepRunner(makeHangingDeps());

      // Context registration is synchronous (inside the Promise constructor in
      // awaitStepResult), so it is available immediately after runner() returns
      // its Promise — before any microtasks or timers run.
      const resultPromise = runner({
        ...baseRunArgs,
        step: { ...baseStep, timeoutMs: 50 },
      });
      const ctxWhileInFlight = getStepContext("run-1-s1");
      expect(ctxWhileInFlight).toBeDefined();

      const result = await resultPromise;
      expect(result.outcome).toBe("error");
      expect(result.error).toContain("timed out");

      // finalize() must have called unregisterStepContext.
      expect(getStepContext("run-1-s1")).toBeUndefined();
    },
    2000,
  );

  it(
    "late resolve call after timeout settlement is silently dropped — no throw, no state change",
    async () => {
      const { runner } = createLeaderStepRunner(makeHangingDeps());

      const resultPromise = runner({
        ...baseRunArgs,
        step: { ...baseStep, timeoutMs: 50 },
      });

      // Capture ctx before the timeout fires.
      const ctx = getStepContext("run-1-s1");
      expect(ctx).toBeDefined();

      const result = await resultPromise;
      expect(result.outcome).toBe("error");

      // Simulate an agent sending report_phase_result after the session was aborted.
      // isSettled() is true at this point, so resolve() is a silent no-op.
      expect(() =>
        ctx!.resolve({ outcome: "success", summary: "too late" }),
      ).not.toThrow();

      // The settled result is still the timeout error — the late resolve had no effect.
      expect(result.outcome).toBe("error");
      expect(result.error).toContain("timed out");
    },
    2000,
  );
});

// ── Gap 3: Retry fresh sessionKey ────────────────────────────────────────────

describe("leader-runner — fresh sessionKey per retry attempt", () => {
  it(
    "each call to the runner produces a distinct sessionKey so late tool calls cannot bleed across retries",
    async () => {
      const spawnedKeys: string[] = [];
      let keyCounter = 0;

      // Deps that resolve each attempt immediately via session-ended fallback.
      const deps: LeaderRunnerDeps = {
        projectPath: "/fake",
        cwd: "/fake",
        bus: fakeBus,
        startLeaderSession: ({ sessionKey }) => {
          spawnedKeys.push(sessionKey);
        },
        subscribeSessionEnded: (_key, handler) => {
          const handle = setTimeout(
            () => handler({ reason: "completed", isError: false }),
            5,
          );
          return () => clearTimeout(handle);
        },
        // Counter-based generator guarantees uniqueness independent of wall-clock time.
        generateSessionKey: () => `session-${(keyCounter += 1)}`,
      };

      const { runner } = createLeaderStepRunner(deps);

      // Call the runner twice, each simulating one attempt (initial + 1 retry).
      const r1 = await runner({ ...baseRunArgs });
      const r2 = await runner({ ...baseRunArgs });

      expect(r1.sessionKey).toBeDefined();
      expect(r2.sessionKey).toBeDefined();
      expect(r1.sessionKey).not.toBe(r2.sessionKey);

      // startLeaderSession was invoked once per attempt with distinct keys.
      expect(spawnedKeys).toHaveLength(2);
      expect(new Set(spawnedKeys).size).toBe(2);
    },
    2000,
  );
});
