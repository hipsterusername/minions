
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
    expect(out[2]).toMatchObject({ kind: "usage", input: 7, output: 11, cacheRead: 3 });
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
    const last = out[out.length - 1] as { fullError?: string };
    expect(last.fullError).toContain("Codex Exec exited with code 1");
    expect(last.fullError).toContain("Reconnecting... 1/5");
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
