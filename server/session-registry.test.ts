/**
 * Tests for `SessionRegistry` — focused on the cap semantics and the
 * hydration round-trip that drives the post-Phase-4.4 regression.
 *
 * Background: a project that has accumulated N persisted sessions where
 * N === MAX_SESSIONS used to make every new `create_session` fail at
 * boot, because hydration filled the map but the cap counted on-disk
 * rows instead of live sessions. `activeCount()` is the fix; these
 * tests pin its semantics so the regression doesn't slip back in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionRegistry } from "./session-registry.ts";
import { SessionHost } from "./session-host.ts";
import {
  closePersistDb,
  disablePersistence,
  openPersistDb,
  persistTaskState,
  persistSession,
  type PersistableSession,
} from "./session-persist.ts";
import { createBus } from "./bus.ts";
import type { WebSocketServer } from "ws";
import { drainQueuedWaitResume, getQueuedWaitResume } from "./wait-resume.ts";

function tmpDb(): string {
  return path.join(
    os.tmpdir(),
    `minions-registry-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function rmDb(p: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(`${p}${suffix}`, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function makePersisted(
  overrides: Partial<PersistableSession> = {},
): PersistableSession {
  return {
    id: "sess-1",
    status: "idle",
    cwd: "/tmp/work",
    model: "sonnet",
    role: "leader",
    taskName: "Old work",
    sessionId: "sdk-uuid-1",
    worktreeIsolation: false,
    worktree: null,
    approval: null,
    totalCost: 0.1,
    turns: 1,
    harnessName: "claude",
    ...overrides,
  };
}

describe("SessionRegistry.activeCount", () => {
  // Note: an "empty registry returns 0" trivial was removed per
  // testing-strategy.md §5.7, and an "excludes hosts with status 'stopped'"
  // single-host case was removed per §5.2 — both branches are exercised by
  // the multi-status case below, which already includes one stopped host.

  it("counts hosts with non-stopped statuses", () => {
    const r = new SessionRegistry();
    const map = (r as unknown as { map: Map<string, SessionHost> }).map;
    for (const [key, status] of [
      ["run", "running"],
      ["idle", "idle"],
      ["err", "error"],
      ["done", "completed"],
      ["off", "stopped"],
    ] as const) {
      const h = new SessionHost(key, "/tmp");
      h.status = status;
      map.set(key, h);
    }
    expect(r.activeCount()).toBe(4);
  });
});

describe("SessionRegistry.getSessionRuntime", () => {
  it("returns live host metadata and last activity details", () => {
    const r = new SessionRegistry();
    const map = (r as unknown as { map: Map<string, SessionHost> }).map;
    const h = new SessionHost("minion-1", "/tmp/work");
    h.status = "running";
    h.role = "minion";
    h.sessionId = "sdk-1";
    h.model = "sonnet";
    h.harnessName = "claude";
    h.totalCost = 0.5;
    h.turns = 3;
    h.eventStream = (async function* () {})();
    h.eventBuffer = [
      {
        type: "session_status",
        sessionKey: "minion-1",
        status: "running",
        timestamp: 1000,
      },
      {
        type: "sdk_event",
        sessionKey: "minion-1",
        event: { kind: "tool_progress", id: "t", name: "Bash", elapsedSeconds: 1 },
        timestamp: Date.now(),
      },
    ];
    map.set("minion-1", h);

    const runtime = r.getSessionRuntime("minion-1");
    expect(runtime).toMatchObject({
      sessionKey: "minion-1",
      sessionId: "sdk-1",
      status: "running",
      role: "minion",
      cwd: "/tmp/work",
      model: "sonnet",
      harness: "claude",
      totalCost: 0.5,
      turns: 3,
      isLive: true,
      lastEventType: "sdk_event",
      lastSdkEventKind: "tool_progress",
      lastError: null,
    });
    expect(runtime?.lastActivityAgeMs).toBeGreaterThanOrEqual(0);
  });

  it("returns null for unknown sessions", () => {
    const r = new SessionRegistry();
    expect(r.getSessionRuntime("missing")).toBeNull();
  });

  it("wakes a pending leader wait when all minion tasks are terminal", () => {
    disablePersistence();
    const r = new SessionRegistry();
    const map = (r as unknown as { map: Map<string, SessionHost> }).map;
    const startChildSession = vi.fn();
    const h = new SessionHost("leader-1", "/tmp/work");
    h.role = "leader";
    h.sessionId = "sdk-1";
    h.waitTimerId = setTimeout(() => {}, 30_000);
    h.taskState = {
      tasks: new Map([
        ["t1", {
          taskId: "t1",
          title: "T1",
          description: "",
          priority: "medium",
          executor: "minion",
          minionSessionKey: "minion-1",
          leaderSessionKey: "leader-1",
          status: "completed",
          createdAt: 1,
          completedAt: 2,
          result: "done",
        }],
      ]),
      pendingWait: {
        durationMs: 30_000,
        reason: "waiting on minions",
        scheduledAt: 1,
        timerId: h.waitTimerId,
      },
      approval: null,
    };
    map.set("leader-1", h);
    r.setDeps({
      bus: createBus({ clients: new Set() } as unknown as WebSocketServer),
      startChildSession,
      forEachLeaderTaskState: r.forEachLeaderTaskState,
    });

    r.wakeWaitingLeaderIfAllChildrenTerminal("leader-1");

    expect(h.waitTimerId).toBeNull();
    expect(h.taskState.pendingWait).toBeNull();
    expect(startChildSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: "leader-1",
      resumeId: "sdk-1",
    }));
  });
});

describe("SessionRegistry.wakeWaitingLeaderIfAllChildrenTerminal — wake policies, digest, and idle wake", () => {
  function makeRegistry() {
    const r = new SessionRegistry();
    const map = (r as unknown as { map: Map<string, SessionHost> }).map;
    const startChildSession = vi.fn();
    const deps = {
      bus: createBus({ clients: new Set() } as unknown as WebSocketServer),
      startChildSession,
      forEachLeaderTaskState: r.forEachLeaderTaskState,
    };
    r.setDeps(deps);
    return { r, map, startChildSession, deps };
  }

  function makeLeader(id = "leader-1") {
    const h = new SessionHost(id, "/tmp/work");
    h.role = "leader";
    h.sessionId = "sdk-1";
    h.status = "idle";
    return h;
  }

  function makeTask(
    overrides: Partial<{
      taskId: string;
      status: string;
      executor: string;
      completedAt: number | null;
      result: string | null;
    }> = {},
  ) {
    return {
      taskId: overrides.taskId ?? "t1",
      title: "Task",
      description: "",
      priority: "medium" as const,
      executor: (overrides.executor ?? "minion") as "minion" | "leader",
      minionSessionKey: "minion-1",
      leaderSessionKey: "leader-1",
      status: (overrides.status ?? "completed") as import("./task-tools/types.ts").TaskStatus,
      createdAt: 100,
      completedAt: overrides.completedAt ?? 200,
      result: overrides.result ?? "done",
    };
  }

  beforeEach(() => {
    disablePersistence();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("any_terminal policy wakes when at least one of two children is terminal", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { r, map, startChildSession } = makeRegistry();
    const h = makeLeader();
    h.waitTimerId = setTimeout(() => {}, 30_000);
    h.taskState = {
      tasks: new Map([
        ["t1", makeTask({ taskId: "t1", status: "completed", completedAt: 150 })],
        ["t2", makeTask({ taskId: "t2", status: "running", completedAt: null })],
      ]),
      pendingWait: {
        durationMs: 30_000,
        reason: "pipeline",
        scheduledAt: 100,
        timerId: h.waitTimerId,
        wakeOn: "any_terminal",
      },
      approval: null,
    };
    map.set("leader-1", h);

    r.wakeWaitingLeaderIfAllChildrenTerminal("leader-1");

    expect(startChildSession).not.toHaveBeenCalled();
    expect(h.taskState.pendingWait).toBeNull();
    vi.advanceTimersByTime(15_000);
    expect(startChildSession).toHaveBeenCalledOnce();
  });

  it("queues the wake when children finish before the leader run is idle", () => {
    const { r, map, startChildSession, deps } = makeRegistry();
    const h = makeLeader();
    h.status = "running";
    h.waitTimerId = setTimeout(() => {}, 30_000);
    h.taskState = {
      tasks: new Map([
        ["t1", makeTask({ taskId: "t1", status: "completed", completedAt: 150 })],
      ]),
      pendingWait: {
        durationMs: 30_000,
        reason: "waiting for fast child",
        scheduledAt: 100,
        timerId: h.waitTimerId,
      },
      approval: null,
    };
    map.set("leader-1", h);

    r.wakeWaitingLeaderIfAllChildrenTerminal("leader-1");

    expect(startChildSession).not.toHaveBeenCalled();
    expect(h.waitTimerId).toBeNull();
    expect(h.taskState.pendingWait).not.toBeNull();
    expect(getQueuedWaitResume(h)?.opts.prompt).toContain("waiting for fast child");

    h.status = "idle";
    drainQueuedWaitResume(h, deps);

    expect(h.taskState.pendingWait).toBeNull();
    expect(startChildSession).toHaveBeenCalledOnce();
  });

  it("all_terminal policy does NOT wake when only one of two children is terminal", () => {
    const { r, map, startChildSession } = makeRegistry();
    const h = makeLeader();
    h.waitTimerId = setTimeout(() => {}, 30_000);
    h.taskState = {
      tasks: new Map([
        ["t1", makeTask({ taskId: "t1", status: "completed", completedAt: 150 })],
        ["t2", makeTask({ taskId: "t2", status: "running", completedAt: null })],
      ]),
      pendingWait: {
        durationMs: 30_000,
        reason: "waiting for all",
        scheduledAt: 100,
        timerId: h.waitTimerId,
        wakeOn: "all_terminal",
      },
      approval: null,
    };
    map.set("leader-1", h);

    r.wakeWaitingLeaderIfAllChildrenTerminal("leader-1");

    expect(startChildSession).not.toHaveBeenCalled();
    expect(h.taskState.pendingWait).not.toBeNull();
  });

  it("digest includes only tasks that became terminal after scheduledAt, with truncated result", () => {
    const { r, map, startChildSession } = makeRegistry();
    const h = makeLeader();
    const scheduledAt = 500;
    const longResult = "x".repeat(300);
    h.waitTimerId = setTimeout(() => {}, 30_000);
    h.taskState = {
      tasks: new Map([
        // completedAt BEFORE scheduledAt — should NOT appear in digest
        ["old", makeTask({ taskId: "old", status: "completed", completedAt: 100, result: "old result" })],
        // completedAt AFTER scheduledAt — SHOULD appear, result truncated to 200
        ["new", makeTask({ taskId: "new", status: "failed", completedAt: 600, result: longResult })],
      ]),
      pendingWait: {
        durationMs: 30_000,
        reason: "waiting",
        scheduledAt,
        timerId: h.waitTimerId,
      },
      approval: null,
    };
    map.set("leader-1", h);

    r.wakeWaitingLeaderIfAllChildrenTerminal("leader-1");

    expect(startChildSession).toHaveBeenCalledOnce();
    const prompt: string = (startChildSession.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).toContain("new");
    expect(prompt).toContain("failed");
    expect(prompt).toContain("x".repeat(200));
    // old task should not be in prompt
    expect(prompt).not.toContain("old result");
  });

  it("idle leader is resumed when a child has completed while no wait was pending", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { r, map, startChildSession } = makeRegistry();
    const h = makeLeader();
    h.status = "idle";
    h.taskState = {
      tasks: new Map([
        ["t1", makeTask({ taskId: "t1", status: "completed", result: "great result" })],
      ]),
      pendingWait: null,
      approval: null,
    };
    map.set("leader-1", h);

    r.wakeWaitingLeaderIfAllChildrenTerminal("leader-1");

    expect(startChildSession).not.toHaveBeenCalled();
    vi.advanceTimersByTime(15_000);
    expect(startChildSession).toHaveBeenCalledOnce();
    const opts = startChildSession.mock.calls[0]![0] as { sessionKey: string; prompt: string };
    expect(opts.sessionKey).toBe("leader-1");
    expect(opts.prompt).toContain("t1");
    expect(opts.prompt).toContain("completed");
    expect(opts.prompt).toContain("great result");
  });

  it("coalesces multiple idle child completion wakes into one combined resume", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { r, map, startChildSession } = makeRegistry();
    const h = makeLeader();
    h.status = "idle";
    h.taskState = {
      tasks: new Map([
        ["t1", makeTask({ taskId: "t1", status: "completed", result: "first result" })],
      ]),
      pendingWait: null,
      approval: null,
    };
    map.set("leader-1", h);

    r.wakeWaitingLeaderIfAllChildrenTerminal("leader-1");
    h.taskState.tasks.set("t2", makeTask({ taskId: "t2", status: "failed", result: "second result" }));
    vi.advanceTimersByTime(1_000);
    r.wakeWaitingLeaderIfAllChildrenTerminal("leader-1");
    vi.advanceTimersByTime(14_999);

    expect(startChildSession).toHaveBeenCalledOnce();
    const prompt = (startChildSession.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).toContain("t1");
    expect(prompt).toContain("first result");
    expect(prompt).toContain("t2");
    expect(prompt).toContain("second result");
  });

  it("idle leader is NOT resumed when the only terminal children are cancelled", () => {
    const { r, map, startChildSession } = makeRegistry();
    const h = makeLeader();
    h.status = "idle";
    h.taskState = {
      tasks: new Map([
        ["t1", makeTask({ taskId: "t1", status: "cancelled", result: "cancelled" })],
      ]),
      pendingWait: null,
      approval: null,
    };
    map.set("leader-1", h);

    r.wakeWaitingLeaderIfAllChildrenTerminal("leader-1");

    expect(startChildSession).not.toHaveBeenCalled();
  });

  it("leader with an active run is not resumed via the idle-wake path", () => {
    const { r, map, startChildSession } = makeRegistry();
    const h = makeLeader();
    h.status = "running";
    // Simulate an active run — only the non-null check matters here
    h.runControl = { abort: () => {} } as unknown as NonNullable<typeof h.runControl>;
    h.taskState = {
      tasks: new Map([
        ["t1", makeTask({ taskId: "t1", status: "completed", result: "done" })],
      ]),
      pendingWait: null,
      approval: null,
    };
    map.set("leader-1", h);

    r.wakeWaitingLeaderIfAllChildrenTerminal("leader-1");

    expect(startChildSession).not.toHaveBeenCalled();
  });
});

describe("SessionRegistry.hydrateFromDb — sessionId round-trip", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    process.env["MINIONS_SERVER_DB"] = dbPath;
    closePersistDb();
    openPersistDb();
  });

  afterEach(() => {
    closePersistDb();
    delete process.env["MINIONS_SERVER_DB"];
    rmDb(dbPath);
  });

  it("restores host.sessionId from disk so resume can pass it as resumeId", () => {
    persistSession(makePersisted({ id: "leader-1", sessionId: "abc-123" }));
    const r = new SessionRegistry();
    r.hydrateFromDb();
    const host = r.get("leader-1");
    expect(host).toBeDefined();
    expect(host?.sessionId).toBe("abc-123");
  });

  it("hydrated sessions come back as 'stopped' so they don't count against the cap", () => {
    // Persist N === any cap and hydrate — activeCount should stay 0
    // because hydrated rows resurrect with status "stopped". This is
    // the exact scenario that broke NEW leader initiation: a populated
    // DB used to push registry.size up to MAX_SESSIONS instantly.
    for (let i = 0; i < 10; i++) {
      persistSession(makePersisted({ id: `leader-${i}`, sessionId: `s-${i}` }));
    }
    const r = new SessionRegistry();
    r.hydrateFromDb();
    expect(r.size).toBe(10);
    expect(r.activeCount()).toBe(0);
  });

  it("hydrates active worktree metadata and approval state back onto the host", () => {
    persistSession(makePersisted({
      id: "leader-wt",
      worktreeIsolation: true,
      worktree: {
        path: "/tmp/project/.canvas-worktrees/leader-wt",
        branch: "canvas/leader-wt",
        leaderSessionKey: "leader-wt",
        createdAt: 123,
        projectPath: "/tmp/project",
        lifecycle: "active",
      },
      approval: {
        requested: true,
        requestedAt: 456,
        summary: "ready",
        diff: null,
      },
    }));

    const r = new SessionRegistry();
    r.hydrateFromDb();

    const host = r.get("leader-wt");
    expect(host?.worktree?.path).toBe("/tmp/project/.canvas-worktrees/leader-wt");
    expect(host?.worktree?.projectPath).toBe("/tmp/project");
    expect(host?.cwd).toBe("/tmp/project/.canvas-worktrees/leader-wt");
    expect(host?.taskState?.approval?.summary).toBe("ready");
  });

  it("preserves null sessionId for pre-migration rows", () => {
    persistSession(makePersisted({ id: "old-leader", sessionId: null }));
    const r = new SessionRegistry();
    r.hydrateFromDb();
    expect(r.get("old-leader")?.sessionId).toBeNull();
  });

  it("marks persisted running tasks as orphaned during hydration", () => {
    persistSession(makePersisted({ id: "leader-orphan", role: "leader" }));
    persistTaskState("leader-orphan", {
      tasks: new Map([
        [
          "t1",
          {
            taskId: "t1",
            title: "T1",
            description: "",
            priority: "medium",
            executor: "minion",
            minionSessionKey: "minion-missing",
            leaderSessionKey: "leader-orphan",
            status: "running",
            createdAt: Date.now(),
            completedAt: null,
            result: null,
          },
        ],
      ]),
      pendingWait: null,
      approval: null,
    });

    const r = new SessionRegistry();
    r.setDeps({
      bus: createBus({ clients: new Set() } as unknown as WebSocketServer),
      startChildSession: () => {},
      forEachLeaderTaskState: r.forEachLeaderTaskState,
    });
    r.hydrateFromDb();

    expect(r.get("leader-orphan")?.taskState?.tasks.get("t1")?.status).toBe("orphaned");
  });

  it("marks persisted blocked tasks as orphaned during hydration", () => {
    persistSession(makePersisted({ id: "leader-blocked-orphan", role: "leader" }));
    persistTaskState("leader-blocked-orphan", {
      tasks: new Map([
        [
          "t1",
          {
            taskId: "t1",
            title: "T1",
            description: "",
            priority: "medium",
            executor: "minion",
            minionSessionKey: "minion-missing",
            leaderSessionKey: "leader-blocked-orphan",
            status: "blocked",
            createdAt: Date.now(),
            completedAt: null,
            result: null,
          },
        ],
      ]),
      pendingWait: null,
      approval: null,
    });

    const r = new SessionRegistry();
    r.setDeps({
      bus: createBus({ clients: new Set() } as unknown as WebSocketServer),
      startChildSession: () => {},
      forEachLeaderTaskState: r.forEachLeaderTaskState,
    });
    r.hydrateFromDb();

    expect(r.get("leader-blocked-orphan")?.taskState?.tasks.get("t1")?.status).toBe("orphaned");
  });
});
