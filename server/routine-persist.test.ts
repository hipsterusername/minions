/**
 * Tests for server/routine-persist.ts
 *
 * Drives persistRun, loadRecentRuns, pruneRunsOlderThan,
 * disableRoutinePersist, and enableRoutinePersist against a real on-disk
 * SQLite file. Also verifies the RoutineRunRegistry hydration contract and
 * the routine_runs migration smoke.
 *
 * DB lifecycle pattern: set MINIONS_SERVER_DB to a temp path, closePersistDb
 * (clear the singleton), openPersistDb(tmpPath) to wire the handle, then
 * clean up in afterEach. Mirrors session-persist.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initDb } from "./db.ts";
import { closePersistDb, openPersistDb } from "./session-persist.ts";
import {
  disableRoutinePersist,
  enableRoutinePersist,
  loadRecentRuns,
  MAX_RETAINED_RUNS,
  persistRun,
  pruneRunsOlderThan,
} from "./routine-persist.ts";
import { RoutineRunRegistry } from "./routine-registry.ts";
import type { Bus } from "./bus.ts";
import type { SessionRegistry } from "./session-registry.ts";
import type { RoutineRunSnapshot } from "../shared/routines/types.ts";

// ── Shared helpers ───────────────────────────────────────────────────────────

function tmpDbPath(): string {
  return path.join(
    os.tmpdir(),
    `routine-persist-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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

let snapshotSeq = 0;

function makeSnapshot(
  overrides: Partial<RoutineRunSnapshot> = {},
): RoutineRunSnapshot {
  const id = `run${++snapshotSeq}`;
  return {
    runId: id,
    routineId: "my-routine",
    routineName: "My Routine",
    state: "success",
    inputs: {},
    phases: [
      {
        phaseId: "p1",
        label: "Phase 1",
        state: "success",
        steps: [{ stepId: "s1", label: "Step 1" }],
      },
    ],
    startedAt: new Date(Date.now() - 3600_000).toISOString(), // 1 hour ago
    endedAt: new Date(Date.now() - 1800_000).toISOString(), // 30 min ago
    ...overrides,
  };
}

/** Minimal Bus stub — records emitted global payloads. */
function makeFakeBus(): Bus {
  return {
    emit: () => {},
    emitToSession: () => {},
    emitToProject: () => {},
    emitGlobal: () => {},
    subscribe: () => () => {},
  };
}

/** Minimal SessionRegistry stub — unused during hydration/abort tests. */
const nullSessionRegistry = {
  start: () => {},
  get: () => null,
} as unknown as SessionRegistry;

function openFreshDb(dbPath: string): void {
  process.env["MINIONS_SERVER_DB"] = dbPath;
  closePersistDb();
  openPersistDb(dbPath);
  enableRoutinePersist();
}

function cleanupDb(dbPath: string): void {
  closePersistDb();
  delete process.env["MINIONS_SERVER_DB"];
  rmDb(dbPath);
  enableRoutinePersist(); // guard against leaking disabled state across tests
}

// ── persistRun + loadRecentRuns ──────────────────────────────────────────────

describe("routine-persist / persistRun + loadRecentRuns", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    openFreshDb(dbPath);
  });

  afterEach(() => {
    cleanupDb(dbPath);
  });

  it("round-trip preserves every snapshot field", () => {
    const snap = makeSnapshot({
      state: "success",
      inputs: { env: "prod", retries: 3, flag: true },
      endedAt: "2026-04-01T02:00:00.000Z",
      error: undefined,
    });
    persistRun(snap, "/my/project");

    const loaded = loadRecentRuns("/my/project", 10);
    expect(loaded).toHaveLength(1);
    const got = loaded[0]!;
    expect(got.runId).toBe(snap.runId);
    expect(got.routineId).toBe("my-routine");
    expect(got.routineName).toBe("My Routine");
    expect(got.state).toBe("success");
    expect(got.inputs).toEqual({ env: "prod", retries: 3, flag: true });
    expect(got.phases).toHaveLength(1);
    expect(got.phases[0]?.phaseId).toBe("p1");
    expect(got.phases[0]?.steps[0]?.stepId).toBe("s1");
    expect(got.startedAt).toBe(snap.startedAt);
    expect(got.endedAt).toBe("2026-04-01T02:00:00.000Z");
  });

  it("upserts on the same run_id — last write wins", () => {
    const snap = makeSnapshot({ state: "pending", endedAt: undefined });
    persistRun(snap, "/project");
    // Transition to terminal
    const updated: RoutineRunSnapshot = {
      ...snap,
      state: "success",
      endedAt: new Date().toISOString(),
    };
    persistRun(updated, "/project");

    const loaded = loadRecentRuns("/project", 10);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.state).toBe("success");
  });

  it("null projectPath returns runs across all projects", () => {
    persistRun(makeSnapshot({ state: "success" }), "/project/alpha");
    persistRun(makeSnapshot({ state: "error" }), "/project/beta");

    const all = loadRecentRuns(null, 10);
    expect(all.length).toBeGreaterThanOrEqual(2);
    const ids = all.map((r) => r.routineId);
    expect(ids.every((id) => id === "my-routine")).toBe(true);
  });

  it("only returns terminal states (success, error, aborted) — not pending or running", () => {
    persistRun(makeSnapshot({ state: "success" }), "/p");
    persistRun(makeSnapshot({ state: "error" }), "/p");
    persistRun(makeSnapshot({ state: "aborted" }), "/p");
    persistRun(makeSnapshot({ state: "pending", endedAt: undefined }), "/p");
    persistRun(makeSnapshot({ state: "running", endedAt: undefined }), "/p");

    const loaded = loadRecentRuns("/p", 20);
    expect(loaded).toHaveLength(3);
    const states = loaded.map((s) => s.state).sort();
    expect(states).toEqual(["aborted", "error", "success"]);
  });

  it("respects the limit parameter", () => {
    for (let i = 0; i < 6; i++) {
      persistRun(makeSnapshot({ state: "success" }), "/p");
    }
    const limited = loadRecentRuns("/p", 4);
    expect(limited).toHaveLength(4);
  });

  it("malformed JSON in snapshot_json is dropped silently", () => {
    // Inject a bad row directly, bypassing persistRun
    const db = openPersistDb();
    db.prepare(
      `INSERT INTO routine_runs
         (run_id, routine_id, project_path, snapshot_json, started_at, ended_at, state)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "bad-json-run",
      "r1",
      "/p",
      "{ not valid json ",
      new Date(Date.now() - 60_000).toISOString(),
      new Date().toISOString(),
      "success",
    );
    // A valid row alongside the bad one
    persistRun(makeSnapshot({ state: "success" }), "/p");

    const loaded = loadRecentRuns("/p", 10);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.runId).not.toBe("bad-json-run");
  });

  it("rows failing zod schema validation are dropped silently", () => {
    const db = openPersistDb();
    // Valid JSON but invalid schema (unknown state, missing required fields)
    const badPayload = JSON.stringify({
      runId: "schema-invalid-run",
      state: "not-a-valid-state",
    });
    db.prepare(
      `INSERT INTO routine_runs
         (run_id, routine_id, project_path, snapshot_json, started_at, ended_at, state)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "schema-invalid-run",
      "r1",
      "/p",
      badPayload,
      new Date(Date.now() - 60_000).toISOString(),
      new Date().toISOString(),
      "success",
    );
    persistRun(makeSnapshot({ state: "success" }), "/p");

    const loaded = loadRecentRuns("/p", 10);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.runId).not.toBe("schema-invalid-run");
  });
});

// ── pruneRunsOlderThan ───────────────────────────────────────────────────────

describe("routine-persist / pruneRunsOlderThan", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    openFreshDb(dbPath);
  });

  afterEach(() => {
    cleanupDb(dbPath);
  });

  it("time-based: deletes terminal runs whose ended_at predates the cutoff", () => {
    const oldEndedAt = new Date(Date.now() - 10_000).toISOString(); // 10s ago
    const recentEndedAt = new Date(Date.now() - 100).toISOString(); // 100ms ago
    const old = makeSnapshot({ state: "success", endedAt: oldEndedAt });
    const recent = makeSnapshot({ state: "success", endedAt: recentEndedAt });
    persistRun(old, "/p");
    persistRun(recent, "/p");

    // Prune runs older than 5 seconds — old (10s) is deleted, recent (100ms) is kept
    pruneRunsOlderThan("/p", 5_000, MAX_RETAINED_RUNS);

    const loaded = loadRecentRuns("/p", 10);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.runId).toBe(recent.runId);
  });

  it("count-based: caps to keepLatestN most recent terminal runs", () => {
    // Future endedAt ensures time-based prune doesn't fire (future > any cutoff)
    const futureEndedAt = new Date(Date.now() + 86_400_000).toISOString();
    for (let i = 0; i < 7; i++) {
      persistRun(
        makeSnapshot({
          state: "success",
          startedAt: new Date(Date.now() + i * 1000).toISOString(),
          endedAt: futureEndedAt,
        }),
        "/p",
      );
    }

    // 1 trillion ms ≈ 31 years — valid Date, cutoff lands around year 1993.
    // futureEndedAt is not < year 1993, so time-based prune fires nothing.
    // Count-based cap then runs and keeps the 3 most recent.
    pruneRunsOlderThan("/p", 1_000_000_000_000, 3);

    const loaded = loadRecentRuns("/p", 20);
    expect(loaded).toHaveLength(3);
  });

  it("live (non-terminal) runs are never pruned", () => {
    const oldEndedAt = new Date(Date.now() - 100_000).toISOString();
    const live = makeSnapshot({ state: "running", endedAt: undefined });
    const done = makeSnapshot({ state: "success", endedAt: oldEndedAt });
    persistRun(live, "/p");
    persistRun(done, "/p");

    // Prune aggressively: short time window, cap of 0
    pruneRunsOlderThan("/p", 1, 0);

    // The live run must still be in the table
    const db = openPersistDb();
    const rows = db
      .prepare(
        "SELECT run_id, state FROM routine_runs WHERE project_path = ?",
      )
      .all("/p") as Array<{ run_id: string; state: string }>;
    const liveRow = rows.find((r) => r.run_id === live.runId);
    expect(liveRow).toBeDefined();
    expect(liveRow?.state).toBe("running");
  });

  it("pruning one project does not touch another project's rows", () => {
    persistRun(
      makeSnapshot({
        state: "success",
        endedAt: new Date(Date.now() - 100_000).toISOString(),
      }),
      "/project/a",
    );
    persistRun(
      makeSnapshot({
        state: "success",
        endedAt: new Date(Date.now() - 100_000).toISOString(),
      }),
      "/project/b",
    );

    pruneRunsOlderThan("/project/a", 1, 0);

    expect(loadRecentRuns("/project/a", 10)).toHaveLength(0);
    expect(loadRecentRuns("/project/b", 10)).toHaveLength(1);
  });
});

// ── disableRoutinePersist / enableRoutinePersist ─────────────────────────────

describe("routine-persist / disable + enable", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    openFreshDb(dbPath);
  });

  afterEach(() => {
    cleanupDb(dbPath);
  });

  it("disableRoutinePersist causes persistRun to no-op", () => {
    disableRoutinePersist();
    const snap = makeSnapshot({ state: "success" });
    persistRun(snap, "/p");
    enableRoutinePersist();

    // Nothing was written
    const loaded = loadRecentRuns("/p", 10);
    expect(loaded).toHaveLength(0);
  });

  it("disableRoutinePersist causes loadRecentRuns to return []", () => {
    persistRun(makeSnapshot({ state: "success" }), "/p");

    disableRoutinePersist();
    const loaded = loadRecentRuns("/p", 10);
    enableRoutinePersist();

    expect(loaded).toHaveLength(0);
  });

  it("disableRoutinePersist causes pruneRunsOlderThan to no-op", () => {
    const snap = makeSnapshot({
      state: "success",
      endedAt: new Date(Date.now() - 100_000).toISOString(),
    });
    persistRun(snap, "/p");

    disableRoutinePersist();
    pruneRunsOlderThan("/p", 1, 0);
    enableRoutinePersist();

    // The row should still be there since prune was a no-op
    const loaded = loadRecentRuns("/p", 10);
    expect(loaded).toHaveLength(1);
  });

  it("enableRoutinePersist re-enables persistence after disable", () => {
    disableRoutinePersist();
    enableRoutinePersist();

    const snap = makeSnapshot({ state: "success" });
    persistRun(snap, "/p");

    const loaded = loadRecentRuns("/p", 10);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.runId).toBe(snap.runId);
  });
});

// ── RoutineRunRegistry hydration contract ────────────────────────────────────

/**
 * Contract: RoutineRunRegistry.hydrateTerminalRuns() calls
 * loadRecentRuns(null, MAX_RETAINED_RUNS), which filters to terminal states
 * server-side. Hydrated runs are read-only tombstones — abort() returns false
 * for any of them (they're already terminal), and start() is not attempted
 * on them by the registry itself.
 */
describe("routine-persist / RoutineRunRegistry hydration", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    openFreshDb(dbPath);
  });

  afterEach(() => {
    cleanupDb(dbPath);
  });

  it("terminal runs seeded in DB appear in the registry after construction", () => {
    const success = makeSnapshot({ state: "success" });
    const aborted = makeSnapshot({ state: "aborted" });
    const errored = makeSnapshot({ state: "error" });
    persistRun(success, "/p");
    persistRun(aborted, "/p");
    persistRun(errored, "/p");

    const reg = new RoutineRunRegistry({
      bus: makeFakeBus(),
      sessionRegistry: nullSessionRegistry,
    });
    try {
      const runIds = reg.list().map((r) => r.runId);
      expect(runIds).toContain(success.runId);
      expect(runIds).toContain(aborted.runId);
      expect(runIds).toContain(errored.runId);
    } finally {
      reg.dispose();
    }
  });

  it("pending and running runs in DB are NOT hydrated (terminal-only contract)", () => {
    persistRun(makeSnapshot({ state: "running", endedAt: undefined }), "/p");
    persistRun(makeSnapshot({ state: "pending", endedAt: undefined }), "/p");

    const reg = new RoutineRunRegistry({
      bus: makeFakeBus(),
      sessionRegistry: nullSessionRegistry,
    });
    try {
      const listed = reg.list();
      // Neither pending nor running states appear in the hydrated registry
      expect(listed.every((r) => r.state !== "running")).toBe(true);
      expect(listed.every((r) => r.state !== "pending")).toBe(true);
    } finally {
      reg.dispose();
    }
  });

  it("abort on a hydrated terminal run returns false (already-terminal contract)", () => {
    const snap = makeSnapshot({ state: "success" });
    persistRun(snap, "/p");

    const reg = new RoutineRunRegistry({
      bus: makeFakeBus(),
      sessionRegistry: nullSessionRegistry,
    });
    try {
      // Regression: hydrated runs are terminal — abort must not treat them as live
      const result = reg.abort(snap.runId);
      expect(result).toBe(false);
    } finally {
      reg.dispose();
    }
  });

  it("abort on an unknown run id returns false", () => {
    const reg = new RoutineRunRegistry({
      bus: makeFakeBus(),
      sessionRegistry: nullSessionRegistry,
    });
    try {
      expect(reg.abort("does-not-exist")).toBe(false);
    } finally {
      reg.dispose();
    }
  });

  it("hydrated runs are visible via get()", () => {
    const snap = makeSnapshot({ state: "success" });
    persistRun(snap, "/p");

    const reg = new RoutineRunRegistry({
      bus: makeFakeBus(),
      sessionRegistry: nullSessionRegistry,
    });
    try {
      const got = reg.get(snap.runId);
      expect(got).not.toBeNull();
      expect(got?.state).toBe("success");
      expect(got?.routineId).toBe("my-routine");
    } finally {
      reg.dispose();
    }
  });
});

// ── Migration smoke test ─────────────────────────────────────────────────────

describe("routine-persist / migration smoke", () => {
  it("initDb creates the routine_runs table with expected columns", () => {
    const db = initDb(":memory:");
    try {
      const tableInfo = db.pragma("table_info(routine_runs)") as Array<{
        name: string;
      }>;
      const cols = tableInfo.map((r) => r.name);
      expect(cols).toContain("run_id");
      expect(cols).toContain("routine_id");
      expect(cols).toContain("project_path");
      expect(cols).toContain("snapshot_json");
      expect(cols).toContain("started_at");
      expect(cols).toContain("ended_at");
      expect(cols).toContain("state");
    } finally {
      db.close();
    }
  });

  it("routine_runs table is indexed on (project_path, started_at DESC)", () => {
    const db = initDb(":memory:");
    try {
      const indexes = db.pragma("index_list(routine_runs)") as Array<{
        name: string;
      }>;
      const names = indexes.map((i) => i.name);
      expect(names).toContain("idx_routine_runs_project");
    } finally {
      db.close();
    }
  });

  it("openPersistDb on a fresh file creates the routine_runs table", () => {
    const tmpPath = tmpDbPath();
    process.env["MINIONS_SERVER_DB"] = tmpPath;
    closePersistDb();
    try {
      const db = openPersistDb(tmpPath);
      const tableInfo = db.pragma("table_info(routine_runs)") as Array<{
        name: string;
      }>;
      expect(tableInfo.length).toBeGreaterThan(0);
      const cols = tableInfo.map((r) => r.name);
      expect(cols).toContain("run_id");
      expect(cols).toContain("state");
    } finally {
      closePersistDb();
      delete process.env["MINIONS_SERVER_DB"];
      rmDb(tmpPath);
    }
  });
});
