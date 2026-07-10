/**
 * Unit tests for CodexHarness (server/harness/codex/index.ts).
 *
 * Boundary mocks:
 *   - `@openai/codex-sdk` — replaced with a stub `Codex` class that records
 *     constructor + thread setup args and lets tests pump synthetic
 *     `ThreadEvent`s through `runStreamed`.
 *   - `../../mcp-bridge/server.ts` — replaced with a fake bridge server so
 *     no HTTP listener spins up and the test can assert registration is
 *     disposed in `finally`.
 *
 * Pinned behaviour:
 *   - `start()` returns synchronously with `{ events, control }`.
 *   - The translator + bridge integration emits `init`, item-derived events,
 *     `usage`, then exactly one terminal `done`.
 *   - `control.abort()` propagates through the AbortController and ends the
 *     stream with `done(reason: "abort")`.
 *   - When tools are registered the bridge is registered + disposed, and
 *     bridge env-vars are merged into Codex constructor `env`.
 *   - `resumeId` routes through `resumeThread` instead of `startThread`.
 *   - Attachments are forwarded to `runStreamed` as `local_image` UserInputs.
 */

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

// ── SDK mocks (hoisted) ───────────────────────────────────────────────────────

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

// ── Bridge mock (hoisted) ─────────────────────────────────────────────────────

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

// ── Imports that trigger module-load (after vi.mock) ──────────────────────────

import { buildCodexEnv } from "./env.ts";
import { codexHarness } from "./index.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Lifecycle ─────────────────────────────────────────────────────────────────

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
          reasoning_output_tokens: 0,
        },
      },
    ]),
  );
});

// ── start() / event sequence ──────────────────────────────────────────────────

describe("CodexHarness.start()", () => {
  it("emits init, text, usage, and exactly one terminal done in order", async () => {
    const { events, control } = codexHarness.start(baseOpts());
    expect(typeof control.abort).toBe("function");
    const out = await collect(events);
    expect(out.map((e) => e.kind)).toEqual(["init", "text", "usage", "done"]);
    expect(out[0]).toMatchObject({ kind: "init", sessionId: "th-001", model: "gpt-5.6-sol" });
    expect(out[1]).toMatchObject({ kind: "text", role: "assistant", text: "hi" });
    expect(out[2]).toMatchObject({ kind: "usage", input: 7, output: 11, cacheRead: 3 });
    expect(out[3]).toMatchObject({ kind: "done", reason: "stop" });
  });

  it("uses startThread when resumeId is absent", async () => {
    const out = await collect(codexHarness.start(baseOpts()).events);
    expect(out[0]?.kind).toBe("init");
    expect(sdkMock.calls.startThread).toHaveLength(1);
    expect(sdkMock.calls.resumeThread).toHaveLength(0);
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
    await collect(codexHarness.start(baseOpts({ resumeId: "th-prev" })).events);
    expect(sdkMock.calls.startThread).toHaveLength(0);
    expect(sdkMock.calls.resumeThread).toHaveLength(1);
    expect(sdkMock.calls.resumeThread[0]?.id).toBe("th-prev");
    expect(
      (sdkMock.calls.resumeThread[0]?.opts as { skipGitRepoCheck?: boolean })
        .skipGitRepoCheck,
    ).toBe(true);
  });

  it("emits done(reason: error) when runStreamed throws synchronously", async () => {
    sdkMock.setNextEvents(
      (async function* () {
        // Force runStreamed to throw by yielding then throwing.
        yield { type: "thread.started", thread_id: "th-err" };
        throw new Error("boom");
      })(),
    );
    const out = await collect(codexHarness.start(baseOpts()).events);
    const last = out[out.length - 1];
    expect(last).toMatchObject({ kind: "done", reason: "error", error: "boom" });
  });

  it("attaches prior stream errors to fullError when the stream later throws", async () => {
    sdkMock.setNextEvents(
      (async function* () {
        yield { type: "error", message: "Reconnecting... 1/5" };
        throw new Error("Codex Exec exited with code 1: stderr detail");
      })(),
    );
    const out = await collect(codexHarness.start(baseOpts()).events);
    const last = out[out.length - 1] as { fullError?: string };
    expect(last.fullError).toContain("Codex Exec exited with code 1");
    expect(last.fullError).toContain("Reconnecting... 1/5");
  });

  it("treats Windows taskkill success output after completion as normal stop", async () => {
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
    expect(out[out.length - 1]).toMatchObject({ kind: "done", reason: "stop" });
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

// ── Tools / bridge integration ────────────────────────────────────────────────

describe("CodexHarness MCP bridge", () => {
  it("registers, exposes, and disposes bridge groups when tools are present", async () => {
    codexHarness.registerTools({
      "task-manager": [toolDef("plan_task"), toolDef("assign_task")],
      empty: [],
    });
    await collect(codexHarness.start(baseOpts({ sessionKey: "abc" })).events);

    expect(bridgeMock.calls.register).toHaveLength(1);
    expect(bridgeMock.calls.register[0]?.sessionKey).toBe("abc");
    expect(Object.keys(bridgeMock.calls.register[0]?.groups ?? {})).toEqual([
      "task-manager",
      "empty",
    ]);
    expect(bridgeMock.calls.dispose).toEqual(["abc"]);

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

// ── Static info / capabilities ────────────────────────────────────────────────

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
      thinking: true,
      mcp: true,
      resume: true,
      partialMessages: false,
      builtInFilesystem: true,
    });
  });
});

// ── Attachments ───────────────────────────────────────────────────────────────

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

// ── permissionMode end-to-end ─────────────────────────────────────────────────

describe("CodexHarness permission mode", () => {
  it("forwards opts.permissionMode to startThread via mapPermission", async () => {
    codexHarness.registerTools({});
    await collect(
      codexHarness.start(baseOpts({ permissionMode: "bypassPermissions" })).events,
    );
    const startThreadOpts = sdkMock.calls.startThread[0] as {
      approvalPolicy?: string;
      sandboxMode?: string;
    };
    // bypassPermissions → approvalPolicy "never" + sandboxMode "workspace-write"
    expect(startThreadOpts.approvalPolicy).toBe("never");
    expect(startThreadOpts.sandboxMode).toBe("workspace-write");
  });

  it("uses the auto fallback when permissionMode is omitted", async () => {
    codexHarness.registerTools({});
    await collect(codexHarness.start(baseOpts()).events);
    const startThreadOpts = sdkMock.calls.startThread[0] as {
      approvalPolicy?: string;
      sandboxMode?: string;
    };
    expect(startThreadOpts.approvalPolicy).toBe("on-failure");
    expect(startThreadOpts.sandboxMode).toBe("workspace-write");
  });

  it("rejects plan mode with a single done(error) and never opens a thread", async () => {
    codexHarness.registerTools({});
    const out = await collect(
      codexHarness.start(baseOpts({ permissionMode: "plan" })).events,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "done",
      reason: "error",
    });
    expect((out[0] as { error?: string }).error ?? "").toMatch(
      /not supported by harness "codex"/,
    );
    expect(sdkMock.calls.startThread).toHaveLength(0);
    expect(sdkMock.calls.resumeThread).toHaveLength(0);
  });
});

// ── Deterministic abort ───────────────────────────────────────────────────────

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

// ── Codex CLI environment ────────────────────────────────────────────────────

describe("buildCodexEnv", () => {
  it("returns undefined when no bridge env is needed and the default Codex home is usable", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-ok-"));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cwd-"));
    await fs.mkdir(path.join(home, ".codex"));

    await withEnv({ HOME: home, CODEX_HOME: undefined }, async () => {
      expect(buildCodexEnv({}, cwd)).toBeUndefined();
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

  it("uses a project-local CODEX_HOME fallback when the default path is not a directory", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-file-"));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cwd-"));
    await fs.writeFile(path.join(home, ".codex"), "not a directory");

    await withEnv({ HOME: home, CODEX_HOME: undefined }, async () => {
      const env = buildCodexEnv({}, cwd);
      expect(env?.["CODEX_HOME"]).toBe(path.join(cwd, ".minions", "codex-home"));
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
