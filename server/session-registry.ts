/**
 * SessionRegistry — the in-memory home for every live SessionHost.
 *
 * Provides typed accessors around the raw `Map<string, SessionHost>` that
 * `server/index.ts` used to own directly, plus the small amount of glue
 * required to spawn children (minions, self-resume after a wait timer)
 * and to rehydrate sessions from SQLite at boot.
 *
 * Extracted in Phase 5.1 so that `server/index.ts` no longer has to
 * know about Map mechanics — it asks the registry for a host by key and
 * dispatches against it.
 */

import {
  SessionHost,
  type SessionHostDeps,
  type StartSessionOptions,
  type SessionRole,
  type SessionStatus,
} from "./session-host.ts";
import { hydrateSessionsFromDb } from "./session-persist.ts";
import type { TaskManagerState } from "./task-tools.ts";

/** Compact shape broadcast to clients in `session_list` messages. */
export interface SessionListItem {
  sessionKey: string;
  sessionId: string | null;
  status: SessionStatus;
  cwd: string;
  totalCost: number;
  turns: number;
  model: string | null;
  permissionMode: string | null;
  taskName: string | null;
  role: SessionRole;
  activeMinions: Array<{
    taskId: string;
    title: string;
    status: string;
    sessionKey: string | null;
  }>;
}

export class SessionRegistry {
  private readonly map = new Map<string, SessionHost>();
  private deps: SessionHostDeps | null = null;

  /** Supply the execution dependencies. Must be called before `start()`. */
  setDeps(deps: SessionHostDeps): void {
    this.deps = deps;
  }

  // ── Map-like accessors ─────────────────────────────

  get(key: string): SessionHost | undefined {
    return this.map.get(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  /**
   * Number of sessions currently consuming live runtime resources
   * (open SDK query, MCP servers, worktree). Hydrated-but-never-resumed
   * sessions come back as `status: "stopped"` and are excluded.
   *
   * `MAX_SESSIONS` is meant to cap concurrent compute, not on-disk
   * history — without this distinction, a project with N saved
   * sessions where N === MAX_SESSIONS makes every new `create_session`
   * fail at boot (regression observed after Phase 4.4 hydration).
   */
  activeCount(): number {
    let n = 0;
    for (const host of this.map.values()) {
      if (host.status !== "stopped") n += 1;
    }
    return n;
  }

  values(): IterableIterator<SessionHost> {
    return this.map.values();
  }

  entries(): IterableIterator<[string, SessionHost]> {
    return this.map.entries();
  }

  [Symbol.iterator](): IterableIterator<[string, SessionHost]> {
    return this.map[Symbol.iterator]();
  }

  // ── Lifecycle helpers ──────────────────────────────

  /**
   * Start (or resume) a session by key. Creates a SessionHost if one
   * doesn't exist for this key yet; otherwise re-enters `start()` on
   * the existing host (the resume path).
   */
  start(opts: StartSessionOptions): void {
    if (!this.deps) {
      throw new Error(
        "SessionRegistry: deps not set — call setDeps() before start().",
      );
    }
    let host = this.map.get(opts.sessionKey);
    if (!host) {
      host = new SessionHost(opts.sessionKey, opts.cwd);
      this.map.set(opts.sessionKey, host);
    }
    // Fire-and-forget; the host fans progress out via the bus.
    void host.start(opts, this.deps);
  }

  /**
   * Visit every leader session's task state — used by MCP tools that
   * need to cross-reference work across leaders.
   */
  forEachLeaderTaskState = (
    fn: (leaderKey: string, state: TaskManagerState) => void,
  ): void => {
    for (const [key, host] of this.map) {
      if (host.taskState) {
        fn(key, host.taskState);
      }
    }
  };

  // ── Snapshot helpers ───────────────────────────────

  /** Flatten the current registry into the `session_list` broadcast shape. */
  snapshot(): SessionListItem[] {
    return Array.from(this.map.entries()).map(([key, s]) => ({
      sessionKey: key,
      sessionId: s.sessionId,
      status: s.status,
      cwd: s.cwd,
      totalCost: s.totalCost,
      turns: s.turns,
      model: s.model,
      permissionMode: s.permissionMode,
      taskName: s.taskName,
      role: s.role,
      activeMinions: s.taskState
        ? Array.from(s.taskState.tasks.entries())
            .filter(
              ([, t]) => t.status === "planned" || t.status === "running",
            )
            .map(([id, t]) => ({
              taskId: id,
              title: t.title,
              status: t.status,
              sessionKey: t.minionSessionKey,
            }))
        : [],
    }));
  }

  // ── Boot hydration ─────────────────────────────────

  /**
   * Restore sessions from disk at boot. Volatile fields (abortController,
   * queryHandle, waitTimerId) are freshly initialized; restored sessions
   * come back with `status = "stopped"` so the UI can show them as
   * resumable. Returns the count of hydrated sessions.
   */
  hydrateFromDb(): number {
    try {
      const hydrated = hydrateSessionsFromDb();
      for (const { row, tasks, render, events } of hydrated) {
        const host = new SessionHost(
          row.session_key,
          row.cwd ?? process.cwd(),
        );
        host.status = "stopped";
        host.totalCost = row.total_cost;
        host.turns = row.turns;
        host.model = row.model;
        host.role = (row.role as SessionRole) ?? "default";
        host.taskName = row.task_name;
        // Restore the SDK session id so a follow-up `send_message` can
        // pass it as `resume:` and the SDK picks the conversation back up
        // mid-stream. Pre-migration rows return `null` here, in which
        // case the next turn starts a fresh SDK session — same behaviour
        // as before this fix.
        host.sessionId = row.session_id;
        host.worktreeIsolation = row.worktree_isolation === 1;
        host.taskState = tasks;
        host.renderState = render;
        // Restore the event buffer in place — using bufferEvent() here
        // would re-persist every event we just loaded.
        host.eventBuffer = events;
        this.map.set(row.session_key, host);
      }
      if (hydrated.length > 0) {
        console.log(
          `[session-persist] hydrated ${hydrated.length} session(s) from disk`,
        );
      }
      return hydrated.length;
    } catch (err) {
      console.warn("[session-persist] hydrate failed:", err);
      return 0;
    }
  }
}
