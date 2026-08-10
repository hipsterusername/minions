/**
 * Tests for the `create_session` command handler — pinned around the two
 * regressions that broke NEW leader initiation in production:
 *
 *   1. The cap counts *live* sessions, not on-disk records. A registry
 *      hydrated with `MAX_SESSIONS` stopped sessions must still accept a
 *      new `create_session`.
 *   2. Rejection routing: when the client supplies a `sessionKey` (every
 *      LeaderNode does), a rejection MUST go out as a session-scoped
 *      `session_error` so the LeaderNode reducer transitions to
 *      `status: "error"`. Sending it to the global topic gets dropped
 *      and the UI sticks at `creating` forever.
 */

import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createSession } from "./create-session.ts";
import { SessionRegistry } from "../session-registry.ts";
import { SessionHost } from "../session-host.ts";
import type { CommandContext, WsCommand } from "./types.ts";
import type { Bus } from "../bus.ts";
import type { StartSessionOptions } from "../session-host.ts";
import { registerProjectPath, unregisterProjectPath } from "../path-guard.ts";
import { saveMcpServer } from "../mcp-server-store.ts";
import type { WorkItemService } from "../work-item-service.ts";
import type { SandboxPolicy } from "../../shared/workspace-contracts.ts";
// Side-effect: registers EchoHarness so the harness-validation branch can
// look it up via `registeredHarnessNames()`.
import "../harness/echo/index.ts";

beforeAll(() => {
  registerProjectPath(process.cwd());
});

interface SentMessage {
  payload: unknown;
}

/** Capture every `ws.send` call as a parsed JSON object. */
function makeFakeWs(): { ws: { send: (s: string) => void; readyState: 1 }; sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  return {
    sent,
    ws: {
      readyState: 1, // OPEN — `unicast` checks this before sending
      send: (raw: string) => sent.push({ payload: JSON.parse(raw) }),
    },
  };
}

function makeBus(sent: Array<Record<string, unknown>> = []): Bus {
  // None of the rejection paths use the bus — every reply goes via
  // `unicast*`. We supply a no-op bus for the success path.
  return {
    emit: () => {},
    emitToSession: () => {},
    emitToProject: () => {},
    emitGlobal: (payload) => sent.push(payload),
    subscribe: () => () => {},
  };
}

function makeCtx(
  registry: SessionRegistry,
  maxSessions: number,
  bus: Bus = makeBus(),
): CommandContext {
  return {
    registry,
    bus,
    generateKey: () => "auto-key",
    maxSessions,
    resolveWorkspace: (id) => id === "project-1"
      ? { id, sourceRoot: process.cwd() }
      : null,
    launchSession: async (options) => {
      registry.start(options);
      return { sessionKey: options.sessionKey, harness: options.harness ?? "claude", model: options.initialModel ?? "", permissionMode: options.permissionMode ?? "auto", reasons: [] };
    },
  };
}

function canonicalService(runKey: string, input: {
  endedAt?: number | null;
  outcome?: "none" | "completed" | "error" | "interrupted";
  changeMode?: "live" | "worktree";
} = {}): WorkItemService {
  return {
    get: async () => ({
      workItem: {
        id: "work-ingress", projectId: "project-1", projectPath: process.cwd(), title: "Task",
        lifecycle: {
          runtimeState: input.endedAt == null ? "starting" : "inactive",
          outcome: input.outcome ?? "none", resolution: "open", changeMode: input.changeMode ?? "live",
          integrationState: input.changeMode === "worktree" ? "worktree_clean" : "live_clean", lifecycleRevision: 1,
        },
        waitKind: null, currentRunKey: runKey, iteration: 1,
        lastTransitionAt: 1,
        createdAt: 1, updatedAt: 1,
      },
      bindings: [],
      currentRun: {
        runKey, workItemId: "work-ingress", runKind: "primary", parentRunKey: null,
        taskId: null, runNumber: 1, previousRunKey: null, providerSessionId: null,
        outcome: input.outcome ?? "none", startedAt: 1, endedAt: input.endedAt ?? null,
        finalReport: null,
      },
      runs: [], nextCursor: null,
    }),
  } as unknown as WorkItemService;
}

function fillRegistryWithStopped(
  r: SessionRegistry,
  count: number,
): void {
  const map = (r as unknown as { map: Map<string, SessionHost> }).map;
  for (let i = 0; i < count; i++) {
    const h = new SessionHost(`hydrated-${i}`, "/tmp/work");
    h.status = "stopped";
    map.set(h.id, h);
  }
}

function fillRegistryWithRunning(
  r: SessionRegistry,
  count: number,
): void {
  const map = (r as unknown as { map: Map<string, SessionHost> }).map;
  for (let i = 0; i < count; i++) {
    const h = new SessionHost(`live-${i}`, "/tmp/work");
    h.status = "running";
    map.set(h.id, h);
  }
}

describe("createSession — MAX_SESSIONS cap", () => {
  it("passes selected skill IDs and values into the session host", async () => {
    const registry = new SessionRegistry();
    const starts: StartSessionOptions[] = [];
    const ctx = makeCtx(registry, 5);
    ctx.launchSession = async (options) => {
      starts.push(options);
      return {
        sessionKey: options.sessionKey,
        harness: "claude",
        model: "",
        permissionMode: "auto",
        reasons: [],
      };
    };
    const { ws } = makeFakeWs();

    await createSession(ctx, {
      type: "create_session",
      sessionKey: "leader-skills",
      prompt: "Review this project",
      cwd: process.cwd(),
      role: "leader",
      skillIds: ["code-review"],
      skillValues: { "code-review": { target: "the API" } },
    }, ws as unknown as Parameters<typeof createSession>[2]);

    expect(starts).toEqual([expect.objectContaining({
      skillIds: ["code-review"],
      skillValues: { "code-review": { target: "the API" } },
    })]);
  });

  it("is idempotent for an existing sessionKey and does not start another host", () => {
    const registry = new SessionRegistry();
    const existing = new SessionHost("leader-existing", process.cwd());
    existing.status = "running";
    (registry as unknown as { map: Map<string, SessionHost> }).map.set(
      existing.id,
      existing,
    );

    const starts: StartSessionOptions[] = [];
    (registry as unknown as { start: (opts: StartSessionOptions) => void }).start = (
      opts,
    ) => {
      starts.push(opts);
    };

    const { ws, sent } = makeFakeWs();
    const ctx = makeCtx(registry, 1);
    const cmd: WsCommand = {
      type: "create_session",
      sessionKey: "leader-existing",
      prompt: "hi",
      cwd: process.cwd(),
      role: "leader",
    };

    createSession(ctx, cmd, ws as unknown as Parameters<typeof createSession>[2]);

    expect(starts).toHaveLength(0);
    expect(sent).toHaveLength(1);
    const env = sent[0]?.payload as Record<string, unknown>;
    expect(env["topic"]).toBe("session:leader-existing");
    expect(env["type"]).toBe("session_created");
    expect(env["sessionKey"]).toBe("leader-existing");
  });

  it("accepts a new session when the registry holds N stopped (hydrated) sessions where N === maxSessions (regression)", async () => {
    const registry = new SessionRegistry();
    fillRegistryWithStopped(registry, 50);

    // setDeps so the start() call inside the handler doesn't throw.
    // We don't care if the SDK actually opens — we just need the cap
    // check to pass and the unicast `session_created` to fire.
    registry.setDeps({
      bus: makeBus(),
      startChildSession: () => {},
      forEachLeaderTaskState: () => {},
    });

    const { ws, sent } = makeFakeWs();
    const ctx = makeCtx(registry, 50);
    const cmd: WsCommand = {
      type: "create_session",
      sessionKey: "leader-new",
      prompt: "hi",
      cwd: process.cwd(),
      role: "leader",
    };

    await createSession(ctx, cmd, ws as unknown as Parameters<typeof createSession>[2]);

    const types = sent.map((m) => (m.payload as { type: string }).type);
    expect(types).toContain("session_created");
    expect(types).not.toContain("error");
    expect(types).not.toContain("session_error");
  });

  it("broadcasts an updated session_list after registering a new session", async () => {
    const registry = new SessionRegistry();
    registry.setDeps({
      bus: makeBus(),
      startChildSession: () => {},
      forEachLeaderTaskState: () => {},
    });

    const busSent: Array<Record<string, unknown>> = [];
    const { ws } = makeFakeWs();
    const ctx = makeCtx(registry, 5, makeBus(busSent));
    const cmd: WsCommand = {
      type: "create_session",
      sessionKey: "leader-new",
      prompt: "hi",
      cwd: process.cwd(),
      role: "leader",
    };

    await createSession(ctx, cmd, ws as unknown as Parameters<typeof createSession>[2]);

    const list = busSent.find((payload) => payload["type"] === "session_list");
    expect(list).toBeDefined();
    const sessions = list?.["sessions"] as Array<{ sessionKey: string; role?: string }>;
    expect(sessions.map((s) => s.sessionKey)).toContain("leader-new");
    expect(sessions.find((s) => s.sessionKey === "leader-new")?.role).toBe("leader");
  });

  it("rejects when the registry is full of LIVE sessions, not stopped ones", () => {
    const registry = new SessionRegistry();
    fillRegistryWithRunning(registry, 3);

    const { ws, sent } = makeFakeWs();
    const ctx = makeCtx(registry, 3);
    const cmd: WsCommand = {
      type: "create_session",
      sessionKey: "leader-new",
      prompt: "hi",
      cwd: process.cwd(),
      role: "leader",
    };

    createSession(ctx, cmd, ws as unknown as Parameters<typeof createSession>[2]);

    const types = sent.map((m) => (m.payload as { type: string }).type);
    expect(types).toContain("session_error");
  });
});

describe("createSession — rejection routing", () => {
  it("resolves a bare workspace launch from workspaceId and ignores no client path", async () => {
    const registry = new SessionRegistry();
    const starts: StartSessionOptions[] = [];
    const ctx = makeCtx(registry, 50);
    const workspaceId = "55555555-5555-4555-8555-555555555555";
    ctx.resolveWorkspace = (id) => id === workspaceId
      ? { id, sourceRoot: process.cwd() }
      : null;
    ctx.launchSession = async (options) => {
      starts.push(options);
      return { sessionKey: options.sessionKey, harness: "claude", model: "",
        permissionMode: "auto", reasons: [] };
    };
    const { ws } = makeFakeWs();

    await createSession(ctx, { type: "create_session", sessionKey: "opaque-run",
      workspaceId }, ws as unknown as Parameters<typeof createSession>[2]);

    expect(starts[0]?.cwd).toBe(process.cwd());
  });

  it("rejects cwd when workspaceId is authoritative", async () => {
    const registry = new SessionRegistry();
    const ctx = makeCtx(registry, 50);
    const workspaceId = "55555555-5555-4555-8555-555555555555";
    ctx.resolveWorkspace = (id) => id === workspaceId
      ? { id, sourceRoot: process.cwd() }
      : null;
    const { ws, sent } = makeFakeWs();

    await createSession(ctx, { type: "create_session", sessionKey: "opaque-mismatch",
      workspaceId, cwd: process.cwd() }, ws as unknown as Parameters<typeof createSession>[2]);

    expect(sent[0]?.payload).toMatchObject({
      topic: "session:opaque-mismatch", code: "WORKSPACE_CONFIGURATION_MISMATCH",
    });
  });

  it("derives canonical cwd, leader role, and worktree isolation from the work item", async () => {
    const registry = new SessionRegistry();
    const starts: StartSessionOptions[] = [];
    const ctx = makeCtx(registry, 50);
    ctx.workItems = canonicalService("derived-run", { changeMode: "worktree" });
    ctx.launchSession = async (options) => {
      starts.push(options);
      return { sessionKey: options.sessionKey, harness: "claude", model: "", permissionMode: "auto", reasons: [] };
    };
    const { ws } = makeFakeWs();
    await createSession(ctx, {
      type: "create_session", sessionKey: "derived-run", workItemId: "work-ingress",
    }, ws as unknown as Parameters<typeof createSession>[2]);
    expect(starts[0]).toMatchObject({
      cwd: process.cwd(), role: "leader", worktreeIsolation: true,
    });
  });

  it("rejects client overrides that conflict with canonical session configuration", async () => {
    const registry = new SessionRegistry();
    const starts: StartSessionOptions[] = [];
    const ctx = makeCtx(registry, 50);
    ctx.workItems = canonicalService("mismatch-run", { changeMode: "worktree" });
    ctx.launchSession = async (options) => {
      starts.push(options);
      return { sessionKey: options.sessionKey, harness: "claude", model: "", permissionMode: "auto", reasons: [] };
    };
    const { ws, sent } = makeFakeWs();
    await createSession(ctx, {
      type: "create_session", sessionKey: "mismatch-run", workItemId: "work-ingress",
      role: "minion", worktreeIsolation: false,
    }, ws as unknown as Parameters<typeof createSession>[2]);
    expect(starts).toEqual([]);
    expect(sent[0]?.payload).toMatchObject({
      topic: "session:mismatch-run", code: "WORK_ITEM_CONFIGURATION_MISMATCH",
    });
  });

  it("propagates optional workItemId through the production launch boundary", async () => {
    const registry = new SessionRegistry();
    const starts: StartSessionOptions[] = [];
    const ctx = makeCtx(registry, 50);
    ctx.workItems = canonicalService("run-ingress");
    ctx.launchSession = async (options) => {
      starts.push(options);
      return { sessionKey: options.sessionKey, harness: "claude", model: "", permissionMode: "auto", reasons: [] };
    };
    const { ws } = makeFakeWs();

    await createSession(ctx, {
      type: "create_session",
      sessionKey: "run-ingress",
      workItemId: "work-ingress",
    }, ws as unknown as Parameters<typeof createSession>[2]);

    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      invocationKind: "new_run",
      sessionKey: "run-ingress",
      workItemId: "work-ingress",
    });
  });

  it("rejects an arbitrary client session key for a canonical work item", async () => {
    const registry = new SessionRegistry();
    const starts: StartSessionOptions[] = [];
    const ctx = makeCtx(registry, 50);
    ctx.workItems = canonicalService("server-run");
    ctx.launchSession = async (options) => {
      starts.push(options);
      return { sessionKey: options.sessionKey, harness: "claude", model: "", permissionMode: "auto", reasons: [] };
    };
    const { ws, sent } = makeFakeWs();
    await createSession(ctx, {
      type: "create_session", sessionKey: "client-run", workItemId: "work-ingress",
      cwd: process.cwd(),
    }, ws as unknown as Parameters<typeof createSession>[2]);

    expect(starts).toEqual([]);
    expect(sent[0]?.payload).toMatchObject({
      topic: "session:client-run", type: "session_error",
      code: "WORK_ITEM_RUN_MISMATCH", currentRunKey: "server-run",
    });
  });

  it("rejects a sealed canonical run even when its key matches", async () => {
    const registry = new SessionRegistry();
    const ctx = makeCtx(registry, 50);
    ctx.workItems = canonicalService("sealed-run", { endedAt: 20, outcome: "completed" });
    const { ws, sent } = makeFakeWs();
    await createSession(ctx, {
      type: "create_session", sessionKey: "sealed-run", workItemId: "work-ingress",
      cwd: process.cwd(),
    }, ws as unknown as Parameters<typeof createSession>[2]);
    expect(sent[0]?.payload).toMatchObject({
      topic: "session:sealed-run", code: "WORK_ITEM_RUN_MISMATCH",
    });
  });

  it("loads persisted project MCP servers into a Claude launch", async () => {
    const project = fs.mkdtempSync(path.join(process.cwd(), ".minions-mcp-launch-"));
    registerProjectPath(project);
    saveMcpServer(project, {
      id: "local-tools",
      name: "Local tools",
      transport: "stdio",
      command: "node",
      args: ["server.mjs"],
      toolNames: ["inspect"],
    });
    const registry = new SessionRegistry();
    const starts: StartSessionOptions[] = [];
    const ctx = makeCtx(registry, 50);
    ctx.launchSession = async (options) => {
      starts.push(options);
      return {
        sessionKey: options.sessionKey,
        harness: "claude",
        model: options.initialModel ?? "",
        permissionMode: "auto",
        reasons: [],
      };
    };

    try {
      const { ws } = makeFakeWs();
      await createSession(
        ctx,
        {
          type: "create_session",
          sessionKey: "leader-mcp",
          cwd: project,
          harness: "claude",
        },
        ws as unknown as Parameters<typeof createSession>[2],
      );

      expect(starts[0]?.externalMcpServers).toEqual({
        "local-tools": {
          type: "stdio",
          command: "node",
          args: ["server.mjs"],
        },
      });
      expect(starts[0]?.externalMcpToolNames).toEqual([
        "mcp__local-tools__inspect",
      ]);
    } finally {
      unregisterProjectPath(project);
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("rejects traversal and unbounded session identifiers before launch", async () => {
    const registry = new SessionRegistry();
    const starts: StartSessionOptions[] = [];
    const ctx = makeCtx(registry, 50);
    ctx.launchSession = async (options) => {
      starts.push(options);
      return { sessionKey: options.sessionKey, harness: "claude", model: "", permissionMode: "auto", reasons: [] };
    };
    const { ws, sent } = makeFakeWs();

    await createSession(ctx, {
      type: "create_session",
      sessionKey: "../../outside",
      cwd: process.cwd(),
    }, ws as unknown as Parameters<typeof createSession>[2]);

    expect(starts).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({ type: "session_error", error: "Invalid session key" });
  });

  it("sends a session-scoped session_error when sessionKey is supplied (LeaderNode UI can recover)", () => {
    const registry = new SessionRegistry();
    fillRegistryWithRunning(registry, 1);

    const { ws, sent } = makeFakeWs();
    const ctx = makeCtx(registry, 1);
    const cmd: WsCommand = {
      type: "create_session",
      sessionKey: "leader-rejected",
      prompt: "go",
    };

    createSession(ctx, cmd, ws as unknown as Parameters<typeof createSession>[2]);

    expect(sent).toHaveLength(1);
    const env = sent[0]?.payload as Record<string, unknown>;
    expect(env["topic"]).toBe("session:leader-rejected");
    expect(env["type"]).toBe("session_error");
    expect(env["sessionKey"]).toBe("leader-rejected");
    expect(typeof env["error"]).toBe("string");
    expect(env["error"]).toMatch(/Maximum session limit/);
  });

  it("falls back to global error when no sessionKey is supplied", () => {
    const registry = new SessionRegistry();
    fillRegistryWithRunning(registry, 1);

    const { ws, sent } = makeFakeWs();
    const ctx = makeCtx(registry, 1);
    const cmd: WsCommand = {
      type: "create_session",
      // no sessionKey
      prompt: "go",
    };

    createSession(ctx, cmd, ws as unknown as Parameters<typeof createSession>[2]);

    expect(sent).toHaveLength(1);
    const env = sent[0]?.payload as Record<string, unknown>;
    expect(env["topic"]).toBe("global");
    expect(env["type"]).toBe("error");
  });

  it("forwards `permissionMode` into registry.start so the harness sees it", () => {
    const registry = new SessionRegistry();
    const starts: StartSessionOptions[] = [];
    (registry as unknown as { start: (opts: StartSessionOptions) => void }).start = (
      opts,
    ) => {
      starts.push(opts);
    };

    const { ws } = makeFakeWs();
    const ctx = makeCtx(registry, 50);
    const cmd: WsCommand = {
      type: "create_session",
      sessionKey: "leader-perm",
      prompt: "hi",
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
    };

    createSession(ctx, cmd, ws as unknown as Parameters<typeof createSession>[2]);

    expect(starts).toHaveLength(1);
    expect(starts[0]?.permissionMode).toBe("bypassPermissions");
  });

  it("forwards the explicit sandbox policy without coupling its axes", async () => {
    const registry = new SessionRegistry();
    const starts: StartSessionOptions[] = [];
    const ctx = makeCtx(registry, 50);
    ctx.launchSession = async (options) => {
      starts.push(options);
      return { sessionKey: options.sessionKey, harness: "codex", model: "", permissionMode: "auto", reasons: [] };
    };
    const { ws } = makeFakeWs();
    const sandboxPolicy: SandboxPolicy = {
      filesystemScope: "workspace-write",
      approvalPolicy: "never",
    };

    await createSession(ctx, {
      type: "create_session", sessionKey: "leader-sandbox", prompt: "hi",
      cwd: process.cwd(), harness: "codex", sandboxPolicy,
    }, ws as unknown as Parameters<typeof createSession>[2]);

    expect((starts[0] as StartSessionOptions & { sandboxPolicy?: SandboxPolicy }).sandboxPolicy)
      .toEqual(sandboxPolicy);
  });

  it("omits permissionMode from the registry.start payload when the command lacks it", () => {
    const registry = new SessionRegistry();
    const starts: StartSessionOptions[] = [];
    (registry as unknown as { start: (opts: StartSessionOptions) => void }).start = (
      opts,
    ) => {
      starts.push(opts);
    };

    const { ws } = makeFakeWs();
    const ctx = makeCtx(registry, 50);
    const cmd: WsCommand = {
      type: "create_session",
      sessionKey: "leader-no-perm",
      prompt: "hi",
      cwd: process.cwd(),
    };

    createSession(ctx, cmd, ws as unknown as Parameters<typeof createSession>[2]);

    expect(starts).toHaveLength(1);
    expect(starts[0]).not.toHaveProperty("permissionMode");
  });

  it("forwards a valid `harness` into registry.start so the host runs on it", async () => {
    const registry = new SessionRegistry();
    // Capture every registry.start() call.
    const starts: StartSessionOptions[] = [];
    (registry as unknown as { start: (opts: StartSessionOptions) => void }).start = (
      opts,
    ) => {
      starts.push(opts);
    };

    const { ws, sent } = makeFakeWs();
    const ctx = makeCtx(registry, 50);
    const cmd: WsCommand = {
      type: "create_session",
      sessionKey: "leader-echo",
      prompt: "hi",
      cwd: process.cwd(),
      harness: "echo",
    };

    await createSession(ctx, cmd, ws as unknown as Parameters<typeof createSession>[2]);

    expect(starts).toHaveLength(1);
    expect(starts[0]?.harness).toBe("echo");
    const types = sent.map((m) => (m.payload as { type: string }).type);
    expect(types).toContain("session_created");
    expect(types).not.toContain("session_error");
  });

  it("rejects an unknown harness with a session-scoped session_error and does not start a host", () => {
    const registry = new SessionRegistry();
    const starts: StartSessionOptions[] = [];
    (registry as unknown as { start: (opts: StartSessionOptions) => void }).start = (
      opts,
    ) => {
      starts.push(opts);
    };

    const { ws, sent } = makeFakeWs();
    const ctx = makeCtx(registry, 50);
    const cmd: WsCommand = {
      type: "create_session",
      sessionKey: "leader-bad-harness",
      prompt: "hi",
      cwd: process.cwd(),
      harness: "definitely-not-registered",
    };

    createSession(ctx, cmd, ws as unknown as Parameters<typeof createSession>[2]);

    // Host was never started.
    expect(starts).toHaveLength(0);
    expect(registry.has("leader-bad-harness")).toBe(false);

    // Session-scoped session_error envelope so the LeaderNode reducer
    // surfaces it; a global `error` would be silently dropped.
    expect(sent).toHaveLength(1);
    const env = sent[0]?.payload as Record<string, unknown>;
    expect(env["topic"]).toBe("session:leader-bad-harness");
    expect(env["type"]).toBe("session_error");
    expect(env["error"]).toMatch(/Unknown harness/);
    expect(env["error"]).toMatch(/definitely-not-registered/);
  });

  it("routes invalid-cwd rejection to the session topic too", () => {
    const registry = new SessionRegistry();
    registry.setDeps({
      bus: makeBus(),
      startChildSession: () => {},
      forEachLeaderTaskState: () => {},
    });

    const { ws, sent } = makeFakeWs();
    const ctx = makeCtx(registry, 50);
    const cmd: WsCommand = {
      type: "create_session",
      sessionKey: "leader-bad-cwd",
      prompt: "go",
      // path-guard rejects anything outside HOME — `/etc` is always outside
      cwd: "/etc",
    };

    createSession(ctx, cmd, ws as unknown as Parameters<typeof createSession>[2]);

    expect(sent).toHaveLength(1);
    const env = sent[0]?.payload as Record<string, unknown>;
    expect(env["topic"]).toBe("session:leader-bad-cwd");
    expect(env["type"]).toBe("session_error");
    expect(env["error"]).toMatch(/Invalid cwd/);
  });

  it("accepts an active worktree owned by a registry session", async () => {
    const worktreePath = fs.mkdtempSync(path.join(process.cwd(), ".minions-owned-wt-"));
    const registry = new SessionRegistry();
    const owner = new SessionHost("owner", process.cwd());
    owner.status = "running";
    owner.worktree = {
      path: worktreePath,
      projectPath: process.cwd(),
      branch: "canvas/owner",
      leaderSessionKey: "owner",
      createdAt: Date.now(),
      lifecycle: "active",
    };
    (registry as unknown as { map: Map<string, SessionHost> }).map.set(owner.id, owner);
    const starts: StartSessionOptions[] = [];
    const ctx = makeCtx(registry, 50);
    ctx.launchSession = async (options) => {
      starts.push(options);
      return { sessionKey: options.sessionKey, harness: "claude", model: "", permissionMode: "auto", reasons: [] };
    };

    try {
      const { ws } = makeFakeWs();
      await createSession(ctx, {
        type: "create_session",
        sessionKey: "child",
        cwd: worktreePath,
      }, ws as unknown as Parameters<typeof createSession>[2]);

      expect(starts).toHaveLength(1);
      expect(starts[0]?.cwd).toBe(fs.realpathSync(worktreePath));
    } finally {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  });
});
