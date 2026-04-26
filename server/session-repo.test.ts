/**
 * Round-trip tests for the session persistence repo layer.
 *
 * Uses an in-memory SQLite database so each test is isolated and fast.
 * Exercises every CRUD function in session-repo against a real `initDb`
 * schema, so schema drift breaks tests immediately.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb } from "./db.ts";
import type Database from "better-sqlite3";
import {
  upsertSession,
  getSession,
  getAllSessions,
  deleteSession,
  upsertTaskRecord,
  getTaskRecordsForLeader,
  deleteTaskRecord,
  upsertRenderState,
  getRenderState,
  deleteRenderState,
  appendEvent,
  getEvents,
  getRecentEvents,
  purgeEventsForSession,
  type SessionRow,
} from "./session-repo.ts";
import type { TaskRecord } from "./task-tools.ts";
import type { RenderState } from "./render-tools.ts";

// `initDb` resolves via DB_PATH env or a default path. Force an in-memory DB
// by setting DB_PATH to `:memory:` before calling it. `better-sqlite3` accepts
// that sentinel as "create an ephemeral DB".
function makeDb(): Database.Database {
  return initDb(":memory:");
}

function makeSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  const now = new Date().toISOString();
  return {
    session_key: "sess-abc",
    project_id: "proj-1",
    node_id: "node-1",
    status: "idle",
    cwd: "/tmp/work",
    model: "sonnet",
    role: "leader",
    task_name: "Phase 4",
    session_id: null,
    worktree_isolation: 1,
    total_cost: 0.42,
    turns: 3,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeTaskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "t-1",
    leaderSessionKey: "sess-abc",
    title: "Do the thing",
    description: "Do it well",
    priority: "high",
    executor: "minion",
    minionSessionKey: "sess-minion-1",
    status: "running",
    result: null,
    createdAt: Date.now(),
    completedAt: null,
    ...overrides,
  };
}

function makeRenderState(overrides: Partial<RenderState> = {}): RenderState {
  return {
    title: "Dash",
    columns: 2,
    gap: 12,
    components: [
      { id: "m1", type: "metric", label: "Count", value: "42" },
    ],
    ...overrides,
  };
}

describe("session-repo / sessions", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("inserts a new session row and retrieves it", () => {
    const row = makeSessionRow();
    upsertSession(db, row);

    const got = getSession(db, row.session_key);
    expect(got).not.toBeNull();
    expect(got?.session_key).toBe(row.session_key);
    expect(got?.status).toBe("idle");
    expect(got?.total_cost).toBe(0.42);
    expect(got?.worktree_isolation).toBe(1);
  });

  it("returns null for an unknown session", () => {
    expect(getSession(db, "missing")).toBeNull();
  });

  it("upserts (update path) on the same session key", () => {
    const row = makeSessionRow({ status: "idle", turns: 1 });
    upsertSession(db, row);
    upsertSession(db, { ...row, status: "running", turns: 7 });

    const got = getSession(db, row.session_key);
    expect(got?.status).toBe("running");
    expect(got?.turns).toBe(7);
  });

  it("lists all sessions in created_at order", () => {
    upsertSession(
      db,
      makeSessionRow({ session_key: "a", created_at: "2026-01-01T00:00:00Z" }),
    );
    upsertSession(
      db,
      makeSessionRow({ session_key: "b", created_at: "2026-02-01T00:00:00Z" }),
    );
    const all = getAllSessions(db);
    expect(all.map((s) => s.session_key)).toEqual(["a", "b"]);
  });

  it("deletes a session by key", () => {
    const row = makeSessionRow();
    upsertSession(db, row);
    deleteSession(db, row.session_key);
    expect(getSession(db, row.session_key)).toBeNull();
  });

  it("handles null project_id / node_id / cwd / model / task_name", () => {
    const row = makeSessionRow({
      session_key: "sparse",
      project_id: null,
      node_id: null,
      cwd: null,
      model: null,
      task_name: null,
    });
    upsertSession(db, row);
    const got = getSession(db, "sparse");
    expect(got?.project_id).toBeNull();
    expect(got?.cwd).toBeNull();
    expect(got?.model).toBeNull();
  });
});

describe("session-repo / task_records", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("inserts and reads back a TaskRecord with fidelity", () => {
    const rec = makeTaskRecord();
    upsertTaskRecord(db, rec);

    const list = getTaskRecordsForLeader(db, rec.leaderSessionKey);
    expect(list).toHaveLength(1);
    const got = list[0]!;
    expect(got.taskId).toBe(rec.taskId);
    expect(got.title).toBe(rec.title);
    expect(got.priority).toBe("high");
    expect(got.executor).toBe("minion");
    expect(got.minionSessionKey).toBe("sess-minion-1");
    expect(got.status).toBe("running");
    expect(got.createdAt).toBe(rec.createdAt);
    expect(got.completedAt).toBeNull();
  });

  it("upserts (update) an existing record, preserving taskId", () => {
    const rec = makeTaskRecord({ status: "running", result: null });
    upsertTaskRecord(db, rec);
    upsertTaskRecord(db, {
      ...rec,
      status: "completed",
      result: "Did it.",
      completedAt: 12345,
    });
    const got = getTaskRecordsForLeader(db, rec.leaderSessionKey);
    expect(got).toHaveLength(1);
    expect(got[0]?.status).toBe("completed");
    expect(got[0]?.result).toBe("Did it.");
    expect(got[0]?.completedAt).toBe(12345);
  });

  it("groups tasks by leader session key", () => {
    upsertTaskRecord(db, makeTaskRecord({ taskId: "a", leaderSessionKey: "L1" }));
    upsertTaskRecord(db, makeTaskRecord({ taskId: "b", leaderSessionKey: "L1" }));
    upsertTaskRecord(db, makeTaskRecord({ taskId: "c", leaderSessionKey: "L2" }));

    expect(getTaskRecordsForLeader(db, "L1").map((t) => t.taskId)).toEqual([
      "a",
      "b",
    ]);
    expect(getTaskRecordsForLeader(db, "L2").map((t) => t.taskId)).toEqual([
      "c",
    ]);
  });

  it("orders tasks by createdAt", () => {
    upsertTaskRecord(
      db,
      makeTaskRecord({ taskId: "later", createdAt: 2000 }),
    );
    upsertTaskRecord(
      db,
      makeTaskRecord({ taskId: "earlier", createdAt: 1000 }),
    );
    const list = getTaskRecordsForLeader(db, "sess-abc");
    expect(list.map((t) => t.taskId)).toEqual(["earlier", "later"]);
  });

  it("deletes by taskId", () => {
    const rec = makeTaskRecord();
    upsertTaskRecord(db, rec);
    deleteTaskRecord(db, rec.taskId);
    expect(getTaskRecordsForLeader(db, rec.leaderSessionKey)).toHaveLength(0);
  });
});

describe("session-repo / render_state", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("round-trips a dashboard via JSON-encoded components", () => {
    const state = makeRenderState();
    upsertRenderState(db, "sess-abc", state);

    const got = getRenderState(db, "sess-abc");
    expect(got).not.toBeNull();
    expect(got?.title).toBe("Dash");
    expect(got?.columns).toBe(2);
    expect(got?.gap).toBe(12);
    expect(got?.components).toEqual(state.components);
  });

  it("overwrites existing state on upsert", () => {
    upsertRenderState(db, "sess-abc", makeRenderState());
    upsertRenderState(
      db,
      "sess-abc",
      makeRenderState({
        title: "Next",
        columns: 3,
        components: [
          { id: "t1", type: "text", content: "hello" },
        ],
      }),
    );
    const got = getRenderState(db, "sess-abc");
    expect(got?.title).toBe("Next");
    expect(got?.columns).toBe(3);
    expect(got?.components).toHaveLength(1);
    expect(got?.components[0]?.id).toBe("t1");
  });

  it("returns null for an unknown session key", () => {
    expect(getRenderState(db, "missing")).toBeNull();
  });

  it("deletes render state by session key", () => {
    upsertRenderState(db, "sess-abc", makeRenderState());
    deleteRenderState(db, "sess-abc");
    expect(getRenderState(db, "sess-abc")).toBeNull();
  });

  it("handles empty components[]", () => {
    upsertRenderState(
      db,
      "sess-abc",
      makeRenderState({ components: [] }),
    );
    const got = getRenderState(db, "sess-abc");
    expect(got?.components).toEqual([]);
  });
});

describe("session-repo / event_log", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("appends events in order and retrieves them by session", () => {
    appendEvent(db, "s1", "task_plan_update", { n: 1 });
    appendEvent(db, "s1", "task_plan_update", { n: 2 });
    appendEvent(db, "s2", "render_update", { x: "y" });

    const s1 = getEvents(db, "s1");
    expect(s1).toHaveLength(2);
    expect(JSON.parse(s1[0]!.payload)).toEqual({ n: 1 });
    expect(JSON.parse(s1[1]!.payload)).toEqual({ n: 2 });

    const s2 = getEvents(db, "s2");
    expect(s2).toHaveLength(1);
    expect(s2[0]!.event_type).toBe("render_update");
  });

  it("respects the limit argument", () => {
    for (let i = 0; i < 5; i++) {
      appendEvent(db, "sx", "x", { i });
    }
    const limited = getEvents(db, "sx", 2);
    expect(limited).toHaveLength(2);
    expect(JSON.parse(limited[0]!.payload)).toEqual({ i: 0 });
  });

  it("is append-only — no mutation API exposed", async () => {
    // The repo deliberately has no per-event updateEvent/deleteEvent
    // function. `purgeEventsForSession` is a bulk session-cleanup helper
    // (called from removePersistedSession) — it does not violate the
    // append-only property of the per-event API.
    const mod = await import("./session-repo.ts");
    const keys = Object.keys(mod);
    expect(keys).not.toContain("updateEvent");
    expect(keys).not.toContain("deleteEvent");
  });

  it("getRecentEvents returns the last N events in chronological order", () => {
    for (let i = 0; i < 10; i++) {
      appendEvent(db, "tail", "x", { i });
    }
    const recent = getRecentEvents(db, "tail", 3);
    expect(recent).toHaveLength(3);
    expect(recent.map((r) => JSON.parse(r.payload).i)).toEqual([7, 8, 9]);
  });

  it("getRecentEvents returns everything when limit exceeds row count", () => {
    appendEvent(db, "small", "x", { i: 0 });
    appendEvent(db, "small", "x", { i: 1 });
    const recent = getRecentEvents(db, "small", 100);
    expect(recent).toHaveLength(2);
    expect(recent.map((r) => JSON.parse(r.payload).i)).toEqual([0, 1]);
  });

  it("purgeEventsForSession deletes only that session's rows", () => {
    appendEvent(db, "a", "x", { i: 1 });
    appendEvent(db, "a", "x", { i: 2 });
    appendEvent(db, "b", "x", { i: 1 });
    purgeEventsForSession(db, "a");
    expect(getEvents(db, "a")).toEqual([]);
    expect(getEvents(db, "b")).toHaveLength(1);
  });
});

describe("session-repo / restart recovery", () => {
  let dbPath: string;
  afterEach(() => {
    if (dbPath && fs.existsSync(dbPath)) {
      try {
        fs.rmSync(dbPath, { force: true });
        fs.rmSync(`${dbPath}-wal`, { force: true });
        fs.rmSync(`${dbPath}-shm`, { force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("full round-trip: leader + tasks + render state + events survive a server restart", () => {
    dbPath = path.join(
      os.tmpdir(),
      `session-repo-restart-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );

    // ── First "server run": seed state, then close ──
    const db1 = initDb(dbPath);
    upsertSession(
      db1,
      makeSessionRow({ session_key: "L", role: "leader" }),
    );
    upsertTaskRecord(
      db1,
      makeTaskRecord({
        taskId: "t-plan",
        leaderSessionKey: "L",
        status: "planned",
      }),
    );
    upsertTaskRecord(
      db1,
      makeTaskRecord({
        taskId: "t-run",
        leaderSessionKey: "L",
        status: "running",
        minionSessionKey: "M1",
      }),
    );
    upsertRenderState(db1, "L", makeRenderState({ title: "live" }));
    appendEvent(db1, "L", "task_plan_update", { n: 2 });
    db1.close();

    // ── Second "server run": re-open the file, verify state is intact ──
    const db2 = initDb(dbPath);

    const sessions = getAllSessions(db2);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.session_key).toBe("L");

    const tasks = getTaskRecordsForLeader(db2, "L");
    expect(tasks.map((t) => t.taskId).sort()).toEqual(["t-plan", "t-run"]);
    const runTask = tasks.find((t) => t.taskId === "t-run");
    expect(runTask?.minionSessionKey).toBe("M1");
    expect(runTask?.status).toBe("running");

    const render = getRenderState(db2, "L");
    expect(render?.title).toBe("live");

    const events = getEvents(db2, "L");
    expect(events).toHaveLength(1);

    db2.close();
  });
});
