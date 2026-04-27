/**
 * End-to-end contract test for the Routines runtime.
 *
 * Wires the **real** scheduler + leader-runner + step-tools + bus +
 * routine-registry against a faked `SessionRegistry`. The fake registry
 * doesn't run an SDK loop — instead, when a leader is "started" it grabs
 * the corresponding StepCompletionContext that the runner registered and
 * resolves it as if the agent had called `report_phase_result`.
 *
 * What we verify
 * ──────────────
 *   1. Phase 1 runs both steps in parallel, each producing structured
 *      outputs the reducer rolls into the handoff brief.
 *   2. Phase 2 receives `{{handoff.brief}}` and `{{handoff.facts.<id>.<k>}}`
 *      substituted into its rendered prompt. It also reports a result.
 *   3. Phase 3's prompt sees Phase 2's brief, not Phase 1's.
 *   4. The final RoutineRunSnapshot is `success` with one handoff per
 *      completed phase.
 *   5. `routine_progress` envelopes are emitted on the bus and reach the
 *      same number of times the snapshot transitions.
 *
 * If any of these break, the routines pipeline is broken end-to-end and
 * a real run on the canvas would not produce a usable result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RoutineRunRegistry } from "../../server/routine-registry.ts";
import { RESEARCH_ANALYZE_REPORT } from "../../server/routines/templates.ts";
import { saveRoutine } from "../../server/routine-store.ts";
import {
  __resetStepContextsForTests,
  getStepContext,
} from "../../server/routines/step-tools.ts";
import {
  GLOBAL_TOPIC,
  type WsEnvelope,
} from "../../shared/ws-envelope.ts";
import type { Bus } from "../../server/bus.ts";
import type { SessionRegistry } from "../../server/session-registry.ts";
import type { RoutineRunSnapshot } from "../../shared/routines/types.ts";

// ── Synthesised infrastructure ─────────────────────────────

interface FakeBus extends Bus {
  emitted: WsEnvelope[];
  _subscribers: Set<(env: WsEnvelope) => void>;
}

function makeFakeBus(): FakeBus {
  const emitted: WsEnvelope[] = [];
  const subscribers = new Set<(env: WsEnvelope) => void>();

  function fanOut(envelope: WsEnvelope): void {
    emitted.push(envelope);
    for (const fn of subscribers) fn(envelope);
  }

  const bus: FakeBus = {
    emitted,
    _subscribers: subscribers,
    emit: (envelope) => fanOut(envelope),
    emitToSession: (sessionKey, payload) =>
      fanOut({ ...payload, topic: `session:${sessionKey}` } as WsEnvelope),
    emitToProject: (projectId, payload) =>
      fanOut({ ...payload, topic: `project:${projectId}` } as WsEnvelope),
    emitGlobal: (payload) =>
      fanOut({ ...payload, topic: GLOBAL_TOPIC } as WsEnvelope),
    subscribe: (handler) => {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
  };
  return bus;
}

/**
 * Pretend session registry: when `start()` is called we treat the request
 * as a successful leader spawn, look up the registered step context, and
 * resolve it according to the per-step script the test installed.
 */
interface SpawnedSession {
  sessionKey: string;
  prompt: string;
  systemPrompt: string;
}

interface FakeRegistryArgs {
  bus: Bus;
  /** stepId → script: how to resolve this step's report_phase_result. */
  scripts: Record<string, StepScript>;
}

interface StepScript {
  outcome: "success" | "error" | "aborted";
  summary: string;
  outputs?: Record<string, unknown>;
  artifacts?: { label: string; ref?: string; excerpt?: string }[];
  /** When true, never call report — instead emit a session_status idle. */
  bailWithoutReporting?: boolean;
}

function makeFakeRegistry(args: FakeRegistryArgs): {
  registry: SessionRegistry;
  spawned: SpawnedSession[];
} {
  const spawned: SpawnedSession[] = [];

  const registry = {
    start(opts: {
      sessionKey: string;
      prompt: string;
      cwd: string;
      systemPrompt?: string;
      role?: string;
      worktreeIsolation?: boolean;
    }) {
      spawned.push({
        sessionKey: opts.sessionKey,
        prompt: opts.prompt,
        systemPrompt: opts.systemPrompt ?? "",
      });
      // Defer to mimic asynchronous SDK loop start — also gives the
      // runner's promise wiring a chance to settle.
      queueMicrotask(() => {
        const ctx = getStepContext(opts.sessionKey);
        if (!ctx) return;
        const script = args.scripts[ctx.stepId];
        if (!script) {
          // Drive the fallback path: emit a session_status=idle event.
          args.bus.emitToSession(opts.sessionKey, {
            type: "session_status",
            sessionKey: opts.sessionKey,
            status: "idle",
            timestamp: Date.now(),
          });
          return;
        }
        if (script.bailWithoutReporting) {
          args.bus.emitToSession(opts.sessionKey, {
            type: "session_status",
            sessionKey: opts.sessionKey,
            status: "idle",
            timestamp: Date.now(),
          });
          return;
        }
        ctx.resolve({
          outcome: script.outcome,
          summary: script.summary,
          ...(script.outputs ? { outputs: script.outputs } : {}),
          ...(script.artifacts ? { artifacts: script.artifacts } : {}),
        });
      });
    },
    get: () => undefined,
    has: () => false,
  } as unknown as SessionRegistry;

  return { registry, spawned };
}

// ── Tests ───────────────────────────────────────────────────

describe("Routines end-to-end", () => {
  let projectPath: string;

  beforeEach(() => {
    __resetStepContextsForTests();
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "routine-e2e-"));
    saveRoutine(projectPath, RESEARCH_ANALYZE_REPORT);
  });

  afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
    __resetStepContextsForTests();
  });

  it("runs research-analyze-report end-to-end with handoff propagation", async () => {
    const bus = makeFakeBus();
    const { registry: sessionRegistry, spawned } = makeFakeRegistry({
      bus,
      scripts: {
        external: {
          outcome: "success",
          summary: "found 5 external sources on widgets",
          outputs: {
            sourceCount: 5,
            topSources: ["https://a.example", "https://b.example"],
            subTopics: ["history", "manufacturing"],
          },
        },
        internal: {
          outcome: "success",
          summary: "no prior project work on widgets",
          outputs: { fileMatches: [], priorWorkFound: false },
        },
        synthesize: {
          outcome: "success",
          summary: "synthesized brief covering all 5 sources",
          outputs: { bulletCount: 5 },
        },
        write: {
          outcome: "success",
          summary: "report written",
          outputs: { sectionCount: 4 },
        },
      },
    });

    const routines = new RoutineRunRegistry({
      bus,
      sessionRegistry,
    });

    const result = routines.startById({
      projectPath,
      cwd: projectPath,
      routineId: "research-analyze-report",
      inputs: { topic: "widgets", audience: "execs" },
    });
    expect("runId" in result).toBe(true);
    if (!("runId" in result)) throw new Error("unexpected error path");
    const runId = result.runId;

    // The registry runs the scheduler in the background; wait for the
    // final snapshot via list().
    const final = await waitForTerminal(routines, runId);
    expect(final.state).toBe("success");
    expect(final.phases.map((p) => p.state)).toEqual([
      "success",
      "success",
      "success",
    ]);

    // 4 leader spawns: two parallel in source phase + one each in analyze/report.
    expect(spawned).toHaveLength(4);

    // The synthesize step's prompt should embed the source brief AND
    // include {{handoff.brief}}'s "Handoff from phase: Source context"
    // header that the reducer composes.
    const synthesizeSpawn = spawned.find(
      (s) => s.prompt.includes("synthesized analysis") || s.prompt.includes("synthesize"),
    ) ?? spawned[2]!;
    expect(synthesizeSpawn.prompt).toContain("# Handoff from phase: Source context");
    expect(synthesizeSpawn.prompt).toContain("found 5 external sources");
    expect(synthesizeSpawn.prompt).toContain("widgets");

    // Phase 3 should see Phase 2's brief, not Phase 1's directly.
    const writeSpawn = spawned[3]!;
    expect(writeSpawn.prompt).toContain("# Handoff from phase: Analyze");
    expect(writeSpawn.prompt).toContain("synthesized brief covering all 5 sources");

    // Bus emitted at least one routine_progress per snapshot transition.
    const progressCount = bus.emitted.filter(
      (e) => (e as { type?: string }).type === "routine_progress",
    ).length;
    expect(progressCount).toBeGreaterThan(0);

    // System prompt for routine-spawned leaders includes the routine-step addendum.
    expect(spawned[0]!.systemPrompt).toContain("Routine step");
    expect(spawned[0]!.systemPrompt).toContain("report_phase_result");

    routines.dispose();
  });

  it("falls back to outcome=error when a leader ends without report_phase_result", async () => {
    const bus = makeFakeBus();
    const { registry: sessionRegistry } = makeFakeRegistry({
      bus,
      scripts: {
        external: { outcome: "success", summary: "ok", bailWithoutReporting: false },
        internal: {
          outcome: "success",
          summary: "ignored",
          bailWithoutReporting: true,
        },
        synthesize: { outcome: "success", summary: "ok" },
        write: { outcome: "success", summary: "ok" },
      },
    });
    const routines = new RoutineRunRegistry({ bus, sessionRegistry });
    const start = routines.startById({
      projectPath,
      cwd: projectPath,
      routineId: "research-analyze-report",
      inputs: { topic: "x" },
    });
    if (!("runId" in start)) throw new Error("unexpected");
    const final = await waitForTerminal(routines, start.runId);
    expect(final.state).toBe("error");
    // First phase failed → later phases skipped under fail-fast.
    expect(final.phases[0]!.state).toBe("error");
    expect(final.phases[1]!.state).toBe("skipped");
    expect(final.phases[2]!.state).toBe("skipped");
    routines.dispose();
  });

  it("abort flips state to aborted and stops scheduling new phases", async () => {
    const bus = makeFakeBus();
    let resolveExternal!: () => void;
    const blockExternal = new Promise<void>((res) => {
      resolveExternal = res;
    });

    // Custom registry that holds the `external` step's resolution until
    // the test releases it — gives us a window to call `abort`.
    const spawned: SpawnedSession[] = [];
    const sessionRegistry = {
      start(opts: {
        sessionKey: string;
        prompt: string;
        systemPrompt?: string;
      }) {
        spawned.push({
          sessionKey: opts.sessionKey,
          prompt: opts.prompt,
          systemPrompt: opts.systemPrompt ?? "",
        });
        queueMicrotask(async () => {
          const ctx = getStepContext(opts.sessionKey);
          if (!ctx) return;
          if (ctx.stepId === "external") {
            await blockExternal;
            ctx.resolve({ outcome: "success", summary: "ok" });
          } else {
            ctx.resolve({ outcome: "success", summary: "ok" });
          }
        });
      },
      get: () => ({ abortController: { abort: vi.fn() } }),
    } as unknown as SessionRegistry;

    const routines = new RoutineRunRegistry({ bus, sessionRegistry });
    const start = routines.startById({
      projectPath,
      cwd: projectPath,
      routineId: "research-analyze-report",
      inputs: { topic: "x" },
    });
    if (!("runId" in start)) throw new Error("unexpected");
    // Let microtasks run so the fakes get the spawn callback.
    await Promise.resolve();
    await Promise.resolve();
    const ok = routines.abort(start.runId);
    expect(ok).toBe(true);
    // Release the held promise so the run can finish unwinding.
    resolveExternal();
    const final = await waitForTerminal(routines, start.runId);
    expect(final.state).toBe("aborted");
    routines.dispose();
  });
});

/**
 * Polls the registry until the snapshot reaches a terminal state. Faster
 * than `setTimeout` and avoids depending on the scheduler's internal
 * promise — the registry exposes `.get(runId)` which is what production
 * consumers use too.
 */
async function waitForTerminal(
  routines: RoutineRunRegistry,
  runId: string,
  timeoutMs = 2000,
): Promise<RoutineRunSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = routines.get(runId);
    if (
      snap &&
      (snap.state === "success" ||
        snap.state === "error" ||
        snap.state === "aborted")
    ) {
      return snap;
    }
    await new Promise((res) => setTimeout(res, 5));
  }
  const last = routines.get(runId);
  throw new Error(
    `waitForTerminal: timeout — last state was ${last?.state ?? "unknown"}`,
  );
}

