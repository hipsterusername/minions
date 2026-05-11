/**
 * Integration tests for the session-persist glue layer.
 *
 * Unlike `session-repo.test.ts` (pure CRUD), these tests drive the glue
 * helpers — `persistSession`, `persistTaskState`, `persistRenderState`,
 * `removePersistedSession`, `hydrateSessionsFromDb` — end to end against a
 * real on-disk SQLite file, simulating a full server restart.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closePersistDb,
  disablePersistence,
  hydrateSessionsFromDb,
  loadRecentEvents,
  openPersistDb,
  persistEvent,
  persistRenderState,
  persistSession,
  persistTaskState,
  removePersistedSession,
  type PersistableSession,
} from "./session-persist.ts";
import type { TaskManagerState, TaskRecord } from "./task-tools.ts";
import type { RenderState } from "./render-tools.ts";
import {
  MAX_BUFFERED_EVENTS,
  type BufferedEvent,
} from "./session-host-config.ts";

function makeTmpDbPath(): string {
  return path.join(
    os.tmpdir(),
    `minions-persist-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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

function makeSession(overrides: Partial<PersistableSession> = {}): PersistableSession {
  return {
    id: "sess-1",
    status: "running",
    cwd: "/tmp/work",
    model: "sonnet",
    role: "leader",
    taskName: "Phase 4",
    sessionId: null,
    worktreeIsolation: true,
    totalCost: 0.15,
    turns: 5,
    harnessName: "claude",
    ...overrides,
  };
}

function makeTaskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "t1",
    leaderSessionKey: "sess-1",
    title: "Do it",
    description: "",
    priority: "high",
    executor: "minion",
    minionSessionKey: "m1",
    status: "running",
    result: null,
    createdAt: Date.now(),
    completedAt: null,
    ...overrides,
  };
}

function makeTaskState(records: TaskRecord[]): TaskManagerState {
  return {
    tasks: new Map(records.map((r) => [r.taskId, r])),
    pendingWait: null,
    approval: null,
  };
}

function makeRenderState(overrides: Partial<RenderState> = {}): RenderState {
  return {
    title: "Dash",
    columns: 2,
    gap: 12,
    components: [{ id: "m", type: "metric", label: "N", value: "1" }],
    ...overrides,
  };
}

describe("session-persist integration", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    process.env["MINIONS_SERVER_DB"] = dbPath;
    // Force a clean handle each test
    closePersistDb();
    openPersistDb();
  });

  afterEach(() => {
    closePersistDb();
    delete process.env["MINIONS_SERVER_DB"];
    rmDb(dbPath);
  });

  it("hydrate returns [] when the DB is empty", () => {
    expect(hydrateSessionsFromDb()).toEqual([]);
  });

  it("persistSession round-trips via hydrate", () => {
    persistSession(makeSession());
    const hydrated = hydrateSessionsFromDb();
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]?.row.session_key).toBe("sess-1");
    expect(hydrated[0]?.row.role).toBe("leader");
    expect(hydrated[0]?.row.worktree_isolation).toBe(1);
    expect(hydrated[0]?.row.total_cost).toBeCloseTo(0.15);
    // Leader role yields an empty but present TaskManagerState map.
    expect(hydrated[0]?.tasks?.tasks.size).toBe(0);
  });

  it("persistTaskState removes stale rows and upserts current ones", () => {
    persistSession(makeSession());
    const t1 = makeTaskRecord({ taskId: "t1" });
    const t2 = makeTaskRecord({ taskId: "t2", status: "planned" });
    persistTaskState("sess-1", makeTaskState([t1, t2]));

    // Now drop t1 and add t3
    const t3 = makeTaskRecord({ taskId: "t3", status: "completed" });
    persistTaskState("sess-1", makeTaskState([t2, t3]));

    const hydrated = hydrateSessionsFromDb();
    const tasks = hydrated[0]?.tasks?.tasks;
    expect(Array.from(tasks?.keys() ?? []).sort()).toEqual(["t2", "t3"]);
  });

  it("persistRenderState round-trips dashboard shape", () => {
    persistSession(makeSession());
    persistRenderState(
      "sess-1",
      makeRenderState({
        title: "Hello",
        columns: 3,
        components: [
          { id: "s", type: "status", label: "Build", state: "success" },
        ],
      }),
    );
    const hydrated = hydrateSessionsFromDb();
    expect(hydrated[0]?.render?.title).toBe("Hello");
    expect(hydrated[0]?.render?.columns).toBe(3);
    expect(hydrated[0]?.render?.components).toHaveLength(1);
    expect(hydrated[0]?.render?.components[0]?.id).toBe("s");
  });

  it("removePersistedSession deletes the row + task records + render state + events", () => {
    persistSession(makeSession());
    persistTaskState("sess-1", makeTaskState([makeTaskRecord()]));
    persistRenderState("sess-1", makeRenderState());
    persistEvent("sess-1", {
      type: "sdk_event",
      sessionKey: "sess-1",
      timestamp: 1,
    });

    removePersistedSession("sess-1");

    const hydrated = hydrateSessionsFromDb();
    expect(hydrated).toEqual([]);
    expect(loadRecentEvents("sess-1")).toEqual([]);
  });

  it("persisted events round-trip via hydrate (regression: completed leader chat history was lost on restart)", () => {
    persistSession(makeSession());
    const evt1: BufferedEvent = {
      type: "sdk_event",
      sessionKey: "sess-1",
      message: { type: "assistant", content: "first turn" },
      timestamp: 1000,
    };
    const evt2: BufferedEvent = {
      type: "session_status",
      sessionKey: "sess-1",
      status: "completed",
      timestamp: 2000,
    };
    persistEvent("sess-1", evt1);
    persistEvent("sess-1", evt2);

    const hydrated = hydrateSessionsFromDb();
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]?.events).toHaveLength(2);
    expect(hydrated[0]?.events[0]).toEqual(evt1);
    expect(hydrated[0]?.events[1]).toEqual(evt2);
  });

  it("hydrate caps restored events at MAX_BUFFERED_EVENTS, returning the most recent in chronological order", () => {
    persistSession(makeSession());
    const overflow = MAX_BUFFERED_EVENTS + 25;
    for (let i = 0; i < overflow; i++) {
      persistEvent("sess-1", {
        type: "sdk_event",
        sessionKey: "sess-1",
        message: { i },
        timestamp: i,
      });
    }
    const hydrated = hydrateSessionsFromDb();
    const events = hydrated[0]?.events ?? [];
    expect(events).toHaveLength(MAX_BUFFERED_EVENTS);
    // The first restored event is the (overflow - MAX) th written.
    const firstMessage = events[0]?.message as { i: number };
    const lastMessage = events.at(-1)?.message as { i: number };
    expect(firstMessage.i).toBe(overflow - MAX_BUFFERED_EVENTS);
    expect(lastMessage.i).toBe(overflow - 1);
  });

  // Note: a "simulated restart of a completed session: events survive"
  // test was removed per testing-strategy.md §5.9 (DUPLICATE) — the
  // restart-and-reopen contract is exercised by the case below; the
  // events-survive property is exercised by the live persistEvent tests
  // earlier in the file.

  it("simulated server restart: close the handle, reopen, and state is intact", () => {
    const leader = makeSession({ id: "L", role: "leader", taskName: "Phase 4" });
    persistSession(leader);
    persistTaskState(
      "L",
      makeTaskState([
        makeTaskRecord({
          taskId: "plan",
          leaderSessionKey: "L",
          status: "planned",
        }),
        makeTaskRecord({
          taskId: "run",
          leaderSessionKey: "L",
          status: "running",
          minionSessionKey: "M",
        }),
      ]),
    );
    persistRenderState("L", makeRenderState({ title: "restart-me" }));

    // Simulate restart: close DB, reopen from the same on-disk file.
    closePersistDb();
    openPersistDb(dbPath);

    const hydrated = hydrateSessionsFromDb();
    expect(hydrated).toHaveLength(1);
    const entry = hydrated[0]!;
    expect(entry.row.session_key).toBe("L");
    expect(entry.row.task_name).toBe("Phase 4");
    expect(entry.tasks?.tasks.size).toBe(2);
    expect(entry.tasks?.tasks.get("run")?.minionSessionKey).toBe("M");
    expect(entry.render?.title).toBe("restart-me");
  });

  it("harnessName round-trips through persist/hydrate", () => {
    persistSession(makeSession({ id: "echo-sess", harnessName: "echo" }));
    const hydrated = hydrateSessionsFromDb();
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]?.row.harness_name).toBe("echo");
  });

  it("rows written before the harness column existed hydrate as 'claude'", () => {
    // Simulate a pre-migration row by inserting one with the column dropped
    // and then re-running the migration. We mimic this by writing a row via
    // raw SQL that omits harness_name and relies on the schema default.
    const db = openPersistDb();
    db.prepare(
      `INSERT INTO sessions (
        session_key, status, cwd, role, total_cost, turns,
        worktree_isolation, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("legacy", "stopped", "/tmp/legacy", "leader", 0, 0, 0, "now", "now");

    const hydrated = hydrateSessionsFromDb();
    const row = hydrated.find((h) => h.row.session_key === "legacy");
    expect(row?.row.harness_name).toBe("claude");
  });
});

// Note: a `describe("session-persist safety")` with a single
// `disablePersistence` no-op chain was removed per testing-strategy.md §5.7
// (TRIVIAL) — calling no-op helpers on a disabled persister is the
// definition of disablePersistence().
