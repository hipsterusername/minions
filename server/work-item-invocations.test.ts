import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { initDb } from "./db.ts";
import { ensureWorkItemSchema } from "./work-item-schema.ts";
import {
  createWorkItem,
  sealWorkItemRun,
  startWorkItemIteration,
} from "./work-item-repo.ts";
import {
  claimRunInvocationTerminal,
  getRunInvocation,
  listRunInvocations,
  markRunInvocationRunning,
  projectRunInvocationSeal,
  recordRunInvocationIntent,
  startRunInvocation,
} from "./work-item-invocations.ts";
import {
  persistInvocationTerminalWitness,
} from "./work-item-run-start.ts";
import { tagTerminalProvenance } from "./harness/terminal-provenance.ts";
import { registerHarness } from "./harness/index.ts";
import type { AgentHarness } from "./harness/types.ts";
import { SessionHost } from "./session-host.ts";
import { createBus } from "./bus.ts";
import {
  closePersistDb,
  disablePersistence,
  openPersistDb,
} from "./session-persist.ts";
import { terminateSessionHost } from "./session-host-terminate.ts";
import "./agents/index.ts";

function seedRun(db: Database.Database, runKey = "run-1"): void {
  createWorkItem(db, {
    id: "work-1", projectId: "project-1", projectPath: "/tmp",
    title: "Evidence", changeMode: "live", workflowRank: "a", at: 10,
  });
  startWorkItemIteration(db, {
    workItemId: "work-1", runKey, idempotencyKey: `start-${runKey}`,
    expectedLifecycleRevision: 0, expectedCurrentRunKey: null, at: 20,
  });
}

function memoryDb(): Database.Database {
  const db = initDb(":memory:");
  ensureWorkItemSchema(db);
  seedRun(db);
  return db;
}

afterEach(() => {
  closePersistDb();
  disablePersistence();
});

describe("run invocation ledger", () => {
  it("persists opening, provider identity, intent, and terminal evidence", () => {
    const db = memoryDb();
    const opening = startRunInvocation(db, {
      runKey: "run-1", providerId: "claude", startedAt: 30,
    });
    expect(opening).toMatchObject({
      provider_generation: 1, phase: "opening", provider_id: "claude",
      started_at: 30, terminal_kind: null,
    });

    expect(markRunInvocationRunning(db, {
      runKey: "run-1", providerGeneration: 1, providerSessionId: "sdk-1",
    })).toMatchObject({ phase: "running", provider_session_id: "sdk-1" });
    expect(recordRunInvocationIntent(db, {
      runKey: "run-1", providerGeneration: 1, intent: "stop",
    })).toMatchObject({ termination_intent: "stop" });
    expect(claimRunInvocationTerminal(db, {
      runKey: "run-1", providerGeneration: 1,
      terminalKind: "clean", terminalSource: "provider", terminalAt: 40,
    })).toMatchObject({ claimed: true, invocation: {
      phase: "terminal", terminal_kind: "clean",
      terminal_source: "provider", terminal_at: 40,
    } });

    const second = startRunInvocation(db, {
      runKey: "run-1", providerId: "claude", startedAt: 50,
    });
    expect(second.provider_generation).toBe(2);
    expect(second.sequence).toBeGreaterThan(opening.sequence);
    expect(listRunInvocations(db, "run-1")).toHaveLength(2);
  });

  it("rolls back terminal evidence and projection together", () => {
    const db = memoryDb();
    startRunInvocation(db, {
      runKey: "run-1", providerId: "claude", startedAt: 30,
    });
    expect(() => claimRunInvocationTerminal(db, {
      runKey: "run-1", providerGeneration: 1,
      terminalKind: "error", terminalSource: "adapter", terminalAt: 40,
      applyProjection: () => {
        sealWorkItemRun(db, {
          workItemId: "work-1", runKey: "run-1", outcome: "error",
          expectedLifecycleRevision: 1, expectedCurrentRunKey: "run-1", at: 40,
        });
        throw new Error("projection failed");
      },
    })).toThrow("projection failed");
    expect(getRunInvocation(db, "run-1", 1)).toMatchObject({
      phase: "opening", terminal_kind: null,
    });
    expect(db.prepare(`SELECT ended_at, run_outcome FROM sessions
      WHERE session_key = 'run-1'`).get())
      .toEqual({ ended_at: null, run_outcome: "none" });
  });

  it("uses CAS so the first terminal claim wins and later claims are no-ops", () => {
    const db = memoryDb();
    startRunInvocation(db, {
      runKey: "run-1", providerId: "codex", startedAt: 30,
    });
    const projection = vi.fn(() => sealWorkItemRun(db, {
      workItemId: "work-1", runKey: "run-1", outcome: "error",
      expectedLifecycleRevision: 1, expectedCurrentRunKey: "run-1", at: 40,
    }));
    expect(claimRunInvocationTerminal(db, {
      runKey: "run-1", providerGeneration: 1,
      terminalKind: "error", terminalSource: "adapter", terminalAt: 40,
      applyProjection: projection,
    }).claimed).toBe(true);
    expect(claimRunInvocationTerminal(db, {
      runKey: "run-1", providerGeneration: 1,
      terminalKind: "cancelled", terminalSource: "server", terminalAt: 41,
      applyProjection: projection,
    }).claimed).toBe(false);
    expect(projection).toHaveBeenCalledOnce();
    expect(getRunInvocation(db, "run-1", 1)).toMatchObject({
      terminal_kind: "error", terminal_source: "adapter", terminal_at: 40,
    });
    expect(db.prepare(`SELECT ended_at, run_outcome FROM sessions
      WHERE session_key = 'run-1'`).get())
      .toEqual({ ended_at: 40, run_outcome: "error" });
  });

  it("records provider and adapter provenance from normalized terminals", () => {
    const db = openPersistDb(":memory:");
    seedRun(db);
    const host = new SessionHost("run-1", "/repo");
    host.workItemId = "work-1";

    startRunInvocation(db, {
      runKey: host.runKey, providerId: "claude", startedAt: 30,
    });
    persistInvocationTerminalWitness(host, tagTerminalProvenance(
      { kind: "done", reason: "completed", result: "done" }, "provider",
    ), 31);

    host.providerInvocationGeneration = startRunInvocation(db, {
      runKey: host.runKey, providerId: "codex", startedAt: 32,
    }).provider_generation;
    persistInvocationTerminalWitness(host, tagTerminalProvenance(
      { kind: "done", reason: "error", error: "stream failed" }, "adapter",
    ), 33);

    expect(listRunInvocations(db, host.runKey)).toMatchObject([
      { terminal_kind: "clean", terminal_source: "provider" },
      { terminal_kind: "error", terminal_source: "adapter" },
    ]);
  });

  it("persists invocation-started before opening the harness", async () => {
    const db = openPersistDb(":memory:");
    seedRun(db);
    let observedOpening = false;
    const harness: AgentHarness = {
      name: "evidence-order", exposure: "test",
      capabilities: {
        mutationInterception: "complete", thinking: false, promptCaching: false,
        mcp: false, permissionPrompts: false, resume: false,
        partialMessages: false, builtInFilesystem: false,
      },
      builtInTools: [], registerTools: () => undefined,
      checkReadiness: async () => ({
        state: "ready", runtime: { available: true, source: "sdk_bundled" },
        auth: { authenticated: true, source: "unknown" },
      }),
      resolveModel: (model) => model,
      staticInfo: () => ({ models: [], commands: [], agents: [],
        account: { provider: "test" } }),
      start: () => {
        observedOpening = (db.prepare(`SELECT phase FROM run_invocations
          WHERE run_key = 'run-1'`).get() as { phase?: string } | undefined)
          ?.phase === "opening";
        return {
          events: (async function* () {
            yield tagTerminalProvenance(
              { kind: "done", reason: "error", error: "fixture" }, "adapter",
            );
          })(),
          control: { abort: () => undefined },
        };
      },
    };
    registerHarness(harness);
    const host = new SessionHost("run-1", "/tmp");
    await host.start({
      sessionKey: host.id, invocationKind: "new_run", workItemId: "work-1",
      runKind: "primary", prompt: "go", cwd: "/tmp",
      harness: harness.name, initialModel: "test",
    }, {
      bus: createBus({ clients: new Set() } as never),
      startChildSession: () => undefined,
      forEachLeaderTaskState: () => undefined,
    });
    expect(observedOpening).toBe(true);
    expect(listRunInvocations(db, host.runKey)[0]).toMatchObject({
      phase: "terminal", terminal_kind: "error", terminal_source: "adapter",
    });
  });

  it("persists intent before signalling even when sealing never happens", async () => {
    const db = openPersistDb(":memory:");
    seedRun(db);
    const host = new SessionHost("run-1", "/repo");
    host.workItemId = "work-1";
    host.status = "running";
    host.providerInvocationGeneration = startRunInvocation(db, {
      runKey: host.runKey, providerId: "claude", startedAt: 30,
    }).provider_generation;
    host.runControl = {
      abort: () => {
        expect(getRunInvocation(db, host.runKey, 1)?.termination_intent).toBe("abort");
        throw new Error("simulated crash window");
      },
    };

    await expect(terminateSessionHost(host, {
      bus: createBus({ clients: new Set() } as never),
    }, "abort")).rejects.toThrow("simulated crash window");
    expect(getRunInvocation(db, host.runKey, 1)).toMatchObject({
      termination_intent: "abort", terminal_kind: null,
    });
    expect(db.prepare("SELECT ended_at FROM sessions WHERE session_key = 'run-1'").get())
      .toEqual({ ended_at: null });
  });
});

describe("run seal projection table", () => {
  const base = { terminalSource: "provider", cleanTerminalPolicy: "seal" } as const;

  it("projects every witness/intent/policy combination deterministically", () => {
    // Clean terminal, no intent: policy decides between sealing and continuing.
    expect(projectRunInvocationSeal({ ...base, terminalKind: "clean", terminationIntent: null }))
      .toEqual({ action: "seal", outcome: "completed" });
    expect(projectRunInvocationSeal({ ...base, terminalKind: "clean", terminationIntent: null,
      cleanTerminalPolicy: "continue" })).toEqual({ action: "continue" });

    // Any deliberate intent seals stopped for non-error witnesses.
    for (const terminationIntent of ["stop", "close", "remove", "abort", "timeout", "shutdown"] as const) {
      for (const terminalKind of ["cancelled", "lost", null] as const) {
        expect(projectRunInvocationSeal({ ...base, terminalKind, terminationIntent }))
          .toEqual({ action: "seal", outcome: "stopped" });
      }
    }

    // Undeliberate loss seals interrupted.
    expect(projectRunInvocationSeal({ ...base, terminalKind: "lost", terminationIntent: null }))
      .toEqual({ action: "seal", outcome: "interrupted" });
    expect(projectRunInvocationSeal({ ...base, terminalKind: "cancelled", terminationIntent: null }))
      .toEqual({ action: "seal", outcome: "interrupted" });
    expect(projectRunInvocationSeal({ ...base, terminalKind: null, terminationIntent: null,
      invocationDisappeared: true })).toEqual({ action: "seal", outcome: "interrupted" });
  });

  it("resolves races by precedence: error beats intent beats clean witness", () => {
    // Harness error racing a user stop still records the error.
    expect(projectRunInvocationSeal({ ...base, terminalKind: "error", terminationIntent: "stop" }))
      .toEqual({ action: "seal", outcome: "error" });
    expect(projectRunInvocationSeal({ ...base, terminalKind: "error", terminationIntent: null }))
      .toEqual({ action: "seal", outcome: "error" });
    // A stop racing a clean turn boundary is still a deliberate stop, even
    // when the policy would otherwise keep a clean terminal open.
    expect(projectRunInvocationSeal({ ...base, terminalKind: "clean", terminationIntent: "stop" }))
      .toEqual({ action: "seal", outcome: "stopped" });
    expect(projectRunInvocationSeal({ ...base, terminalKind: "clean", terminationIntent: "stop",
      cleanTerminalPolicy: "continue" })).toEqual({ action: "seal", outcome: "stopped" });
  });

  it("refuses to project an in-flight invocation without disappearance evidence", () => {
    expect(() => projectRunInvocationSeal({ ...base, terminalKind: null, terminationIntent: null }))
      .toThrow("disappearance evidence");
  });
});
