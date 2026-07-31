import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import type { HarnessStartOptions, NormalizedEvent, NormalizedToolDef } from "../types.ts";
import { closePersistDb, disablePersistence } from "../../session-persist.ts";
import { createWorkItem, startWorkItemIteration } from "../../work-item-repo.ts";
import { getRunInvocation, startRunInvocation } from "../../work-item-invocations.ts";

const sdkMock = vi.hoisted(() => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(),
  tool: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => sdkMock);

const TEST_CLAUDE_PATH = process.execPath;
const originalClaudePath = process.env["CLAUDE_CODE_PATH"];

type SdkMessage = Record<string, unknown>;

function doneMessage(): SdkMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    usage: { input_tokens: 1, output_tokens: 2 },
  };
}

function makeHandle(messages: SdkMessage[]) {
  return {
    close: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    getContextUsage: vi.fn(async () => ({ remaining: 10 })),
    mcpServerStatus: vi.fn(async () => ({ servers: [] })),
    rewindFiles: vi.fn(async () => ({ ok: true })),
    seedReadState: vi.fn(async () => ({ ok: true })),
    stopTask: vi.fn(async () => ({ ok: true })),
    reconnectMcpServer: vi.fn(async () => ({ ok: true })),
    toggleMcpServer: vi.fn(async () => ({ ok: true })),
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        yield message;
      }
    },
  };
}

function baseOpts(overrides: Partial<HarnessStartOptions> = {}): HarnessStartOptions {
  const controller = new AbortController();
  return {
    sessionKey: "session-1",
    cwd: "/tmp/workspace",
    prompt: "hello",
    systemPrompt: "system prompt",
    model: "claude-sonnet-5",
    allowedTools: ["Read", "mcp__internal__alpha"],
    abortSignal: controller.signal,
    resumeId: "resume-123",
    ...overrides,
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

async function collect(events: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent[]> {
  const out: NormalizedEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}

async function importHarness(claudePath?: string) {
  vi.resetModules();
  if (claudePath === undefined) {
    delete process.env["CLAUDE_CODE_PATH"];
  } else {
    process.env["CLAUDE_CODE_PATH"] = claudePath;
  }
  const mod = await import("./index.ts");
  return mod.claudeHarness;
}

function lastQueryOptions(): Record<string, unknown> {
  const call = sdkMock.query.mock.calls.at(-1)?.[0] as
    | { options?: Record<string, unknown> }
    | undefined;
  if (!call?.options) {
    throw new Error("query() was not called with options");
  }
  return call.options;
}

beforeEach(() => {
  disablePersistence();
  sdkMock.query.mockReset();
  sdkMock.createSdkMcpServer.mockReset();
  sdkMock.tool.mockReset();
  sdkMock.createSdkMcpServer.mockImplementation((config: unknown) => ({
    kind: "mock-mcp-server",
    config,
  }));
  sdkMock.tool.mockImplementation(
    (name: string, description: string, inputSchema: unknown, handler: unknown) => ({
      name,
      description,
      inputSchema,
      handler,
    }),
  );
});

afterEach(() => {
  closePersistDb();
  disablePersistence();
  if (originalClaudePath === undefined) {
    delete process.env["CLAUDE_CODE_PATH"];
  } else {
    process.env["CLAUDE_CODE_PATH"] = originalClaudePath;
  }
});

describe("ClaudeHarness.start()", () => {
  it("reports complete pre-mutation interception", async () => {
    expect((await importHarness()).capabilities.mutationInterception).toBe("complete");
  });

  it("releases mutation coordination only after the aborted SDK stream stops", async () => {
    const order: string[] = [];
    const coordination = {
      setLeaseLostHandler: vi.fn(), disconnect: vi.fn(() => order.push("release")),
      beforeTool: vi.fn(), finishTool: vi.fn(), cancelTool: vi.fn(),
    };
    sdkMock.query.mockImplementation((request: { options: { abortController: AbortController } }) => ({
      async *[Symbol.asyncIterator]() {
        const signal = request.options.abortController.signal;
        if (!signal.aborted) await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }));
        order.push("sdk-stopped");
      },
    }));
    const harness = await importHarness();
    const run = harness.start(baseOpts({ mutationCoordination: coordination as never }));
    const collecting = collect(run.events);
    await vi.waitFor(() => expect(sdkMock.query).toHaveBeenCalledOnce());
    run.control.abort();
    await collecting;
    expect(order).toEqual(["sdk-stopped", "release"]);
    expect(coordination.disconnect).toHaveBeenCalledOnce();
  });

  it("drains and records a provider result flushed after abort", async () => {
    const harness = await importHarness();
    const persistence = await import("../../session-persist.ts");
    const db = persistence.openPersistDb(":memory:");
    createWorkItem(db, {
      id: "work-drain", projectId: "p", projectPath: "/repo", title: "Drain",
      changeMode: "live", at: 1,
    });
    startWorkItemIteration(db, {
      workItemId: "work-drain", runKey: "run-drain", idempotencyKey: "start",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null, at: 2,
    });
    startRunInvocation(db, {
      runKey: "run-drain", providerId: "claude", startedAt: 3,
    });
    sdkMock.query.mockImplementation((request: {
      options: { abortController: AbortController };
    }) => ({
      async *[Symbol.asyncIterator]() {
        const signal = request.options.abortController.signal;
        if (!signal.aborted) await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }));
        yield doneMessage();
      },
    }));
    const run = harness.start(baseOpts({ sessionKey: "run-drain" }));
    const collecting = collect(run.events);
    await vi.waitFor(() => expect(sdkMock.query).toHaveBeenCalledOnce());

    run.control.abort();
    await collecting;

    expect(getRunInvocation(db, "run-drain", 1)).toMatchObject({
      phase: "terminal", terminal_kind: "clean", terminal_source: "provider",
    });
    persistence.closePersistDb();
  });
  it("exposes Fable 5 in static model metadata", async () => {
    const harness = await importHarness();

    expect(harness.staticInfo().models).toContainEqual({
      id: "claude-fable-5",
      label: "Fable 5",
    });
  });

  it("exposes Opus 5 in static model metadata", async () => {
    const harness = await importHarness();

    expect(harness.staticInfo().models).toContainEqual({
      id: "claude-opus-5",
      label: "Opus 5",
    });
  });

  it("passes the expected session options to query()", async () => {
    const handle = makeHandle([doneMessage()]);
    sdkMock.query.mockReturnValue(handle);
    const harness = await importHarness();

    await collect(harness.start(baseOpts()).events);

    const options = lastQueryOptions();
    expect(options).toMatchObject({
      cwd: "/tmp/workspace",
      resume: "resume-123",
      allowedTools: ["mcp__internal__alpha", "Read"],
      systemPrompt: "system prompt",
      model: "claude-sonnet-5",
      includePartialMessages: true,
      permissionMode: "auto",
      strictMcpConfig: true,
    });
    expect(options["pathToClaudeCodeExecutable"]).toEqual(expect.any(String));
    expect(options["abortController"]).toBeInstanceOf(AbortController);
    expect(sdkMock.query).toHaveBeenCalledWith({
      prompt: "hello",
      options: expect.any(Object),
    });
  });

  it("passes CLAUDE_CODE_PATH as the only explicit executable override", async () => {
    const handle = makeHandle([doneMessage()]);
    sdkMock.query.mockReturnValue(handle);
    const harness = await importHarness(TEST_CLAUDE_PATH);

    await collect(harness.start(baseOpts()).events);

    expect(lastQueryOptions()["pathToClaudeCodeExecutable"]).toBe(TEST_CLAUDE_PATH);
  });

  it("wraps registered tool groups into mcpServers and merges external MCP servers", async () => {
    const handle = makeHandle([doneMessage()]);
    sdkMock.query.mockReturnValue(handle);
    const harness = await importHarness();
    harness.registerTools({
      internal: [toolDef("alpha"), toolDef("beta")],
      empty: [],
    });
    const externalServer = { type: "http", url: "https://mcp.example.test" };

    await collect(
      harness.start(
        baseOpts({
          externalMcpServers: {
            external: externalServer,
          },
        }),
      ).events,
    );

    expect(sdkMock.createSdkMcpServer).toHaveBeenCalledTimes(1);
    expect(sdkMock.createSdkMcpServer).toHaveBeenCalledWith({
      name: "internal",
      tools: [
        expect.objectContaining({ name: "alpha" }),
        expect.objectContaining({ name: "beta" }),
      ],
    });
    expect(lastQueryOptions()["mcpServers"]).toEqual({
      internal: {
        kind: "mock-mcp-server",
        config: {
          name: "internal",
          tools: [
            expect.objectContaining({ name: "alpha" }),
            expect.objectContaining({ name: "beta" }),
          ],
        },
      },
      external: externalServer,
    });
  });

  it("normalizes tool and MCP server ordering before querying Claude", async () => {
    const handle = makeHandle([doneMessage()]);
    sdkMock.query.mockReturnValue(handle);
    const harness = await importHarness();
    harness.registerTools({
      zeta: [toolDef("gamma"), toolDef("alpha")],
      alpha: [toolDef("beta")],
    });

    await collect(
      harness.start(
        baseOpts({
          allowedTools: ["mcp__zeta__gamma", "Read", "mcp__alpha__beta"],
          externalMcpServers: {
            remote: { type: "http", url: "https://remote.example.test" },
            local: { type: "stdio", command: "local-mcp" },
          },
        }),
      ).events,
    );

    expect(lastQueryOptions()["allowedTools"]).toEqual([
      "mcp__alpha__beta",
      "mcp__zeta__gamma",
      "Read",
    ]);
    expect(sdkMock.createSdkMcpServer.mock.calls.map((call) => call[0])).toEqual([
      {
        name: "alpha",
        tools: [expect.objectContaining({ name: "beta" })],
      },
      {
        name: "zeta",
        tools: [
          expect.objectContaining({ name: "alpha" }),
          expect.objectContaining({ name: "gamma" }),
        ],
      },
    ]);
    expect(Object.keys(lastQueryOptions()["mcpServers"] as Record<string, unknown>)).toEqual([
      "alpha",
      "local",
      "remote",
      "zeta",
    ]);
  });

  it("passes thinking options when opts.thinking is set and the model supports adaptive thinking", async () => {
    sdkMock.query.mockReturnValue(makeHandle([doneMessage()]));
    const harness = await importHarness();

    await collect(
      harness.start(
        baseOpts({
          model: "claude-sonnet-5",
          thinking: { effort: "high", display: "summarized" },
        }),
      ).events,
    );

    expect(lastQueryOptions()).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
      effort: "high",
    });
  });

  it("omits thinking options when opts.thinking is not set", async () => {
    sdkMock.query.mockReturnValue(makeHandle([doneMessage()]));
    const harness = await importHarness();

    await collect(harness.start(baseOpts({ model: "claude-sonnet-5" })).events);

    expect(lastQueryOptions()).not.toHaveProperty("thinking");
    expect(lastQueryOptions()).not.toHaveProperty("effort");
  });

  it("omits thinking options when the model does not support adaptive thinking", async () => {
    sdkMock.query.mockReturnValue(makeHandle([doneMessage()]));
    const harness = await importHarness();

    await collect(
      harness.start(
        baseOpts({
          model: "claude-haiku-4-5",
          thinking: { effort: "medium", display: "omitted" },
        }),
      ).events,
    );

    expect(lastQueryOptions()).not.toHaveProperty("thinking");
    expect(lastQueryOptions()).not.toHaveProperty("effort");
  });

  it("emits SDK system init events as init with Claude metadata", async () => {
    sdkMock.query.mockReturnValue(
      makeHandle([
        {
          type: "system",
          subtype: "init",
          session_id: "sdk-session",
          model: "claude-sonnet-5",
          permissionMode: "auto",
          tools: ["Read"],
          mcp_servers: [{ name: "internal" }],
          slash_commands: ["/help"],
          skills: ["skill-a"],
          claude_code_version: "1.2.3",
        },
        doneMessage(),
      ]),
    );
    const harness = await importHarness();

    const events = await collect(harness.start(baseOpts()).events);

    expect(events[0]).toEqual({
      kind: "init",
      sessionId: "sdk-session",
      model: "claude-sonnet-5",
      permissionMode: "auto",
      meta: {
        tools: ["Read"],
        model: "claude-sonnet-5",
        mcp_servers: [{ name: "internal" }],
        permissionMode: "auto",
        slash_commands: ["/help"],
        skills: ["skill-a"],
        claude_code_version: "1.2.3",
      },
    });
  });

  it("maps SDK task_started and task_notification system events to agent events", async () => {
    sdkMock.query.mockReturnValue(
      makeHandle([
        {
          type: "system",
          subtype: "task_started",
          task_id: "task-1",
          description: "Investigate flaky test",
        },
        {
          type: "system",
          subtype: "task_notification",
          task_id: "task-1",
          status: "completed",
          summary: "Fixed",
        },
        doneMessage(),
      ]),
    );
    const harness = await importHarness();

    const events = await collect(harness.start(baseOpts()).events);

    expect(events.slice(0, 2)).toEqual([
      {
        kind: "agent_spawned",
        taskId: "task-1",
        description: "Investigate flaky test",
      },
      {
        kind: "agent_task_update",
        taskId: "task-1",
        status: "completed",
        summary: "Fixed",
      },
    ]);
  });

  it("turns thrown SDK setup errors into done(error)", async () => {
    sdkMock.query.mockImplementation(() => {
      throw new Error("SDK setup failed");
    });
    const harness = await importHarness();

    const events = await collect(harness.start(baseOpts()).events);

    expect(events).toEqual([
      { kind: "done", reason: "error", error: "SDK setup failed" },
    ]);
  });

  it("treats thrown Claude tool-use diagnostics as non-error completion", async () => {
    sdkMock.query.mockImplementation(() => {
      throw new Error(
        "Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
      );
    });
    const harness = await importHarness();

    const events = await collect(harness.start(baseOpts()).events);

    expect(events).toEqual([{ kind: "done", reason: "completed" }]);
  });

  it("delegates run control methods to the SDK handle once query is ready", async () => {
    const handle = makeHandle([doneMessage()]);
    sdkMock.query.mockReturnValue(handle);
    const harness = await importHarness();
    const run = harness.start(baseOpts());

    const iterator = run.events[Symbol.asyncIterator]();
    await iterator.next();

    await expect(run.control.interrupt?.()).resolves.toBeUndefined();
    await expect(run.control.setModel?.("claude-opus-4-7")).resolves.toBeUndefined();
    await expect(run.control.setPermissionMode?.("plan")).resolves.toBeUndefined();
    await expect(run.control.getContextUsage?.()).resolves.toEqual({ remaining: 10 });
    await expect(run.control.mcpServerStatus?.()).resolves.toEqual({ servers: [] });
    await expect(
      run.control.rewindFiles?.({ userMessageId: "user-1", dryRun: true }),
    ).resolves.toEqual({ ok: true });
    await expect(
      run.control.seedReadState?.({ path: "/tmp/file.txt", mtime: 123 }),
    ).resolves.toEqual({ ok: true });
    await expect(run.control.stopTask?.("task-1")).resolves.toEqual({ ok: true });
    await expect(run.control.reconnectMcpServer?.("internal")).resolves.toEqual({
      ok: true,
    });
    await expect(run.control.toggleMcpServer?.("internal", false)).resolves.toEqual({
      ok: true,
    });
    await expect(run.control.close?.()).resolves.toBeUndefined();

    expect(handle.interrupt).toHaveBeenCalledTimes(1);
    expect(handle.setModel).toHaveBeenCalledWith("claude-opus-4-7");
    expect(handle.setPermissionMode).toHaveBeenCalledWith("plan");
    expect(handle.getContextUsage).toHaveBeenCalledTimes(1);
    expect(handle.mcpServerStatus).toHaveBeenCalledTimes(1);
    expect(handle.rewindFiles).toHaveBeenCalledWith("user-1", { dryRun: true });
    expect(handle.seedReadState).toHaveBeenCalledWith("/tmp/file.txt", 123);
    expect(handle.stopTask).toHaveBeenCalledWith("task-1");
    expect(handle.reconnectMcpServer).toHaveBeenCalledWith("internal");
    expect(handle.toggleMcpServer).toHaveBeenCalledWith("internal", false);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });
});
