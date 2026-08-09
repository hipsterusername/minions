import { describe, it, expect } from "vitest";
import { DialecticOrchestrator, type DialecticOrchestratorDeps } from "./orchestrator.ts";
import type { StartSessionOptions } from "../session-host-types.ts";
import {
  type DialecticConfig,
  type DialecticEvent,
  dialecticSessionKeys,
} from "../../shared/dialectic.ts";

function makeConfig(overrides: Partial<DialecticConfig> = {}): DialecticConfig {
  return {
    mode: "ping-pong",
    rounds: 2,
    plannerA: { harness: "claude", model: "model-a" },
    plannerB: { harness: "claude", model: "model-b" },
    ...overrides,
  };
}

/**
 * Build fake deps that auto-resolve each awaited turn with a deterministic
 * text, recording every startSession call and emitted event.
 */
function makeDeps(
  scriptText?: (key: string, n: number) => { text: string; isError: boolean; error?: string },
) {
  const calls: StartSessionOptions[] = [];
  const events: DialecticEvent[] = [];
  const perKey = new Map<string, number>();
  const terminated: string[] = [];

  const deps: DialecticOrchestratorDeps = {
    startSession: (opts) => {
      calls.push(opts);
    },
    getRuntime: (key) => ({ sessionId: `sid-${key}` }),
    terminate: (key) => {
      terminated.push(key);
    },
    emit: (e) => {
      events.push(e);
    },
    awaitTurn: (key) => {
      const n = (perKey.get(key) ?? 0) + 1;
      perKey.set(key, n);
      const r = scriptText ? scriptText(key, n) : { text: `${key}#${n}`, isError: false };
      return Promise.resolve(r);
    },
    cancelTurn: () => {},
  };
  return { deps, calls, events, terminated };
}

describe("DialecticOrchestrator", () => {
  it("runs A/B for each round, then synthesizes", async () => {
    const keys = dialecticSessionKeys("n1");
    const { deps, calls, events } = makeDeps();
    const orch = new DialecticOrchestrator("n1", "/cwd", makeConfig({ rounds: 2 }), deps);

    await orch.run("Build a widget");

    // 2 rounds × (A + B) + 1 synthesis = 5 launches, in strict order.
    expect(calls.map((c) => c.sessionKey)).toEqual([
      keys.plannerA,
      keys.plannerB,
      keys.plannerA,
      keys.plannerB,
      keys.synthesis,
    ]);

    // Terminal event is a completed status with a synthesis document.
    const statuses = events.filter((e) => e.kind === "run_status");
    expect(statuses[0]).toEqual({ kind: "run_status", status: "running" });
    expect(statuses.at(-1)).toEqual({ kind: "run_status", status: "completed" });
    const synth = events.find((e) => e.kind === "synthesis");
    expect(synth).toBeDefined();
  });

  it("uses two DISTINCT session keys even when models/harness are identical", async () => {
    const { deps, calls } = makeDeps();
    const same = { harness: "claude", model: "claude-opus-4-8" };
    const orch = new DialecticOrchestrator(
      "n2",
      "/cwd",
      makeConfig({ rounds: 1, plannerA: same, plannerB: same }),
      deps,
    );
    await orch.run("topic");
    const keys = dialecticSessionKeys("n2");
    expect(keys.plannerA).not.toBe(keys.plannerB);
    expect(calls[0]!.sessionKey).toBe(keys.plannerA);
    expect(calls[1]!.sessionKey).toBe(keys.plannerB);
  });

  it("starts fresh on round 0 and resumes (with resumeId) on later rounds", async () => {
    const keys = dialecticSessionKeys("n3");
    const { deps, calls } = makeDeps();
    const orch = new DialecticOrchestrator("n3", "/cwd", makeConfig({ rounds: 2 }), deps);
    await orch.run("topic");

    const firstA = calls.find((c) => c.sessionKey === keys.plannerA && c.invocationKind === "new_run")!;
    expect(firstA.role).toBe("dialectic-planner");
    expect(firstA.initialModel).toBe("model-a");
    expect(firstA.permissionMode).toBe("plan");
    expect(firstA.systemPrompt).toBeTruthy();

    const laterA = calls.filter((c) => c.sessionKey === keys.plannerA)[1]!;
    expect(laterA.invocationKind).toBe("resume_open_run");
    expect(laterA.resumeId).toBe(`sid-${keys.plannerA}`);
    // Resume turns don't re-send the system prompt (cache-stable prefix).
    expect(laterA.systemPrompt).toBeUndefined();
  });

  it("injects the peer's latest turn as the next prompt", async () => {
    const keys = dialecticSessionKeys("n4");
    const { deps, calls, events } = makeDeps((key, n) => ({ text: `TURN(${key}#${n})`, isError: false }));
    const orch = new DialecticOrchestrator(
      "n4",
      "/cwd",
      makeConfig({ rounds: 2, mode: "proposer-critic" }),
      deps,
    );
    await orch.run("the topic");

    // B's round-0 prompt carries the topic and A's round-0 output.
    const b0 = calls.filter((c) => c.sessionKey === keys.plannerB)[0]!;
    expect(b0.prompt).toContain("the topic");
    expect(b0.prompt).toContain(`TURN(${keys.plannerA}#1)`);
    const b0Started = events.find(
      (event) => event.kind === "turn_started" && event.speaker === "B" && event.round === 0,
    );
    expect(b0Started).toMatchObject({
      kind: "turn_started",
      speaker: "B",
      round: 0,
      context: {
        prompt: b0.prompt,
        retainedThread: false,
      },
    });
    expect(
      b0Started?.kind === "turn_started" ? b0Started.context?.systemPrompt : undefined,
    ).toContain("Your role: CRITIC");

    // A's round-1 prompt carries B's round-0 output.
    const a1 = calls.filter((c) => c.sessionKey === keys.plannerA)[1]!;
    expect(a1.prompt).toContain(`TURN(${keys.plannerB}#1)`);
    const a1Started = events.find(
      (event) => event.kind === "turn_started" && event.speaker === "A" && event.round === 1,
    );
    expect(a1Started).toMatchObject({
      context: {
        prompt: a1.prompt,
        retainedThread: true,
      },
    });
    expect(
      a1Started?.kind === "turn_started" ? a1Started.context?.systemPrompt : undefined,
    ).toBeUndefined();
  });

  it("emits an error status and stops when a planner turn errors", async () => {
    const { deps, events, calls } = makeDeps((key) =>
      key.endsWith("-B") ? { text: "", isError: true } : { text: "ok", isError: false },
    );
    const orch = new DialecticOrchestrator("n5", "/cwd", makeConfig({ rounds: 2 }), deps);
    await orch.run("topic");
    const statuses = events.filter((e) => e.kind === "run_status");
    expect(statuses.at(-1)).toMatchObject({ kind: "run_status", status: "error" });
    // No synthesis launch after an error.
    expect(calls.some((c) => c.sessionKey.endsWith("-S"))).toBe(false);
  });

  it("surfaces the planner's underlying error in the run_status error", async () => {
    const { deps, events } = makeDeps((key) =>
      key.endsWith("-A")
        ? { text: "", isError: true, error: "model claude-sonnet-5 is not available" }
        : { text: "ok", isError: false },
    );
    const orch = new DialecticOrchestrator("n5b", "/cwd", makeConfig({ rounds: 2 }), deps);
    await orch.run("topic");
    const status = events.filter((e) => e.kind === "run_status").at(-1);
    expect(status).toMatchObject({ kind: "run_status", status: "error" });
    expect((status as { error?: string }).error).toContain("Planner A turn failed");
    expect((status as { error?: string }).error).toContain("model claude-sonnet-5 is not available");
  });

  it("falls back to a generic message when the planner reports no error text", async () => {
    const { deps, events } = makeDeps((key) =>
      key.endsWith("-A") ? { text: "", isError: true } : { text: "ok", isError: false },
    );
    const orch = new DialecticOrchestrator("n5c", "/cwd", makeConfig({ rounds: 1 }), deps);
    await orch.run("topic");
    const status = events.filter((e) => e.kind === "run_status").at(-1);
    expect((status as { error?: string }).error).toBe("Planner A turn failed");
  });

  it("stop() terminates all planner sessions", () => {
    const { deps, terminated } = makeDeps();
    const keys = dialecticSessionKeys("n6");
    const orch = new DialecticOrchestrator("n6", "/cwd", makeConfig(), deps);
    orch.stop();
    expect(terminated).toEqual([keys.plannerA, keys.plannerB, keys.synthesis]);
  });
});
