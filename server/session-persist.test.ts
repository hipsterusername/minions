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
  openPersistDb,
  persistRenderState,
  persistSession,
  persistTaskState,
  removePersistedSession,
  type PersistableSession,
} from "./session-persist.ts";
import type { TaskManagerState, TaskRecord } from "./task-tools.ts";
import type { RenderState } from "./render-tools.ts";

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
    worktreeIsolation: true,
    totalCost: 0.15,
    turns: 5,
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

  it("removePersistedSession deletes the row + task records + render state", () => {
    persistSession(makeSession());
    persistTaskState("sess-1", makeTaskState([makeTaskRecord()]));
    persistRenderState("sess-1", makeRenderState());

    removePersistedSession("sess-1");

    const hydrated = hydrateSessionsFromDb();
    expect(hydrated).toEqual([]);
  });

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
});

describe("session-persist safety", () => {
  it("disablePersistence causes every helper to no-op safely", () => {
    disablePersistence();
    expect(() => persistSession(makeSession())).not.toThrow();
    expect(() =>
      persistTaskState("x", makeTaskState([makeTaskRecord()])),
    ).not.toThrow();
    expect(() => persistRenderState("x", makeRenderState())).not.toThrow();
    expect(() => removePersistedSession("x")).not.toThrow();
    expect(hydrateSessionsFromDb()).toEqual([]);
  });
});
