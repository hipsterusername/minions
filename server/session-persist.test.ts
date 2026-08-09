
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
  persistArmedSystemPrompt,
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
    worktree: null,
    approval: null,
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

function makeRenderState(opts: {
  title?: string;
  columns?: number;
  gap?: number;
  components?: RenderState["components"];
} = {}): RenderState {
  return {
    layout: {
      title: opts.title ?? "Dash",
      columns: opts.columns ?? 2,
      gap: opts.gap ?? 12,
    },
    components: opts.components ?? [{ id: "m", type: "metric", label: "N", value: "1" }],
  };
}

describe("session-persist integration", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    process.env["MINIONS_SERVER_DB"] = dbPath;
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

  it("places the default global session database under MINIONS_HOME", () => {
    const minionsHome = fs.mkdtempSync(path.join(os.tmpdir(), "minions-global-state-"));
    closePersistDb();
    delete process.env["MINIONS_SERVER_DB"];
    process.env["MINIONS_HOME"] = minionsHome;
    try {
      openPersistDb();
      expect(fs.existsSync(path.join(minionsHome, "server.db"))).toBe(true);
    } finally {
      closePersistDb();
      delete process.env["MINIONS_HOME"];
      process.env["MINIONS_SERVER_DB"] = dbPath;
      fs.rmSync(minionsHome, { recursive: true, force: true });
    }
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

  it("armed minion system prompt survives a persistence restart", () => {
    const armedPrompt = "Base minion prompt\n\n## Skill: Sentinel Persisted Skill";
    persistSession(makeSession({ id: "minion-armed", role: "minion" }));
    persistArmedSystemPrompt("minion-armed", armedPrompt);

    closePersistDb();
    openPersistDb(dbPath);

    const hydrated = hydrateSessionsFromDb();
    expect(
      hydrated.find((entry) => entry.row.session_key === "minion-armed")
        ?.armedSystemPrompt,
    ).toBe(armedPrompt);
  });

  it("preserves project and immutable run metadata across generic session writes", () => {
    persistSession(makeSession({ projectId: "project-1", sessionId: "provider-1" }));
    const db = openPersistDb();
    db.prepare(`
      INSERT INTO work_items (
        id, project_id, project_path, title, runtime_state, outcome, resolution,
        change_mode, integration_state, last_transition_at, created_at, updated_at
      ) VALUES ('work-1', 'project-1', '/repo', 'T', 'inactive', 'completed', 'open', 'live', 'live_clean', 1, 1, 1)
    `).run();
    db.prepare(`
      UPDATE sessions SET work_item_id = 'work-1', run_number = 1, run_kind = 'primary',
        started_at = 1, ended_at = 2, run_outcome = 'completed'
      WHERE session_key = 'sess-1'
    `).run();

    persistSession(makeSession({ sessionId: "provider-overwrite-attempt" }));
    const row = db.prepare(`
      SELECT project_id, work_item_id, run_number, run_kind, ended_at, run_outcome, session_id
      FROM sessions WHERE session_key = 'sess-1'
    `).get();
    expect(row).toEqual({
      project_id: "project-1", work_item_id: "work-1", run_number: 1,
      run_kind: "primary", ended_at: 2, run_outcome: "completed", session_id: "provider-1",
    });
  });

  it("persists active worktree metadata and approval state across hydrate", () => {
    persistSession(makeSession({
      worktree: {
        path: "/tmp/project/.canvas-worktrees/leader-1",
        branch: "canvas/leader-1",
        leaderSessionKey: "sess-1",
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

    const hydrated = hydrateSessionsFromDb();
    expect(hydrated[0]?.row.worktree_path).toBe("/tmp/project/.canvas-worktrees/leader-1");
    expect(hydrated[0]?.row.worktree_branch).toBe("canvas/leader-1");
    expect(hydrated[0]?.tasks?.approval?.summary).toBe("ready");
  });

  it("persistTaskState removes stale rows and upserts current ones", () => {
    persistSession(makeSession());
    const t1 = makeTaskRecord({ taskId: "t1" });
    const t2 = makeTaskRecord({ taskId: "t2", status: "planned" });
    persistTaskState("sess-1", makeTaskState([t1, t2]));

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
    expect(hydrated[0]?.render?.layout.title).toBe("Hello");
    expect(hydrated[0]?.render?.layout.columns).toBe(3);
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

  it("refuses legacy deletion of a work-item-bound immutable run", () => {
    persistSession(makeSession({ projectId: "project-1" }));
    const db = openPersistDb();
    db.prepare(`
      INSERT INTO work_items (
        id, project_id, project_path, title, runtime_state, outcome, resolution,
        change_mode, integration_state, last_transition_at, created_at, updated_at
      ) VALUES ('work-1', 'project-1', '/repo', 'T', 'working', 'none', 'open', 'live', 'live_clean', 1, 1, 1)
    `).run();
    db.prepare(`
      UPDATE sessions SET work_item_id = 'work-1', run_number = 1,
        run_kind = 'primary', started_at = 1 WHERE session_key = 'sess-1'
    `).run();

    expect(removePersistedSession("sess-1")).toBe(false);
    expect(db.prepare("SELECT session_key FROM sessions WHERE session_key = 'sess-1'").get())
      .toEqual({ session_key: "sess-1" });
  });

  it("rolls back session deletion when one cleanup step fails", () => {
    persistSession(makeSession());
    persistTaskState("sess-1", makeTaskState([makeTaskRecord()]));
    const db = openPersistDb();
    db.exec(`
      CREATE TRIGGER reject_task_cleanup
      BEFORE DELETE ON task_records
      BEGIN
        SELECT RAISE(ABORT, 'cleanup blocked');
      END
    `);

    removePersistedSession("sess-1");

    const hydrated = hydrateSessionsFromDb();
    expect(hydrated.map((entry) => entry.row.session_key)).toEqual(["sess-1"]);
    expect(hydrated[0]?.tasks?.tasks.has("t1")).toBe(true);
  });

  it("rolls back stale-task deletion when a later task upsert fails", () => {
    persistSession(makeSession());
    persistTaskState(
      "sess-1",
      makeTaskState([
        makeTaskRecord({ taskId: "t1" }),
        makeTaskRecord({ taskId: "t2" }),
      ]),
    );
    const db = openPersistDb();
    db.exec(`
      CREATE TRIGGER reject_t3_insert
      BEFORE INSERT ON task_records
      WHEN NEW.task_id = 't3'
      BEGIN
        SELECT RAISE(ABORT, 'insert blocked');
      END
    `);

    persistTaskState(
      "sess-1",
      makeTaskState([
        makeTaskRecord({ taskId: "t2" }),
        makeTaskRecord({ taskId: "t3" }),
      ]),
    );

    const tasks = hydrateSessionsFromDb()[0]?.tasks?.tasks;
    expect(Array.from(tasks?.keys() ?? []).sort()).toEqual(["t1", "t2"]);
  });

  it.runIf(process.platform !== "win32")("creates the transcript database with owner-only permissions", () => {
    const mode = fs.statSync(dbPath).mode & 0o777;
    expect(mode).toBe(0o600);
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

    closePersistDb();
    openPersistDb(dbPath);

    const hydrated = hydrateSessionsFromDb();
    expect(hydrated).toHaveLength(1);
    const entry = hydrated[0]!;
    expect(entry.row.session_key).toBe("L");
    expect(entry.row.task_name).toBe("Phase 4");
    expect(entry.tasks?.tasks.size).toBe(2);
    expect(entry.tasks?.tasks.get("run")?.minionSessionKey).toBe("M");
    expect(entry.render?.layout.title).toBe("restart-me");
  });

  it("harnessName round-trips through persist/hydrate", () => {
    persistSession(makeSession({ id: "echo-sess", harnessName: "echo" }));
    const hydrated = hydrateSessionsFromDb();
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]?.row.harness_name).toBe("echo");
  });

  it("review lifecycle and frozen completion report survive restart", () => {
    persistSession(makeSession({
      id: "reviewed",
      status: "idle",
      reviewLifecycle: {
        reviewState: "completion_to_review",
        reviewReason: "Read the final report and review the dashboard",
        finalReport: "All requested work is complete.",
        finalDashboardRevision: 7,
        dashboardRevision: 7,
        terminalReason: "completed",
        terminalAt: 100,
        acknowledgedAt: 110,
        dismissedAt: null,
        lifecycleRevision: 4,
      },
    }));
    closePersistDb();
    openPersistDb(dbPath);
    const row = hydrateSessionsFromDb()[0]!.row;
    expect(row).toMatchObject({
      review_state: "completion_to_review",
      final_report: "All requested work is complete.",
      final_dashboard_revision: 7,
      acknowledged_at: 110,
      lifecycle_revision: 4,
    });
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
