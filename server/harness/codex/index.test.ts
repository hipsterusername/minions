import { dispatchMethod } from "../../mcp-bridge/dispatch.ts";

import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod/v4";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  HarnessStartOptions,
  NormalizedToolDef,
  NormalizedEvent,
} from "../types.ts";
import { terminalProvenance } from "../terminal-provenance.ts";
import { SessionHost } from "../../session-host.ts";
import { createBus } from "../../bus.ts";
import { openPersistDb, closePersistDb } from "../../session-persist.ts";
import { createWorkItem, startWorkItemIteration, getWorkItemRun } from "../../work-item-repo.ts";
import { createSqliteWorkItemService } from "../../work-item-service-sqlite.ts";
import { createWorkItemRuntimeLifecycle } from "../../work-item-runtime-lifecycle.ts";
import { TaskGraphService } from "../../task-graph/service.ts";
import type { TaskGraphPlanningCoordinator } from "../../task-graph/planning-coordinator.ts";
import "../../agents/index.ts";

const sdkMock = vi.hoisted(() => {
  type ThreadStub = {
    id: string | null;
    runStreamed: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };
  const calls = {
    constructor: [] as unknown[],
    startThread: [] as unknown[],
    resumeThread: [] as Array<{ id: string; opts: unknown }>,
    runStreamed: [] as Array<{ input: unknown; turnOpts: unknown }>,
  };
  let nextEvents: AsyncIterable<unknown> | null = null;
  const lastSignals: Array<AbortSignal | undefined> = [];

  class Codex {
    constructor(o?: unknown) {
      calls.constructor.push(o);
    }
    startThread(opts?: unknown): ThreadStub {
      calls.startThread.push(opts);
      return makeThread();
    }
    resumeThread(id: string, opts?: unknown): ThreadStub {
      calls.resumeThread.push({ id, opts });
      return makeThread();
    }
  }

  function makeThread(): ThreadStub {
    return {
      id: null,
      runStreamed: vi.fn(async (input: unknown, turnOpts?: { signal?: AbortSignal }) => {
        calls.runStreamed.push({ input, turnOpts: turnOpts ?? null });
        lastSignals.push(turnOpts?.signal);
        const events = nextEvents ?? emptyAsync();
        return { events };
      }),
      run: vi.fn(),
    };
  }

  async function* emptyAsync(): AsyncGenerator<unknown> {
    /* nothing */
  }

  return {
    Codex,
    calls,
    setNextEvents(events: AsyncIterable<unknown>): void {
      nextEvents = events;
    },
    lastSignal(): AbortSignal | undefined {
      return lastSignals[lastSignals.length - 1];
    },
    reset(): void {
      calls.constructor.length = 0;
      calls.startThread.length = 0;
      calls.resumeThread.length = 0;
      calls.runStreamed.length = 0;
      lastSignals.length = 0;
      nextEvents = null;
    },
  };
});

vi.mock("@openai/codex-sdk", () => ({ Codex: sdkMock.Codex }));

const bridgeMock = vi.hoisted(() => {
  const calls = {
    register: [] as Array<{ sessionKey: string; groups: Record<string, unknown> }>,
    dispose: [] as string[],
  };

  return {
    calls,
    server: {
      url: "http://127.0.0.1:0",
      register(opts: { sessionKey: string; groups: Record<string, unknown> }) {
        calls.register.push(opts);
        const sessionKey = opts.sessionKey;
        return {
          sessionKey,
          bearerToken: `tok-${sessionKey}`,
          urlFor: (group: string) =>
            `http://127.0.0.1:9999/mcp/${sessionKey}/${group}`,
          dispose: () => {
            calls.dispose.push(sessionKey);
          },
        };
      },
      dispose: async (): Promise<void> => undefined,
    },
    reset(): void {
      calls.register.length = 0;
      calls.dispose.length = 0;
    },
  };
});

vi.mock("../../mcp-bridge/server.ts", () => ({
  getBridgeServer: async () => bridgeMock.server,
}));

import { buildCodexEnv } from "./env.ts";
import { codexHarness } from "./index.ts";

function baseOpts(over: Partial<HarnessStartOptions> = {}): HarnessStartOptions {
  const ac = new AbortController();
  return {
    sessionKey: "session-1",
    cwd: "/tmp/work",
    prompt: "do the thing",
    systemPrompt: "you are codex",
    model: "gpt-5.6-sol",
    allowedTools: [],
    abortSignal: ac.signal,
    ...over,
  };
}

function toolDef(name: string): NormalizedToolDef {
  return {
    name,
    description: `${name} description`,
    inputSchema: z.object({ value: z.string() }),
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

async function collect(
  iter: AsyncIterable<NormalizedEvent>,
): Promise<NormalizedEvent[]> {
  const out: NormalizedEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

async function* eventStream(events: unknown[]): AsyncGenerator<unknown> {
  for (const e of events) yield e;
}

beforeEach(() => {
  sdkMock.reset();
  bridgeMock.reset();
  // Snapshot of the sequence of events the next runStreamed call yields.
  sdkMock.setNextEvents(
    eventStream([
      { type: "thread.started", thread_id: "th-001" },
      {
        type: "item.completed",
        item: { id: "m1", type: "agent_message", text: "hi" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 7,
          output_tokens: 11,
          cached_input_tokens: 3,
          cache_write_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ]),
  );
});

describe("CodexHarness.start()", () => {
  it("emits init, text, usage, and exactly one terminal done in order", async () => {
    const { events, control } = codexHarness.start(baseOpts());
    expect(typeof control.abort).toBe("function");
    const out = await collect(events);
    expect(out.map((e) => e.kind)).toEqual(["init", "text", "usage", "done"]);
    expect(out[0]).toMatchObject({ kind: "init", sessionId: "th-001", model: "gpt-5.6-sol" });
    expect(out[1]).toMatchObject({ kind: "text", role: "assistant", text: "hi" });
    expect(out[2]).toMatchObject({
      kind: "usage",
      input: 4,
      output: 11,
      cacheRead: 3,
      cacheCreation: 0,
    });
    expect((out[2] as Extract<NormalizedEvent, { kind: "usage" }>).costUSD)
      .toBeCloseTo(0.0002372, 10);
    expect(out[3]).toMatchObject({ kind: "done", reason: "completed", result: "hi" });
    expect(terminalProvenance(out[3] as Extract<NormalizedEvent, { kind: "done" }>))
      .toBe("adapter");
  });

  it("emits done(reason: stop) when the stream ends without turn.completed", async () => {
    sdkMock.setNextEvents(eventStream([
      { type: "thread.started", thread_id: "th-incomplete" },
    ]));
    const out = await collect(codexHarness.start(baseOpts()).events);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ kind: "done", reason: "stop" });
  });

  it("uses startThread when resumeId is absent", async () => {
    const systemPrompt = "SYSTEM_PROMPT_SENTINEL_START";
    const out = await collect(codexHarness.start(baseOpts({ systemPrompt })).events);
    expect(out[0]?.kind).toBe("init");
    expect(sdkMock.calls.startThread).toHaveLength(1);
    expect(sdkMock.calls.resumeThread).toHaveLength(0);
    expect(
      (sdkMock.calls.constructor[0] as {
        config?: Record<string, unknown>;
      }).config?.["developer_instructions"],
    ).toBe(systemPrompt);
  });

  it("skips Codex's git repo trust check for Minions-selected projects", async () => {
    await collect(codexHarness.start(baseOpts()).events);
    const startThreadOpts = sdkMock.calls.startThread[0] as {
      workingDirectory?: string;
      skipGitRepoCheck?: boolean;
    };
    expect(startThreadOpts.workingDirectory).toBe("/tmp/work");
    expect(startThreadOpts.skipGitRepoCheck).toBe(true);
  });

  it("uses resumeThread when resumeId is provided", async () => {
    const systemPrompt = "SYSTEM_PROMPT_SENTINEL_RESUME";
    await collect(
      codexHarness.start(baseOpts({ resumeId: "th-prev", systemPrompt })).events,
    );
    expect(sdkMock.calls.startThread).toHaveLength(0);
    expect(sdkMock.calls.resumeThread).toHaveLength(1);
    expect(sdkMock.calls.resumeThread[0]?.id).toBe("th-prev");
    expect(
      (sdkMock.calls.resumeThread[0]?.opts as { skipGitRepoCheck?: boolean })
        .skipGitRepoCheck,
    ).toBe(true);
    expect(
      (sdkMock.calls.constructor[0] as {
        config?: Record<string, unknown>;
      }).config?.["developer_instructions"],
    ).toBe(systemPrompt);
  });

  it("adds a resumed invocation estimate to the existing session cost", async () => {
    const out = await collect(codexHarness.start(baseOpts({
      resumeId: "th-existing",
      initialCostUSD: 0.1,
    })).events);
    const usage = out.find((event) => event.kind === "usage");

    expect(usage?.costUSD).toBeCloseTo(0.1002372, 10);
  });

  it("omits developer_instructions when systemPrompt is undefined", async () => {
    await collect(
      codexHarness.start(baseOpts({ systemPrompt: undefined })).events,
    );
    const constructorOpts = sdkMock.calls.constructor[0] as {
      config?: Record<string, unknown>;
    };
    expect(constructorOpts).not.toHaveProperty("config");
  });

  it("emits done(reason: error) when runStreamed throws synchronously", async () => {
    sdkMock.setNextEvents(
      (async function* () {
        yield { type: "thread.started", thread_id: "th-err" };
        throw new Error("boom");
      })(),
    );
    const out = await collect(codexHarness.start(baseOpts()).events);
    const last = out[out.length - 1];
    expect(last).toMatchObject({ kind: "done", reason: "error", error: "boom" });
    expect(terminalProvenance(last as Extract<NormalizedEvent, { kind: "done" }>))
      .toBe("adapter");
  });

  it("attaches prior stream errors to fullError when the stream later throws", async () => {
    sdkMock.setNextEvents(
      (async function* () {
        yield { type: "error", message: "Reconnecting... 1/5" };
        throw new Error("Codex Exec exited with code 1: stderr detail");
      })(),
    );
    const out = await collect(codexHarness.start(baseOpts()).events);
    expect(out.filter((e) => e.kind === "done")).toHaveLength(1);
    const last = out[out.length - 1] as { fullError?: string };
    expect(last.fullError).toContain("Codex Exec exited with code 1");
    expect(last.fullError).toContain("Reconnecting... 1/5");
  });

  it("keeps the invocation open across reconnects and waits for writer release before completion", async () => {
    let writerActive = true;
    sdkMock.setNextEvents((async function* () {
      try {
        yield { type: "thread.started", thread_id: "th-reconnect" };
        yield { type: "error", message: "Reconnecting... 2/5 (stream disconnected before completion: websocket closed by server before response.completed)" };
        yield { type: "item.started", item: { id: "cmd1", type: "command_execution", command: "echo recovered", status: "in_progress" } };
        yield { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Recovered successfully" } };
        yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
      } finally {
        writerActive = false;
      }
    })());
    const out: NormalizedEvent[] = [];
    for await (const event of codexHarness.start(baseOpts({ resumeId: "th-reconnect" })).events) {
      if (event.kind === "done") expect(writerActive).toBe(false);
      out.push(event);
    }
    expect(out.map((e) => e.kind)).toEqual(["init", "api_retry", "tool_call", "text", "usage", "done"]);
    expect(out.at(-1)).toMatchObject({ kind: "done", reason: "completed", result: "Recovered successfully" });
  });

  it.each(["turn.failed", "error"])("defers %s until the writer exits and emits exactly one terminal", async (type) => {
    let writerActive = true;
    sdkMock.setNextEvents((async function* () {
      try {
        yield { type: "thread.started", thread_id: "th-failed" };
        yield type === "turn.failed"
          ? { type, error: { message: "Model context window exceeded" } }
          : { type, message: "Model context window exceeded" };
        // The SDK may emit both the failure event and a nonzero process exit.
        throw new Error("Codex Exec exited with code 1: shutdown detail");
      } finally {
        writerActive = false;
      }
    })());
    const out: NormalizedEvent[] = [];
    for await (const event of codexHarness.start(baseOpts()).events) {
      if (event.kind === "done") expect(writerActive).toBe(false);
      out.push(event);
    }
    expect(out.map((e) => e.kind)).toEqual(["init", "done"]);
    expect(out.at(-1)).toMatchObject({ kind: "done", reason: "error", error: "Model context window exceeded" });
    const last = out.at(-1) as Extract<NormalizedEvent, { kind: "done" }>;
    expect(last.fullError).toContain("shutdown detail");
  });

  it("retains a fatal stream error on clean EOF and suppresses later activity", async () => {
    sdkMock.setNextEvents(eventStream([
      { type: "error", message: "Fatal stream error" },
      { type: "item.completed", item: { id: "late", type: "agent_message", text: "stale activity" } },
    ]));
    expect(await collect(codexHarness.start(baseOpts()).events)).toEqual([
      expect.objectContaining({ kind: "done", reason: "error", error: "Fatal stream error" }),
    ]);
  });

  it("reports an unsuccessful reconnect on EOF without marking the run successful", async () => {
    sdkMock.setNextEvents(eventStream([{ type: "error", message: "Reconnecting... 5/5" }]));
    const out = await collect(codexHarness.start(baseOpts()).events);
    expect(out.map((e) => e.kind)).toEqual(["api_retry", "done"]);
    expect(out.at(-1)).toMatchObject({ kind: "done", reason: "error", error: "Reconnecting... 5/5" });
  });

  it("keeps an intentional abort during reconnect distinct from failure", async () => {
    sdkMock.setNextEvents((async function* () {
      yield { type: "error", message: "Reconnecting... 2/5" };
      throw new Error("AbortError from SDK cleanup");
    })());
    const { events, control } = codexHarness.start(baseOpts());
    const out: NormalizedEvent[] = [];
    for await (const event of events) {
      out.push(event);
      if (event.kind === "api_retry") control.abort();
    }
    expect(out.map((e) => e.kind)).toEqual(["api_retry", "done"]);
    expect(out.at(-1)).toMatchObject({ kind: "done", reason: "abort" });
  });

  it.each(["abort", "windows-cleanup"])("preserves a witnessed turn failure through %s", async (cleanup) => {
    const ac = new AbortController();
    sdkMock.setNextEvents((async function* () {
      yield { type: "turn.failed", error: { message: "Provider failed" } };
      if (cleanup === "abort") ac.abort();
      throw new Error(cleanup === "abort" ? "AbortError from SDK cleanup"
        : "Failed to parse item: SUCCESS: The process with PID 2596 (child process of PID 14044) has been terminated.");
    })());
    const out = await collect(codexHarness.start(baseOpts({ abortSignal: ac.signal })).events);
    expect(out).toEqual([expect.objectContaining({ kind: "done", reason: "error", error: "Provider failed" })]);
  });

  it("keeps the durable leader and graph usable after reconnect and refuses a competing iteration", async () => {
    const db = openPersistDb(":memory:");
    const bus = createBus({ clients: new Set() } as never);
    const host = new SessionHost("primary", "/tmp");
    const service = createSqliteWorkItemService({ db, bus, launchRun: vi.fn(), continueRun: vi.fn(),
      generateKey: (kind, id) => `${kind}-${id}` });
    const lifecycle = createWorkItemRuntimeLifecycle({ db, bus, service });
    const terminal = vi.spyOn(lifecycle, "runTerminal");
    const children = { startChildRun: vi.fn(async (input) => ({
      runKey: "child", workItemId: "work", runKind: "child" as const,
      parentRunKey: "primary", taskId: input.taskId, attemptId: input.attemptId,
      attemptNumber: input.attemptNumber, runNumber: null, previousRunKey: null,
      providerSessionId: null, outcome: "none" as const, startedAt: Date.now(), endedAt: null, finalReport: null,
    })) };
    const graph = new TaskGraphService({ db, bus, children });
    let checkedWhileReconnecting = false;
    let writerActive = true;
    const terminalWriterStates: boolean[] = [];
    try {
      createWorkItem(db, { id: "work", projectId: "p", projectPath: "/tmp", title: "Reconnect", changeMode: "live", at: 1 });
      startWorkItemIteration(db, { workItemId: "work", runKey: "primary", idempotencyKey: "start",
        expectedLifecycleRevision: 0, expectedCurrentRunKey: null, at: 2 });
      sdkMock.setNextEvents((async function* () {
        try {
          yield { type: "thread.started", thread_id: "th-live" };
          yield { type: "error", message: "Reconnecting... 2/5 (stream disconnected before completion: websocket closed by server before response.completed)" };
          expect(host.status).toBe("running");
          expect(getWorkItemRun(db, "primary")).toMatchObject({ ended_at: null, run_outcome: "none" });
          expect(terminal).not.toHaveBeenCalled();
          const current = service.getSync("work")!.workItem;
          expect(() => startWorkItemIteration(db, { workItemId: "work", runKey: "competing",
            idempotencyKey: "competing", expectedLifecycleRevision: current.lifecycle.lifecycleRevision,
            expectedCurrentRunKey: "primary", at: 3 })).toThrow();
          graph.createRevision({ definitionId: "definition", revisionId: "revision", workItemId: "work",
            workspaceId: "workspace", objective: "Stay usable", acceptanceCriteria: ["scheduled"],
            nonGoals: [], constraints: [], terminalNodeIds: ["node"], maxActiveAttempts: 1, edges: [],
            nodes: [{ id: "node", title: "Node", objective: "Do it", inputBindings: {}, outputSchemas: {},
              constraints: [], acceptanceCriteria: ["done"], executorClass: "standard", allowedHarnesses: ["codex"],
              allowedTools: [], ownershipRequest: [], budgetRequest: {}, timeoutMs: 30_000,
              retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableOutcomes: [], jitterMs: 0 },
              verificationRequired: false, failurePolicy: "fail_graph", expansionPolicy: null }],
          }, 4);
          const hash = `sha256:${"a".repeat(64)}`;
          graph.repo.startRun({ id: "graph", workItemId: "work", primaryRunKey: "primary", revisionId: "revision",
            expectedLifecycleRevision: current.lifecycle.lifecycleRevision, at: Date.now(), sourceSnapshot: {
              id: "source", workItemId: "work", primaryRunKey: "primary", taskGraphRevisionId: "revision",
              repositoryBaseCommit: "abc", dirtyDiffDigest: hash, workspaceId: "workspace", worktreeIdentity: "wt",
              systemModelDigest: hash, workPacketRevisionId: null, connectedContext: [], compiledSkills: [],
              harnessPolicyDigest: hash, toolPolicyDigest: hash, createdAt: Date.now(),
            } });
          expect((await graph.tick("graph")).run.status).toBe("active");
          expect(children.startChildRun).toHaveBeenCalledOnce();
          checkedWhileReconnecting = true;
          yield { type: "item.completed", item: { id: "final", type: "agent_message", text: "Recovered" } };
          yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
        } finally {
          writerActive = false;
        }
      })());
      bus.subscribe((event) => {
        if (event.type === "session_error" || (event.type === "session_status" && event["status"] === "idle")) {
          terminalWriterStates.push(writerActive);
        }
      });
      await host.start({ sessionKey: "primary", workItemId: "work", cwd: "/tmp", prompt: "Continue",
        harness: "codex", role: "leader", resumeId: "th-live" }, {
        bus, startChildSession: vi.fn(), forEachLeaderTaskState: vi.fn(), workItemLifecycle: lifecycle,
        getTaskGraphPlanning: () => ({} as TaskGraphPlanningCoordinator),
      });
      expect(checkedWhileReconnecting, host.lastError ?? undefined).toBe(true);
      expect(terminalWriterStates).toEqual([false]);
      expect(terminal).toHaveBeenCalledOnce();
      expect(getWorkItemRun(db, "primary")).toMatchObject({ run_outcome: "completed", final_report: "Recovered" });
      expect(db.prepare("SELECT terminal_kind FROM run_invocations WHERE run_key = 'primary'").all())
        .toEqual([{ terminal_kind: "clean" }]);
    } finally {
      closePersistDb();
    }
  });

  it("preserves completed when Windows taskkill success output follows turn completion", async () => {
    sdkMock.setNextEvents(
      (async function* () {
        yield { type: "thread.started", thread_id: "th-win-cleanup" };
        yield {
          type: "item.completed",
          item: { id: "m1", type: "agent_message", text: "done" },
        };
        yield {
          type: "turn.completed",
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            reasoning_output_tokens: 0,
          },
        };
        throw new Error(
          "Failed to parse item: SUCCESS: The process with PID 2596 (child process of PID 14044) has been terminated.",
        );
      })(),
    );
    const out = await collect(codexHarness.start(baseOpts()).events);
    expect(out.map((e) => e.kind)).toEqual(["init", "text", "usage", "done"]);
    expect(out[out.length - 1]).toMatchObject({ kind: "done", reason: "completed" });
    expect(
      out.some((e) => e.kind === "done" && (e as { reason?: string }).reason === "error"),
    ).toBe(false);
  });

  it("emits done(reason: abort) when control.abort fires before iteration ends", async () => {
    const ac = new AbortController();
    // A stream that pauses indefinitely on the second event.
    sdkMock.setNextEvents(
      (async function* () {
        yield { type: "thread.started", thread_id: "th-abort" };
        // Wait until aborted.
        while (!ac.signal.aborted) {
          await new Promise((r) => setTimeout(r, 5));
        }
      })(),
    );
    const { events, control } = codexHarness.start(baseOpts({ abortSignal: ac.signal }));
    // Kick off the iteration but don't await the full result.
    const collected: NormalizedEvent[] = [];
    const iter = (async () => {
      for await (const ev of events) collected.push(ev);
    })();
    // Give the generator a tick to begin.
    await new Promise((r) => setTimeout(r, 10));
    control.abort();
    ac.abort();
    await iter;
    expect(collected[0]?.kind).toBe("init");
    expect(collected[collected.length - 1]).toMatchObject({
      kind: "done",
      reason: "abort",
    });
  });
});

describe("CodexHarness MCP bridge", () => {
  it("fails explicitly when external project MCP configuration is supplied", async () => {
    const out = await collect(codexHarness.start(baseOpts({
      externalMcpServers: { filesystem: { type: "stdio", command: "node" } },
    })).events);
    expect(out).toEqual([
      expect.objectContaining({
        kind: "done",
        reason: "error",
        error: expect.stringContaining("not supported by harness \"codex\""),
      }),
    ]);
    expect(sdkMock.calls.constructor).toHaveLength(0);
    expect(bridgeMock.calls.register).toHaveLength(0);
  });

  it("registers, exposes, and disposes bridge groups when tools are present", async () => {
    codexHarness.registerTools({
      "task-manager": [toolDef("plan_task"), toolDef("assign_task")],
      empty: [],
    });
    await collect(codexHarness.start(baseOpts({ sessionKey: "abc", allowedTools: ["mcp__task-manager__plan_task"] })).events);

    expect(bridgeMock.calls.register).toHaveLength(1);
    expect(bridgeMock.calls.register[0]?.sessionKey).toBe("abc");
    expect(Object.keys(bridgeMock.calls.register[0]?.groups ?? {})).toEqual([
      "task-manager",
      "empty",
    ]);
    expect(bridgeMock.calls.dispose).toEqual(["abc"]);
    const bridgeTools = bridgeMock.calls.register[0]?.groups["task-manager"] as NormalizedToolDef[];
    const denied = await dispatchMethod({ jsonrpc:"2.0", id:1, method:"tools/call",
      params:{name:"assign_task",arguments:{}} }, bridgeTools);
    expect(denied).toHaveProperty("error");
    expect((bridgeMock.calls.register[0]?.groups["task-manager"] as NormalizedToolDef[]).map(tool => tool.name)).toEqual(["plan_task"]);

    // Codex constructor receives a config + env that reference the registered group.
    const constructorOpts = sdkMock.calls.constructor[0] as {
      env?: Record<string, string>;
      config?: Record<string, unknown>;
    };
    expect(constructorOpts.config?.["mcp_servers.task-manager"]).toMatchObject({
      url: expect.stringContaining("/mcp/abc/task-manager"),
      bearer_token_env_var: "MINIONS_BRIDGE_TOKEN_TASK_MANAGER",
    });
    expect(constructorOpts.env?.["MINIONS_BRIDGE_TOKEN_TASK_MANAGER"]).toBe("tok-abc");
  });

  it("does not register the bridge when no tool groups are non-empty", async () => {
    codexHarness.registerTools({});
    await collect(codexHarness.start(baseOpts({ sessionKey: "x" })).events);
    expect(bridgeMock.calls.register).toHaveLength(0);
    expect(bridgeMock.calls.dispose).toHaveLength(0);
  });
});

describe("CodexHarness static info", () => {
  it("reports openai provider and codex models", () => {
    const info = codexHarness.staticInfo();
    expect(info.account).toMatchObject({ provider: "openai" });
    expect(info.models.length).toBeGreaterThan(0);
    expect(info.models[0]).toHaveProperty("id");
    expect(info.models[0]).toHaveProperty("label");
  });

  it("declares the expected capabilities", () => {
    expect(codexHarness.capabilities).toMatchObject({
      mutationInterception: "observe_only",
      thinking: true,
      mcp: true,
      resume: true,
      partialMessages: false,
      builtInFilesystem: true,
    });
  });
});

describe("CodexHarness attachments", () => {
  it("forwards image attachments as local_image inputs to runStreamed", async () => {
    codexHarness.registerTools({});
    const data = Buffer.from([1, 2, 3, 4]).toString("base64");
    await collect(
      codexHarness.start(
        baseOpts({
          sessionKey: "att-1",
          attachments: [{ kind: "image", mediaType: "image/png", data }],
        }),
      ).events,
    );
    const call = sdkMock.calls.runStreamed[0];
    expect(call).toBeDefined();
    expect(Array.isArray(call?.input)).toBe(true);
    const inputs = call?.input as Array<{ type: string; path?: string; text?: string }>;
    expect(inputs[0]).toMatchObject({ type: "text" });
    expect(inputs[1]).toMatchObject({ type: "local_image" });
    expect(inputs[1]?.path).toMatch(/minions-codex-attachments[/\\]att-1[/\\]/);
  });
});

describe("CodexHarness permission mode", () => {
  it("does not let bypassPermissions silently broaden filesystem access", async () => {
    codexHarness.registerTools({});
    await collect(
      codexHarness.start(baseOpts({ permissionMode: "bypassPermissions" })).events,
    );
    const startThreadOpts = sdkMock.calls.startThread[0] as {
      approvalPolicy?: string;
      sandboxMode?: string;
    };
    expect(startThreadOpts.approvalPolicy).toBe("never");
    expect(startThreadOpts.sandboxMode).toBe("read-only");
  });

  it("uses the auto fallback when permissionMode is omitted", async () => {
    codexHarness.registerTools({});
    await collect(codexHarness.start(baseOpts()).events);
    const startThreadOpts = sdkMock.calls.startThread[0] as {
      approvalPolicy?: string;
      sandboxMode?: string;
    };
    expect(startThreadOpts.approvalPolicy).toBe("on-failure");
    expect(startThreadOpts.sandboxMode).toBe("read-only");
  });

  it("maps plan mode to a read-only sandbox and opens a thread", async () => {
    codexHarness.registerTools({});
    const out = await collect(
      codexHarness.start(baseOpts({ permissionMode: "plan" })).events,
    );
    // Plan mode is honored, not rejected: no terminal error is emitted.
    expect(out.some((e) => e.kind === "done" && e.reason === "error")).toBe(false);
    expect(sdkMock.calls.startThread).toHaveLength(1);
    const startThreadOpts = sdkMock.calls.startThread[0] as {
      approvalPolicy?: string;
      sandboxMode?: string;
    };
    // Read-only sandbox faithfully enforces plan mode's no-mutation contract.
    expect(startThreadOpts.approvalPolicy).toBe("on-request");
    expect(startThreadOpts.sandboxMode).toBe("read-only");
  });

  it.each([
    ["read-only", "read-only"],
    ["workspace-write", "workspace-write"],
    ["unrestricted", "danger-full-access"],
  ] as const)("maps explicit filesystem scope %s to %s", async (filesystemScope, sandboxMode) => {
    codexHarness.registerTools({});
    await collect(codexHarness.start(baseOpts({
      sandboxPolicy: {
        requested: { filesystemScope, approvalPolicy: "on-request" },
        effective: { filesystemScope, approvalPolicy: "on-request" },
        unsupported: [],
      },
    })).events);
    const opts = sdkMock.calls.startThread[0] as {
      approvalPolicy?: string; sandboxMode?: string;
    };
    expect(opts).toMatchObject({
      approvalPolicy: "on-request", sandboxMode,
    });
  });
});

describe("CodexHarness reasoning effort", () => {
  it("forwards max reasoning to the Codex thread", async () => {
    codexHarness.registerTools({});
    await collect(
      codexHarness.start(
        baseOpts({
          thinking: { effort: "max", display: "summarized" },
        }),
      ).events,
    );
    const startThreadOpts = sdkMock.calls.startThread[0] as {
      modelReasoningEffort?: string;
    };
    expect(startThreadOpts.modelReasoningEffort).toBe("max");
  });
});

describe("CodexHarness abort determinism", () => {
  it("treats runStreamed rejection after abort as done(reason: abort), not error", async () => {
    const ac = new AbortController();
    // Replace the thread.runStreamed implementation so the *promise* it
    // returns rejects after abort, mimicking the SDK's normal abort
    // bookkeeping where the in-flight call hangs and then throws once the
    // signal fires.
    sdkMock.setNextEvents(
      (async function* () {
        // Empty — runStreamed will reject before yielding anything.
      })(),
    );
    // Patch the next-call thread.runStreamed to await abort and reject.
    const originalCodex = sdkMock.Codex.prototype as unknown as {
      startThread: (opts?: unknown) => unknown;
    };
    const stash = originalCodex.startThread;
    originalCodex.startThread = function patched(opts?: unknown) {
      sdkMock.calls.startThread.push(opts);
      return {
        id: null,
        runStreamed: async (
          input: unknown,
          turnOpts?: { signal?: AbortSignal },
        ) => {
          sdkMock.calls.runStreamed.push({
            input,
            turnOpts: turnOpts ?? null,
          });
          await new Promise((_resolve, reject) => {
            const sig = turnOpts?.signal;
            if (!sig) return reject(new Error("missing signal"));
            sig.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          });
          throw new Error("unreachable");
        },
        run: vi.fn(),
      };
    };

    try {
      const { events, control } = codexHarness.start(
        baseOpts({ abortSignal: ac.signal }),
      );
      const collected: NormalizedEvent[] = [];
      const iter = (async () => {
        for await (const ev of events) collected.push(ev);
      })();
      // Give the generator a tick to call runStreamed, then abort.
      await new Promise((r) => setTimeout(r, 10));
      control.abort();
      ac.abort();
      await iter;
      const last = collected[collected.length - 1];
      expect(last).toMatchObject({ kind: "done", reason: "abort" });
      const errs = collected.filter(
        (e) => e.kind === "done" && (e as { reason: string }).reason === "error",
      );
      expect(errs).toHaveLength(0);
    } finally {
      originalCodex.startThread = stash;
    }
  });
});

describe("buildCodexEnv", () => {
  it("returns a scrubbed operational environment when the default Codex home is usable", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-ok-"));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cwd-"));
    await fs.mkdir(path.join(home, ".codex"));

    await withEnv({ HOME: home, CODEX_HOME: undefined, AWS_SECRET_ACCESS_KEY: "secret" }, async () => {
      const env = buildCodexEnv({}, cwd);
      expect(env["HOME"]).toBe(home);
      expect(env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
    });
  });

  it("preserves bridge env while leaving CODEX_HOME unset when the default home is usable", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-bridge-"));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cwd-"));
    await fs.mkdir(path.join(home, ".codex"));

    await withEnv({ HOME: home, CODEX_HOME: undefined }, async () => {
      const env = buildCodexEnv({ MINIONS_BRIDGE_TOKEN_TASKS: "tok" }, cwd);
      expect(env?.["MINIONS_BRIDGE_TOKEN_TASKS"]).toBe("tok");
      expect(env?.["CODEX_HOME"]).toBeUndefined();
    });
  });

  it("uses a MINIONS_HOME CODEX_HOME fallback when the default path is not a directory", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-file-"));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cwd-"));
    const minionsHome = path.join(home, "central-minions");
    await fs.writeFile(path.join(home, ".codex"), "not a directory");

    await withEnv({ HOME: home, CODEX_HOME: undefined, MINIONS_HOME: minionsHome }, async () => {
      const env = buildCodexEnv({}, cwd);
      expect(env?.["CODEX_HOME"]).toBe(path.join(minionsHome, "runtime", "codex-home"));
      const stat = await fs.stat(env!["CODEX_HOME"]!);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  it("respects an explicit CODEX_HOME", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cwd-"));
    await withEnv({ CODEX_HOME: "/custom/codex-home" }, async () => {
      const env = buildCodexEnv({ MINIONS_BRIDGE_TOKEN_TASKS: "tok" }, cwd);
      expect(env?.["CODEX_HOME"]).toBe("/custom/codex-home");
    });
  });

  it("keeps provider and bridge credentials but drops unrelated ambient credentials", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-allowlist-"));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cwd-"));
    await fs.mkdir(path.join(home, ".codex"));
    await withEnv({
      HOME: home,
      OPENAI_API_KEY: "openai-token",
      GITHUB_TOKEN: "github-token",
      AWS_SECRET_ACCESS_KEY: "aws-token",
    }, async () => {
      const env = buildCodexEnv({ MINIONS_BRIDGE_TOKEN_TASKS: "bridge-token" }, cwd);
      expect(env["OPENAI_API_KEY"]).toBe("openai-token");
      expect(env["MINIONS_BRIDGE_TOKEN_TASKS"]).toBe("bridge-token");
      expect(env["GITHUB_TOKEN"]).toBeUndefined();
      expect(env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
    });
  });
});

async function withEnv(
  updates: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(updates)) {
    previous[key] = process.env[key];
  }
  try {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
