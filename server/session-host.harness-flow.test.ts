/**
 * Phase B regression: harness flow into spawned children.
 *
 * Pins:
 *  1. A leader running under harness X spawns minions under harness X by
 *     default — `startMinionSession({...})` from the agent context routes
 *     through `SessionHost.buildAgentContext`, which fills the leader's
 *     current `harnessName` when the caller omits one.
 *  2. An explicit `harness` override on `startMinionSession` is respected
 *     so a future agent type can spawn a minion on a different harness.
 *
 * Boundary mocks (per docs/testing-strategy.md §5.2):
 *  - `./harness/index.ts` — replaced with a fake AgentHarness that simply
 *    finishes with `init` + `done`. The host's start() runs through the
 *    real lifecycle but no SDK is touched.
 *  - `./session-persist.ts` — disabled via `disablePersistence()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NormalizedEvent } from "./harness/types.ts";

vi.mock("./harness/index.ts", () => ({
  getHarness: () => ({
    name: "claude",
    capabilities: {
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
    start: () => ({
      events: (async function* () {
        yield { kind: "init", sessionId: "s", model: "" } as NormalizedEvent;
        yield { kind: "done", reason: "stop" } as NormalizedEvent;
      })(),
      control: { abort: () => {} },
    }),
  }),
  registeredHarnessNames: () => ["claude", "echo"],
  registerHarness: () => {},
}));

import {
  SessionHost,
  type SessionHostDeps,
  type StartSessionOptions,
} from "./session-host.ts";
import { buildAgentContext } from "./session-host-run.ts";
import { createBus } from "./bus.ts";
import {
  closePersistDb,
  disablePersistence,
} from "./session-persist.ts";
import "./agents/index.ts"; // registers leader/minion/default

beforeEach(() => {
  disablePersistence();
});

afterEach(() => {
  closePersistDb();
});

function makeDeps(
  startChildSession: (opts: StartSessionOptions) => void,
): SessionHostDeps {
  const fakeWss = { clients: new Set() } as unknown as Parameters<
    typeof createBus
  >[0];
  return {
    bus: createBus(fakeWss),
    startChildSession,
    forEachLeaderTaskState: () => {},
  };
}

describe("Phase B — minion harness inheritance", () => {
  it("a leader running under harness X spawns a minion on harness X by default", async () => {
    const calls: StartSessionOptions[] = [];
    const deps = makeDeps((opts) => calls.push(opts));
    const host = new SessionHost("leader-1", "/tmp/work");

    // Drive the host through one start cycle so harnessName is set + the
    // agent context is built. The mocked harness yields init/done so the
    // run completes immediately.
    await host.start(
      {
        sessionKey: "leader-1",
        prompt: "hi",
        cwd: "/tmp/work",
        role: "leader",
        harness: "echo",
      },
      deps,
    );

    expect(host.harnessName).toBe("echo");

    // Re-build the agent context the way the host does internally and
    // call its `startMinionSession` to mirror what the leader's task
    // tools would do.
    const ctx = buildAgentContext(
      host,
      { sessionKey: "leader-1", prompt: "p", cwd: "/tmp/work" },
      deps,
    );

    if (!ctx.startMinionSession) {
      throw new Error("expected leader context to expose startMinionSession");
    }
    ctx.startMinionSession({
      sessionKey: "minion-1",
      prompt: "do",
      cwd: "/tmp/work",
      systemPrompt: "be a minion",
    });

    const spawn = calls.find((c) => c.sessionKey === "minion-1");
    expect(spawn).toBeDefined();
    expect(spawn?.harness).toBe("echo");
    expect(spawn?.role).toBe("minion");
  });

  it("an explicit harness override on startMinionSession is respected", async () => {
    const calls: StartSessionOptions[] = [];
    const deps = makeDeps((opts) => calls.push(opts));
    const host = new SessionHost("leader-2", "/tmp/work");

    await host.start(
      {
        sessionKey: "leader-2",
        prompt: "hi",
        cwd: "/tmp/work",
        role: "leader",
        harness: "echo",
      },
      deps,
    );

    const ctx = buildAgentContext(
      host,
      { sessionKey: "leader-2", prompt: "p", cwd: "/tmp/work" },
      deps,
    );

    if (!ctx.startMinionSession) {
      throw new Error("expected leader context to expose startMinionSession");
    }
    ctx.startMinionSession({
      sessionKey: "minion-claude",
      prompt: "do",
      cwd: "/tmp/work",
      systemPrompt: "be a minion",
      harness: "claude",
    });

    const spawn = calls.find((c) => c.sessionKey === "minion-claude");
    expect(spawn?.harness).toBe("claude");
  });
});

describe("permissionMode flow into the host", () => {
  it("captures the initial permissionMode from StartSessionOptions on first run", async () => {
    const deps = makeDeps(() => {});
    const host = new SessionHost("leader-perm", "/tmp/work");

    expect(host.permissionMode).toBeNull();

    await host.start(
      {
        sessionKey: "leader-perm",
        prompt: "hi",
        cwd: "/tmp/work",
        role: "leader",
        harness: "echo",
        permissionMode: "bypassPermissions",
      },
      deps,
    );

    expect(host.permissionMode).toBe("bypassPermissions");
  });

  it("does not clobber a persisted permissionMode on a subsequent start", async () => {
    const deps = makeDeps(() => {});
    const host = new SessionHost("leader-perm-2", "/tmp/work");
    // Simulate a previous live `set_permission_mode` having taken effect.
    host.permissionMode = "auto";

    await host.start(
      {
        sessionKey: "leader-perm-2",
        prompt: "hi",
        cwd: "/tmp/work",
        role: "leader",
        harness: "echo",
        permissionMode: "bypassPermissions",
      },
      deps,
    );

    expect(host.permissionMode).toBe("auto");
  });
});
