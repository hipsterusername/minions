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
});
