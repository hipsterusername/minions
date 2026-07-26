/**
 * SessionHost — lifecycle tests.
 *
 * These pin the contract `SessionHost` exposes to `server/index.ts` and the
 * registry: it owns one harness run per `start()`, fans every event out
 * onto the bus wrapped as a `sdk_event`, advances `status` correctly on
 * init/result/error, and respects the abort controller.
 *
 * Boundary mocks (per docs/testing-strategy.md §5.2):
 *   - `./harness/index.ts` — replaced with a fake AgentHarness whose
 *     start() returns { events, control }. The test drives `events` directly
 *     using NormalizedEvent values, staying above the SDK translation layer.
 *   - `./session-persist.ts` — disabled via the production `disablePersistence()`
 *     toggle so no SQLite is touched.
 *
 * Real, untouched:
 *   - `Bus` capture (the real `createBus` over a fake `WebSocketServer`
 *     that records every fan-out).
 *   - `SessionHost` itself.
 *   - The registered agents (no SDK calls in the agent implementations) — keeps the test focused
 *     on lifecycle, not agent wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NormalizedEvent } from "./harness/types.ts";

// ── Harness mock ─────────────────────────────────────────────────────────────

/**
 * Module-level mutable state for the fake harness. The mock factory closes
 * over this object so individual tests can push events or override start().
 * Reset in beforeEach.
 */
const harnessRef: {
  events: NormalizedEvent[];
  starts: unknown[];
  startFnOverride: (() => {
    events: AsyncIterable<NormalizedEvent>;
    control: { abort: () => void };
  }) | null;
  mutationInterception: "complete" | "observe_only" | "none";
} = { events: [], starts: [], startFnOverride: null, mutationInterception: "none" };

// Declared before imports — vitest hoists vi.mock() calls above the ESM
// import graph, so the factory runs before any module under test is loaded.
vi.mock("./harness/index.ts", () => ({
  getHarness: () => ({
    name: "claude",
    capabilities: {
      mutationInterception: harnessRef.mutationInterception,
      thinking: false,
      promptCaching: false,
      mcp: true,
      permissionPrompts: false,
      resume: false,
      partialMessages: false,
      builtInFilesystem: false,
    },
    builtInTools: [] as string[],
    staticInfo: () => ({
      models: [],
      commands: [],
      agents: [],
      account: { provider: "claude" },
    }),
    registerTools: () => {},
    resolveModel: () => null,
    start: (opts: unknown) => {
      harnessRef.starts.push(opts);
      if (harnessRef.startFnOverride) return harnessRef.startFnOverride();
      const eventsToYield = [...harnessRef.events];
      return {
        events: (async function* () {
          for (const event of eventsToYield) {
            yield event;
          }
        })(),
        control: { abort: () => {} },
      };
    },
  }),
  registerHarness: () => {},
}));

import { SessionHost, type SessionHostDeps } from "./session-host.ts";
import { createBus, type Bus } from "./bus.ts";
import {
  openPersistDb,
  disablePersistence,
  closePersistDb,
} from "./session-persist.ts";
import { requestWaitResume } from "./wait-resume.ts";
import "./agents/index.ts"; // registers agent types
import {
  createCheckpointSessionToolDef,
  resetCheckpointSessionStateForTest,
} from "./task-tools/checkpoint-session.ts";
import type { TaskToolContext } from "./task-tools/types.ts";

interface CapturedEnvelope {
  topic: string;
  type: string;
  payload: Record<string, unknown>;
}

interface Harness {
  host: SessionHost;
  bus: Bus;
  envelopes: CapturedEnvelope[];
  deps: SessionHostDeps;
}

function makeHarness(id = "host-1", cwd = "/tmp"): Harness {
  // Fake WebSocketServer: a `clients` set that's always empty so `broadcast`
  // is a no-op. The bus's in-process `subscribe` is what carries our capture.
  const fakeWss = { clients: new Set() } as unknown as Parameters<
    typeof createBus
  >[0];
  const bus = createBus(fakeWss);

  const envelopes: CapturedEnvelope[] = [];
  bus.subscribe((env) => {
    const { topic, type, ...rest } = env as CapturedEnvelope &
      Record<string, unknown>;
    envelopes.push({ topic, type, payload: rest });
  });

  const deps: SessionHostDeps = {
    bus,
    startChildSession: vi.fn(),
    forEachLeaderTaskState: vi.fn(),
  };

  return { host: new SessionHost(id, cwd), bus, envelopes, deps };
}

beforeEach(() => {
  // Fresh event queue + reset override per test.
  harnessRef.events = [];
  harnessRef.starts = [];
  harnessRef.startFnOverride = null;
  // The test harness models Claude unless a case explicitly exercises a
  // degraded adapter capability.
  harnessRef.mutationInterception = "complete";
  // Disable SQLite persistence for the duration of these tests.
  disablePersistence();
});

afterEach(() => {
  resetCheckpointSessionStateForTest();
  closePersistDb();
});

describe("SessionHost.start — happy-path lifecycle", () => {
  it("labels uncoordinated legacy Claude live mode as compatibility observe-only", async () => {
    const { host, deps, envelopes } = makeHarness("legacy-claude");
    await host.start({ sessionKey: host.id, prompt: "read", cwd: host.cwd,
      role: "default", worktreeIsolation: false }, deps);
    expect(envelopes).toContainEqual(expect.objectContaining({
      type: "mutation_enforcement_compatibility",
      payload: expect.objectContaining({ observeOnly: true, mode: "live" }),
    }));
  });

  it("allows an observe-only legacy live run and discloses it as direct-to-main", async () => {
    // Worktree OFF = direct-to-main: there is no contribution lifecycle to
    // protect, so an observe-only harness (e.g. Codex "Sol") is allowed to run.
    harnessRef.mutationInterception = "observe_only";
    const { host, deps, envelopes } = makeHarness("legacy-observe-only");
    await host.start({ sessionKey: host.id, prompt: "change files", cwd: host.cwd,
      role: "default", worktreeIsolation: false }, deps);
    expect(harnessRef.starts).toHaveLength(1);
    expect(host.lastError).toBeFalsy();
    expect(envelopes.some((event) => event.type === "mutation_enforcement_fallback")).toBe(true);
  });

  it("allows a canonical live run when the harness has no interception", async () => {
    harnessRef.mutationInterception = "none";
    const { host, deps, envelopes } = makeHarness("live-none");
    host.workItemId = "work-1";
    await host.start({ sessionKey: host.id, workItemId: "work-1",
      prompt: "change files", cwd: host.cwd, role: "leader",
      worktreeIsolation: false }, deps);
    expect(harnessRef.starts).toHaveLength(1);
    expect(host.lastError).toBeFalsy();
    expect(envelopes.some((event) => event.type === "mutation_enforcement_fallback")).toBe(true);
  });

  it("allows a canonical live run when the harness is only observe-only", async () => {
    harnessRef.mutationInterception = "observe_only";
    const { host, deps, envelopes } = makeHarness("live-observe-only");
    host.workItemId = "work-1";
    await host.start({ sessionKey: host.id, workItemId: "work-1",
      prompt: "change files", cwd: host.cwd, role: "leader",
      worktreeIsolation: false }, deps);
    expect(harnessRef.starts).toHaveLength(1);
    expect(host.status).not.toBe("error");
    expect(envelopes.some((event) => event.type === "mutation_enforcement_fallback")).toBe(true);
  });

  it("allows an observe-only child that inherits its parent's worktree", async () => {
    harnessRef.mutationInterception = "observe_only";
    const { host, deps } = makeHarness("safe-child", "/repo"); host.workItemId = "work-1";
    await host.start({ sessionKey: host.id, workItemId: "work-1", prompt: "change",
      cwd: "/repo", role: "minion", worktreeIsolation: false,
      parentWorktree: { path: "/repo/.minions/worktrees/parent", branch: "minions/parent",
        projectPath: "/repo", leaderSessionKey: "parent", createdAt: 1, lifecycle: "active" } }, deps);
    expect(harnessRef.starts).toHaveLength(1);
    expect(host.cwd).toBe("/repo/.minions/worktrees/parent");
  });
  it("seeds primary/child lineage once and preserves it across later starts", () => {
    const host = new SessionHost("child-run", "/tmp/work");
    expect(host.seedRunLineage({
      runKind: "child", parentRunKey: "root-run", taskId: "task-1",
    })).toBe(true);
    expect(host.seedRunLineage({ runKind: "primary" })).toBe(false);
    expect(host).toMatchObject({
      runKey: "child-run", runKind: "child", parentRunKey: "root-run", taskId: "task-1",
    });
  });

  it("advances lifecycle only for new-run invocations while retaining one runKey", async () => {
    const { host, deps } = makeHarness("stable-run");
    harnessRef.events = [
      { kind: "init", sessionId: "provider", model: "sonnet" },
      { kind: "done", reason: "stop" },
    ];

    await host.start({
      sessionKey: host.id,
      invocationKind: "new_run",
      prompt: "first",
      cwd: host.cwd,
    }, deps);
    expect(host.reviewLifecycle.lifecycleRevision).toBe(2);

    await host.start({
      sessionKey: host.id,
      invocationKind: "resume_open_run",
      prompt: "reply",
      cwd: host.cwd,
      resumeId: host.sessionId ?? undefined,
    }, deps);
    expect(host.reviewLifecycle.lifecycleRevision).toBe(3);

    await host.start({
      sessionKey: host.id,
      invocationKind: "provider_continuation",
      prompt: "checkpoint",
      cwd: host.cwd,
    }, deps);
    expect(host.reviewLifecycle.lifecycleRevision).toBe(4);
    expect(host.runKey).toBe("stable-run");
  });

  it("transitions running → idle when the harness closes with a done event", async () => {
    const { host, deps, envelopes } = makeHarness();

    harnessRef.events = [
      { kind: "init", sessionId: "sess-1", model: "sonnet" },
      { kind: "done", reason: "stop", costUSD: 0.42, turns: 3 },
    ];

    await host.start(
      { sessionKey: host.id, prompt: "hello", cwd: host.cwd },
      deps,
    );

    expect(host.status).toBe("idle");
    expect(host.sessionId).toBe("sess-1");
    expect(host.totalCost).toBe(0.42);
    expect(host.turns).toBe(3);

    // The bus saw: legacy coordination disclosure, running, sdk_event(init),
    // durable lifecycle outcome, idle.
    // The `done` NormalizedEvent is signalled as session_status(idle),
    // NOT emitted as an sdk_event.
    const types = envelopes.map((e) => e.type);
    expect(types).toEqual([
      "mutation_enforcement_compatibility", // legacy live mode is observe-only
      "session_status", // running
      "sdk_event",      // init
      "session_lifecycle_changed", // interrupted: stop has no final report
      "session_status", // idle (from done)
    ]);

    const statuses = envelopes
      .filter((e) => e.type === "session_status")
      .map((e) => e.payload["status"]);
    expect(statuses).toEqual(["running", "idle"]);
  });

  it("drains a queued wait resume after the current run becomes idle", async () => {
    const { host, deps, envelopes } = makeHarness("leader-1");
    host.role = "leader";
    const startChildSession = deps.startChildSession as ReturnType<typeof vi.fn>;

    harnessRef.startFnOverride = () => ({
      events: (async function* () {
        yield { kind: "init", sessionId: "sdk-queued", model: "sonnet" };
        const timerId = setTimeout(() => {}, 30_000);
        host.taskState = {
          tasks: new Map(),
          pendingWait: {
            durationMs: 30_000,
            reason: "waiting",
            scheduledAt: Date.now(),
            timerId,
          },
          approval: null,
        };
        host.waitTimerId = timerId;
        requestWaitResume(host, deps, {
          completedReason: "timer elapsed",
          opts: {
            sessionKey: host.id,
            prompt: "Continue.",
            cwd: host.cwd,
            resumeId: host.sessionId ?? undefined,
            role: "leader",
            harness: "claude",
          },
        });
        expect(startChildSession).not.toHaveBeenCalled();
        yield { kind: "done", reason: "stop" };
      })(),
      control: { abort: () => {} },
    });

    await host.start({ sessionKey: host.id, prompt: "p", cwd: host.cwd, role: "leader" }, deps);

    expect(host.taskState?.pendingWait).toBeNull();
    expect(startChildSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: "leader-1",
      resumeId: "sdk-queued",
      prompt: "Continue.",
    }));
    expect(envelopes.some((e) =>
      e.type === "wait_state" && e.payload["action"] === "completed",
    )).toBe(true);
  });

  it("nudges an idle minion by resuming its existing harness session", async () => {
    const { host, deps } = makeHarness("minion-1");
    const taskState = {
      tasks: new Map([
        ["t1", {
          taskId: "t1",
          title: "T1",
          description: "",
          priority: "medium" as const,
          executor: "minion" as const,
          minionSessionKey: "minion-1",
          leaderSessionKey: "leader-1",
          status: "running" as const,
          createdAt: 1,
          completedAt: null,
          result: null,
        }],
      ]),
      pendingWait: null,
      approval: null,
    };
    deps.forEachLeaderTaskState = (fn) => fn("leader-1", taskState);
    harnessRef.events = [
      { kind: "init", sessionId: "sdk-existing", model: "sonnet" },
      { kind: "done", reason: "stop" },
    ];

    await host.start({ sessionKey: host.id, prompt: "p", cwd: host.cwd, role: "minion" }, deps);

    expect(deps.startChildSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: "minion-1",
      role: "minion",
      resumeId: "sdk-existing",
    }));
  });

  it("captures init metadata into host.initData and persists session_id immediately", async () => {
    const { host, deps } = makeHarness();

    harnessRef.events = [
      {
        kind: "init",
        sessionId: "captured-id",
        model: "sonnet",
        permissionMode: "auto",
        meta: { tools: ["Read", "Write"], model: "sonnet" },
      },
      { kind: "done", reason: "stop" },
    ];

    await host.start({ sessionKey: host.id, prompt: "p", cwd: host.cwd }, deps);

    expect(host.sessionId).toBe("captured-id");
    expect(host.permissionMode).toBe("auto");
    expect(host.initData).toMatchObject({
      tools: ["Read", "Write"],
      model: "sonnet",
    });
  });

  it("buffers every SDK event onto host.eventBuffer", async () => {
    const { host, deps } = makeHarness();

    harnessRef.events = [
      { kind: "init", sessionId: "s", model: "" },
      { kind: "text", text: "hello", role: "assistant" },
      { kind: "text", text: "world", role: "assistant" },
      { kind: "done", reason: "stop" },
    ];

    await host.start({ sessionKey: host.id, prompt: "p", cwd: host.cwd }, deps);

    // running + 3 sdk_events + lifecycle outcome + idle = 6 buffered events.
    // The `done` NormalizedEvent → session_status(idle), not sdk_event.
    expect(host.eventBuffer.map((e) => e.type)).toEqual([
      "session_status",
      "sdk_event",
      "sdk_event",
      "sdk_event",
      "session_lifecycle_changed",
      "session_status",
    ]);
  });

  it("adds canonical run and work-item identity at the normalized event boundary", async () => {
    const { host, deps, envelopes } = makeHarness("run-7");
    harnessRef.events = [
      { kind: "init", sessionId: "provider-7", model: "sonnet" },
      { kind: "text", text: "working", role: "assistant" },
      { kind: "done", reason: "stop" },
    ];

    await host.start({
      sessionKey: host.id,
      workItemId: "work-3",
      prompt: "p",
      cwd: host.cwd,
    }, deps);

    const sdkEvents = envelopes.filter((envelope) => envelope.type === "sdk_event");
    expect(sdkEvents).toHaveLength(2);
    for (const envelope of sdkEvents) {
      expect(envelope.payload).toMatchObject({
        sessionKey: "run-7",
        runKey: "run-7",
        workItemId: "work-3",
      });
    }
    expect(host.eventBuffer.filter((event) => event.type === "sdk_event"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ runKey: "run-7", workItemId: "work-3" }),
      ]));
  });

  it("emits an explicit null work-item identity for compatibility launches", async () => {
    const { host, deps, envelopes } = makeHarness("legacy-run");
    harnessRef.events = [
      { kind: "init", sessionId: "provider-old", model: "sonnet" },
      { kind: "done", reason: "stop" },
    ];

    await host.start({ sessionKey: host.id, prompt: "p", cwd: host.cwd }, deps);

    expect(envelopes.find((envelope) => envelope.type === "sdk_event")?.payload)
      .toMatchObject({
        sessionKey: "legacy-run",
        runKey: "legacy-run",
        workItemId: null,
      });
  });

  it("documents the Phase 0 runKey alias across repeated starts", async () => {
    const { host, deps } = makeHarness("compat-session");
    harnessRef.events = [
      { kind: "init", sessionId: "provider-1", model: "sonnet" },
      { kind: "done", reason: "stop" },
    ];
    await host.start({ sessionKey: host.id, workItemId: "work-1", prompt: "first", cwd: host.cwd }, deps);

    harnessRef.events = [
      { kind: "init", sessionId: "provider-1", model: "sonnet" },
      { kind: "done", reason: "stop" },
    ];
    await host.start({ sessionKey: host.id, workItemId: "work-1", prompt: "second", cwd: host.cwd }, deps);

    const sdkEvents = host.eventBuffer.filter((event) => event.type === "sdk_event");
    expect(sdkEvents).toHaveLength(2);
    expect(sdkEvents.map((event) => event.runKey)).toEqual([
      "compat-session",
      "compat-session",
    ]);
  });
});

describe("SessionHost.start — error path", () => {
  it("transitions to status='error' and emits a session_error event when the harness throws synchronously", async () => {
    const { host, deps, envelopes } = makeHarness();
    host.workItemId = "work-1";
    const runTerminal = vi.fn();
    deps.workItemLifecycle = {
      providerInitialized: vi.fn(), runStarted: vi.fn(), runWaiting: vi.fn(), runTerminal,
    };

    harnessRef.startFnOverride = () => ({
      events: (async function* () {
        throw new Error("boom");
      })(),
      control: { abort: () => {} },
    });

    await host.start(
      { sessionKey: host.id, prompt: "p", cwd: host.cwd },
      deps,
    );

    expect(host.status).toBe("error");
    expect(host.lastError).toBe("boom");
    const errorEvents = envelopes.filter((e) => e.type === "session_error");
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]!.payload["error"]).toBe("boom");
    expect(runTerminal).toHaveBeenCalledOnce();
    expect(runTerminal).toHaveBeenCalledWith(expect.objectContaining({ outcome: "error" }));
  });

  it("recovers a resumed Codex context-window failure in a fresh compacted thread", async () => {
    const { host, deps, envelopes } = makeHarness();
    host.harnessName = "codex";
    host.sessionId = "thread-too-large";
    host.taskName = "Long leader loop";

    let starts = 0;
    harnessRef.startFnOverride = () => {
      starts += 1;
      const events =
        starts === 1
          ? ([
              { kind: "init", sessionId: "thread-too-large", model: "gpt-5.5" },
              { kind: "text", text: "I finished step one.", role: "assistant" },
              {
                kind: "done",
                reason: "error",
                error: "Codex Exec exited with code 1: Reading prompt from stdin...",
                fullError:
                  "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
              },
            ] satisfies NormalizedEvent[])
          : ([
              { kind: "init", sessionId: "fresh-thread", model: "gpt-5.5" },
              { kind: "done", reason: "stop" },
            ] satisfies NormalizedEvent[]);
      return {
        events: (async function* () {
          for (const event of events) yield event;
        })(),
        control: { abort: () => {} },
      };
    };

    await host.start(
      {
        sessionKey: host.id,
        prompt: "Continue the work.",
        cwd: host.cwd,
        resumeId: "thread-too-large",
      },
      deps,
    );

    expect(starts).toBe(2);
    expect(host.status).toBe("idle");
    expect(host.sessionId).toBe("fresh-thread");
    // Provider-thread recovery continues the same logical run: one beginRun
    // plus one terminal transition, not a second lifecycle reset.
    expect(host.reviewLifecycle.lifecycleRevision).toBe(2);
    expect(host.reviewLifecycle.terminalReason).toBe("stop");
    expect(envelopes.filter((e) => e.type === "session_error")).toHaveLength(0);

    const secondStart = harnessRef.starts[1] as {
      resumeId?: string;
      prompt?: string;
    };
    expect(secondStart.resumeId).toBeUndefined();
    expect(secondStart.prompt).toContain("<previous-session-context>");
    expect(secondStart.prompt).not.toContain("<context-window-recovery>");
    expect(secondStart.prompt).toContain("I finished step one.");
    expect(secondStart.prompt).toContain("Continue the work.");
  });

  it("surfaces a context-window failure after one automatic recovery attempt", async () => {
    const { host, deps, envelopes } = makeHarness();

    harnessRef.events = [
      {
        kind: "done",
        reason: "error",
        error: "context window exhausted",
      },
    ];

    await host.start(
      {
        sessionKey: host.id,
        prompt: "Continue",
        cwd: host.cwd,
        resumeId: "thread-too-large",
        contextRecoveryAttempt: 1,
      },
      deps,
    );

    expect(host.status).toBe("error");
    expect(envelopes.filter((e) => e.type === "session_error")).toHaveLength(1);
  });

  it("appends one proactive checkpoint reminder after recommendation crossing", async () => {
    const { host, deps } = makeHarness();
    host.role = "leader";

    harnessRef.events = [
      { kind: "init", sessionId: "thread-1", model: "sonnet" },
      { kind: "usage", input: 110_000, output: 1 },
      { kind: "done", reason: "stop" },
    ];
    await host.start({ sessionKey: host.id, prompt: "first", cwd: host.cwd, role: "leader" }, deps);

    harnessRef.events = [
      { kind: "init", sessionId: "thread-1", model: "sonnet" },
      { kind: "done", reason: "stop" },
    ];
    await host.start({ sessionKey: host.id, prompt: "next wake", cwd: host.cwd, role: "leader" }, deps);

    const secondStart = harnessRef.starts[1] as { prompt: string };
    expect(secondStart.prompt).toContain("checkpoint_session");
    expect(secondStart.prompt).toContain("55%");

    await host.start({ sessionKey: host.id, prompt: "third", cwd: host.cwd, role: "leader" }, deps);
    const thirdStart = harnessRef.starts[2] as { prompt: string };
    expect(thirdStart.prompt).not.toContain("checkpoint_session");
  });

  it("swaps to a fresh thread after checkpoint_session handoff", async () => {
    const { host, deps, envelopes } = makeHarness("leader-1");
    await createCheckpointSessionToolDef(taskToolCtx("leader-1")).handler({});

    let starts = 0;
    harnessRef.startFnOverride = () => {
      starts += 1;
      const events =
        starts === 1
          ? ([
              { kind: "init", sessionId: "old-thread", model: "sonnet" },
              { kind: "text", role: "assistant", text: "Goal: finish compaction. Next: run tests." },
              { kind: "done", reason: "stop" },
            ] satisfies NormalizedEvent[])
          : ([
              { kind: "init", sessionId: "new-thread", model: "sonnet" },
              { kind: "done", reason: "stop" },
            ] satisfies NormalizedEvent[]);
      return { events: (async function* () { for (const event of events) yield event; })(), control: { abort: () => {} } };
    };

    await host.start({ sessionKey: host.id, prompt: "p", cwd: host.cwd, role: "leader", resumeId: "old-thread" }, deps);

    expect(starts).toBe(2);
    expect(host.sessionId).toBe("new-thread");
    const secondStart = harnessRef.starts[1] as { resumeId?: string; prompt: string };
    expect(secondStart.resumeId).toBeUndefined();
    expect(secondStart.prompt).toContain("<session-continuation>");
    expect(secondStart.prompt).not.toContain("<previous-session-context>");
    expect(secondStart.prompt).toContain("Goal: finish compaction");
    expect(envelopes.some((e) => e.type === "session_compacted")).toBe(true);
  });

  it("keeps the logical run active while a checkpoint opens its fresh provider thread", async () => {
    const { host, deps, envelopes } = makeHarness("leader-checkpoint-lifecycle");
    host.workItemId = "work-checkpoint-lifecycle";
    const runtimeLifecycle = {
      providerInitialized: vi.fn(),
      runStarted: vi.fn(),
      runWaiting: vi.fn(),
      runTerminal: vi.fn(),
    };
    deps.workItemLifecycle = runtimeLifecycle;
    await createCheckpointSessionToolDef(taskToolCtx(host.id)).handler({});

    let starts = 0;
    harnessRef.startFnOverride = () => {
      starts += 1;
      if (starts === 1) {
        return {
          events: (async function* () {
            yield { kind: "init", sessionId: "old-thread", model: "sonnet" } as NormalizedEvent;
            yield { kind: "text", role: "assistant", text: "Continue the same run." } as NormalizedEvent;
            yield { kind: "done", reason: "stop" } as NormalizedEvent;
          })(),
          control: { abort: () => {} },
        };
      }
      return {
        events: (async function* () {
          yield { kind: "init", sessionId: "new-thread", model: "sonnet" } as NormalizedEvent;
          expect(host.status).toBe("running");
          expect(host.reviewLifecycle.terminalAt).toBeNull();
          expect(runtimeLifecycle.runTerminal).not.toHaveBeenCalled();
          yield { kind: "done", reason: "completed", result: "Actually finished." } as NormalizedEvent;
        })(),
        control: { abort: () => {} },
      };
    };

    await host.start({
      sessionKey: host.id,
      workItemId: host.workItemId,
      invocationKind: "new_run",
      prompt: "p",
      cwd: host.cwd,
      role: "leader",
      resumeId: "old-thread",
    }, deps);

    expect(starts).toBe(2);
    expect(runtimeLifecycle.runTerminal).toHaveBeenCalledOnce();
    expect(runtimeLifecycle.runTerminal).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "completed",
      finalReport: "Actually finished.",
    }));
    expect(envelopes.filter((event) => event.type === "session_status")
      .map((event) => event.payload["status"]))
      .toEqual(["running", "running", "idle"]);
  });

  it("does not let a stale recovery frame persist error after a healthy compacted run", async () => {
    const db = openPersistDb(":memory:");
    const { host, deps } = makeHarness("leader-db-status");
    await createCheckpointSessionToolDef(taskToolCtx("leader-db-status")).handler({});

    const emitToSession = deps.bus.emitToSession.bind(deps.bus);
    vi.spyOn(deps.bus, "emitToSession").mockImplementation((sessionKey, payload) => {
      if ((payload as { type?: string }).type === "session_compacted") {
        throw new Error("subscriber failed after recovery");
      }
      emitToSession(sessionKey, payload);
    });

    let starts = 0;
    harnessRef.startFnOverride = () => {
      starts += 1;
      const events =
        starts === 1
          ? ([
              { kind: "init", sessionId: "old-thread", model: "sonnet" },
              { kind: "text", role: "assistant", text: "Ready to continue." },
              { kind: "done", reason: "stop" },
            ] satisfies NormalizedEvent[])
          : ([
              { kind: "init", sessionId: "new-thread", model: "sonnet" },
              { kind: "done", reason: "stop" },
            ] satisfies NormalizedEvent[]);
      return { events: (async function* () { for (const event of events) yield event; })(), control: { abort: () => {} } };
    };

    await host.start({ sessionKey: host.id, prompt: "p", cwd: host.cwd, role: "leader", resumeId: "old-thread" }, deps);

    expect(starts).toBe(2);
    expect(host.status).toBe("idle");
    expect(
      db.prepare("SELECT status FROM sessions WHERE session_key = ?").get(host.id),
    ).toEqual({ status: "idle" });
  });

  it("auto-compacts at the force threshold on the next idle boundary", async () => {
    const { host, deps } = makeHarness("leader-force");
    host.proactiveCompaction.setting = "auto";
    host.proactiveCompaction.settingResolved = true;
    let starts = 0;
    harnessRef.startFnOverride = () => {
      starts += 1;
      const events =
        starts === 1
          ? ([
              { kind: "init", sessionId: "old-force", model: "sonnet" },
              { kind: "usage", input: 160_000, output: 1 },
              { kind: "done", reason: "stop" },
            ] satisfies NormalizedEvent[])
          : ([
              { kind: "init", sessionId: "new-force", model: "sonnet" },
              { kind: "done", reason: "stop" },
            ] satisfies NormalizedEvent[]);
      return { events: (async function* () { for (const event of events) yield event; })(), control: { abort: () => {} } };
    };

    await host.start({ sessionKey: host.id, prompt: "p", cwd: host.cwd, role: "leader", resumeId: "old-force" }, deps);

    expect(starts).toBe(2);
    const secondStart = harnessRef.starts[1] as { resumeId?: string; prompt: string };
    expect(secondStart.resumeId).toBeUndefined();
    expect(secondStart.prompt).toContain("Automatic checkpoint");
  });

  it("preserves prior session metrics when an error occurs", async () => {
    const { host, deps } = makeHarness();
    host.totalCost = 1.23;
    host.turns = 7;

    harnessRef.startFnOverride = () => ({
      events: (async function* () {
        throw new Error("network");
      })(),
      control: { abort: () => {} },
    });

    await host.start(
      { sessionKey: host.id, prompt: "p", cwd: host.cwd },
      deps,
    );

    expect(host.totalCost).toBe(1.23);
    expect(host.turns).toBe(7);
  });
});

function taskToolCtx(leaderSessionKey: string): TaskToolContext {
  return {
    leaderSessionKey,
    bus: {} as never,
    startMinionSession() {},
    cwd: "/tmp/fake-cwd",
    projectPath: "/tmp/fake-cwd",
    minionSystemPrompt: "minion",
    taskState: { tasks: new Map(), pendingWait: null, approval: null },
    scheduleWaitContinue() {},
  };
}

describe("SessionHost.start — abort", () => {
  it("breaks out of the for-await loop when the abort controller fires mid-stream", async () => {
    const { host, deps, envelopes } = makeHarness();

    // Queue five events; abort after the second is consumed so "second",
    // "third", and "done" never reach processNormalizedEvent.
    let consumed = 0;
    harnessRef.startFnOverride = () => {
      const events = (async function* () {
        const msgs: NormalizedEvent[] = [
          { kind: "init", sessionId: "s", model: "" },
          { kind: "text", text: "first", role: "assistant" },
          { kind: "text", text: "second", role: "assistant" },
          { kind: "text", text: "third", role: "assistant" },
          { kind: "done", reason: "stop" },
        ];
        for (const m of msgs) {
          yield m;
          consumed += 1;
          if (consumed === 2) {
            host.abortController.abort();
          }
        }
      })();
      return { events, control: { abort: () => {} } };
    };

    await host.start(
      { sessionKey: host.id, prompt: "p", cwd: host.cwd },
      deps,
    );

    // We consumed init + first assistant; then aborted. "second", "third",
    // and "done" never reached the bus.
    // init → sdk_event #1; text "first" → sdk_event #2.
    const sdkEvents = envelopes.filter((e) => e.type === "sdk_event");
    expect(sdkEvents).toHaveLength(2);
    // No idle status — abort short-circuits before done.
    const statuses = envelopes
      .filter((e) => e.type === "session_status")
      .map((e) => e.payload["status"]);
    expect(statuses).toEqual(["running"]);
    // status stays "running" because no done and no throw fired.
    expect(host.status).toBe("running");
  });
});

describe("SessionHost.bufferEvent — retention cap", () => {
  it("trims to the most recent MAX_BUFFERED_EVENTS when the buffer grows past the cap", async () => {
    const { host } = makeHarness();
    const { MAX_BUFFERED_EVENTS } = await import("./session-host-config.ts");

    for (let i = 0; i < MAX_BUFFERED_EVENTS + 50; i++) {
      host.bufferEvent({
        type: "sdk_event",
        sessionKey: host.id,
        message: { seq: i },
        timestamp: i,
      });
    }

    expect(host.eventBuffer).toHaveLength(MAX_BUFFERED_EVENTS);
    // Oldest 50 dropped — the first surviving entry should be seq=50.
    expect(
      (host.eventBuffer[0]?.message as { seq: number }).seq,
    ).toBe(50);
    expect(
      (host.eventBuffer.at(-1)?.message as { seq: number }).seq,
    ).toBe(MAX_BUFFERED_EVENTS + 49);
  });
});

describe("SessionHost.clearWaitTimer", () => {
  it("clears an active wait timer and is idempotent on a clean host", () => {
    const { host } = makeHarness();
    expect(host.waitTimerId).toBeNull();

    host.waitTimerId = setTimeout(() => {
      throw new Error("timer should have been cleared");
    }, 100);
    expect(host.waitTimerId).not.toBeNull();

    host.clearWaitTimer();
    expect(host.waitTimerId).toBeNull();

    // Calling on an already-clean host is a no-op.
    host.clearWaitTimer();
    expect(host.waitTimerId).toBeNull();
  });
});

describe("SessionHost.start — role + agent context", () => {
  it("uses the role passed in opts, falling back to the host's existing role", async () => {
    const { host, deps } = makeHarness();

    harnessRef.events = [
      { kind: "init", sessionId: "s", model: "" },
      { kind: "done", reason: "stop" },
    ];

    await host.start(
      { sessionKey: host.id, prompt: "p", cwd: host.cwd, role: "default" },
      deps,
    );
    expect(host.role).toBe("default");

    // No role in opts — sticks with what was set last time.
    harnessRef.events = [
      { kind: "init", sessionId: "s2", model: "" },
      { kind: "done", reason: "stop" },
    ];
    await host.start({ sessionKey: host.id, prompt: "p2", cwd: host.cwd }, deps);
    expect(host.role).toBe("default");
  });

  it("clears the wait timer at the start of a new run", async () => {
    const { host, deps } = makeHarness();
    let timerFired = false;
    host.waitTimerId = setTimeout(() => {
      timerFired = true;
    }, 1);

    harnessRef.events = [
      { kind: "init", sessionId: "s", model: "" },
      { kind: "done", reason: "stop" },
    ];
    await host.start({ sessionKey: host.id, prompt: "p", cwd: host.cwd }, deps);

    // Wait one macrotask; if the timer survived start(), it would have fired.
    await new Promise((r) => setTimeout(r, 5));
    expect(timerFired).toBe(false);
    expect(host.waitTimerId).toBeNull();
  });

  it("reports an unknown role as a session error instead of rejecting", async () => {
    const { host, deps, envelopes } = makeHarness();

    await expect(
      host.start(
        {
          sessionKey: host.id,
          prompt: "p",
          cwd: host.cwd,
          role: "missing-agent" as never,
        },
        deps,
      ),
    ).resolves.toBeUndefined();

    expect(host.status).toBe("error");
    expect(host.lastError).toMatch(/Unknown agent type "missing-agent"/);
    expect(envelopes).toContainEqual(
      expect.objectContaining({
        topic: `session:${host.id}`,
        type: "session_error",
        payload: expect.objectContaining({
          sessionKey: host.id,
          error: expect.stringMatching(/Unknown agent type "missing-agent"/),
        }),
      }),
    );
  });
});

// ── Bug-regression: concurrent-run guard (Bug 1) ─────────────────────────────

describe("SessionHost.start — concurrent-run guard", () => {
  it("silently ignores a second start() call while a run is already active", async () => {
    const { host, deps, envelopes } = makeHarness();

    // Promise whose resolution unblocks the first run's stream.
    let releaseFirst!: () => void;
    const firstBlocker = new Promise<void>((r) => {
      releaseFirst = r;
    });

    harnessRef.startFnOverride = () => ({
      events: (async function* () {
        yield { kind: "init", sessionId: "s1", model: "" } as NormalizedEvent;
        await firstBlocker;
        yield { kind: "done", reason: "stop" } as NormalizedEvent;
      })(),
      control: { abort: () => {} },
    });

    // Kick off the first run without awaiting — status becomes "running"
    // synchronously (before the first internal await).
    const firstRun = host.start(
      { sessionKey: host.id, prompt: "first", cwd: host.cwd },
      deps,
    );

    // status is "running" synchronously at this point.
    expect(host.status).toBe("running");

    // Second call while first run is still blocked — guard fires, returns immediately.
    await host.start(
      { sessionKey: host.id, prompt: "second", cwd: host.cwd },
      deps,
    );

    // Unblock and finish the first run.
    releaseFirst();
    await firstRun;

    // Only one harness.start() invocation — the second call was rejected.
    expect(harnessRef.starts).toHaveLength(1);
    expect(host.status).toBe("idle");

    // Only one "running" status broadcast.
    const runningEvents = envelopes.filter(
      (e) => e.type === "session_status" && e.payload["status"] === "running",
    );
    expect(runningEvents).toHaveLength(1);
  });
});

// ── Bug-regression: worktree isolation preserved on resume (Bug 2) ────────────

describe("SessionHost.start — worktree isolation preservation", () => {
  it("keeps worktreeIsolation=true when opts.worktreeIsolation is not provided (resume path)", async () => {
    const { host, deps } = makeHarness();
    host.worktreeIsolation = true; // set at session-creation time

    harnessRef.events = [
      { kind: "init", sessionId: "s", model: "" },
      { kind: "done", reason: "stop" },
    ];

    // Resume: start() called without the worktreeIsolation option.
    await host.start(
      { sessionKey: host.id, prompt: "resume turn", cwd: host.cwd },
      deps,
    );

    // Isolation must NOT have been silently cleared.
    expect(host.worktreeIsolation).toBe(true);
  });

  it("updates worktreeIsolation when the option is explicitly provided", async () => {
    const { host, deps } = makeHarness();
    host.worktreeIsolation = false;

    harnessRef.events = [
      { kind: "init", sessionId: "s", model: "" },
      { kind: "done", reason: "stop" },
    ];

    await host.start(
      {
        sessionKey: host.id,
        prompt: "first turn",
        cwd: host.cwd,
        worktreeIsolation: true,
      },
      deps,
    );

    expect(host.worktreeIsolation).toBe(true);
  });
});

// ── Bug-regression: abort/error conflation (Bug 3) ───────────────────────────

describe("SessionHost.start — abort/error distinction", () => {
  it("does not emit session_error when the harness throws after the abort signal fires", async () => {
    const { host, deps, envelopes } = makeHarness();

    // Simulate: harness throws (e.g. an AbortError) AFTER the controller was
    // already set. This used to land in the catch block and surface as a
    // session_error event even though the run was intentionally stopped.
    harnessRef.startFnOverride = () => ({
      events: (async function* () {
        yield { kind: "init", sessionId: "s", model: "" } as NormalizedEvent;
        host.abortController.abort(); // signal fires
        throw new Error("The operation was aborted"); // harness propagates it
      })(),
      control: { abort: () => {} },
    });

    await host.start(
      { sessionKey: host.id, prompt: "p", cwd: host.cwd },
      deps,
    );

    // Must NOT surface as an error event — it was an intentional abort.
    expect(envelopes.filter((e) => e.type === "session_error")).toHaveLength(0);
    expect(host.status).not.toBe("error");
  });
});
