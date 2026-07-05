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
} from "./session-host.ts";
import { hydrateSessionsFromDb } from "./session-persist.ts";
import type { RuntimeSessionInfo, TaskManagerState, TaskRecord } from "./task-tools.ts";
import type { WorktreeLifecycle } from "./worktree-types.ts";
import { applyLifecycleEvent } from "./task-lifecycle.ts";
import { persistTaskState } from "./session-persist.ts";
import { requestWaitResume } from "./wait-resume.ts";
import { buildWakeTaskDigest, isWakeWorthyStatus, requestCoalescedWake } from "./wake-coalescer.ts";
import { buildSessionListItem, type SessionListItem } from "./session-list-item.ts";

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

  getSessionRuntime = (sessionKey: string): RuntimeSessionInfo | null => {
    const host = this.map.get(sessionKey);
    if (!host) return null;

    const lastEvent = [...host.eventBuffer]
      .reverse()
      .find((event) => typeof event.timestamp === "number");
    const lastActivityAt = lastEvent?.timestamp ?? null;
    const now = Date.now();
    const lastSdkEventKind =
      lastEvent?.type === "sdk_event" && lastEvent.event
        ? lastEvent.event.kind
        : null;

    return {
      sessionKey,
      sessionId: host.sessionId,
      status: host.status,
      role: host.role,
      cwd: host.cwd,
      model: host.model,
      harness: host.harnessName,
      totalCost: host.totalCost,
      turns: host.turns,
      isLive:
        host.status === "running" &&
        !host.abortController.signal.aborted &&
        (host.eventStream !== null || host.runControl !== null),
      lastActivityAt,
      lastActivityAgeMs: lastActivityAt === null ? null : now - lastActivityAt,
      lastEventType: lastEvent?.type ?? null,
      lastSdkEventKind,
      lastError: host.lastError,
      lastErrorFull: host.lastErrorFull,
    };
  };

  // ── Snapshot helpers ───────────────────────────────

  wakeWaitingLeaderIfAllChildrenTerminal = (leaderKey: string): void => {
    const host = this.map.get(leaderKey);
    if (!host || !this.deps) return;

    const minionTasks = host.taskState
      ? Array.from(host.taskState.tasks.values()).filter((t) => t.executor === "minion")
      : [];
    const pendingWait = host.taskState?.pendingWait ?? null;

    // ── Path A: pending wait ──────────────────────────────────────────────
    if (pendingWait) {
      const wakeOn = pendingWait.wakeOn ?? "all_terminal";
      // Wake-worthy = terminal OR blocked. A blocked child has ended its turn
      // awaiting a leader decision, so the leader must be roused to answer it
      // even though the task is not terminal.
      // any_terminal: wake on first wake-worthy child; all_terminal: wait for all.
      if (wakeOn === "any_terminal") {
        if (!minionTasks.some((t) => isWakeWorthyStatus(t.status))) return;
      } else if (minionTasks.some((t) => !isWakeWorthyStatus(t.status))) return;

      const digest = buildWakeTaskDigest(minionTasks, pendingWait.scheduledAt);
      requestWaitResume(host, this.deps, {
        completedReason: "All delegated child tasks reached a wake-worthy state (terminal or blocked).",
        immediate: wakeOn === "all_terminal",
        opts: {
          sessionKey: host.id,
          prompt:
            `Continue. All delegated child tasks reached a wake-worthy state (terminal or blocked) while waiting (${pendingWait.reason}). Pick up where you left off.` +
            (digest ? `\n\nTask results:\n${digest}` : ""),
          cwd: host.cwd,
          resumeId: host.sessionId ?? undefined,
          role: host.role,
          harness: host.harnessName,
        },
      });
      return;
    }

    // ── Path B: no pending wait — idle-leader resurrection ───────────────
    // Only fire when the host is genuinely idle (mirrors the isLive guard).
    if (
      !host.taskState ||
      host.status !== "idle" ||
      host.runControl !== null ||
      host.eventStream !== null ||
      host.abortController.signal.aborted
    ) return;

    // cancelled/orphaned come from teardown paths; must not resurrect a leader.
    // blocked is included: an idle leader must be roused to answer a stuck minion.
    const meaningfulTasks = minionTasks.filter(
      (t) =>
        t.status === "completed" ||
        t.status === "failed" ||
        t.status === "ended_without_report" ||
        t.status === "blocked",
    );
    if (meaningfulTasks.length === 0) return;

    const digest = buildWakeTaskDigest(meaningfulTasks);
    requestCoalescedWake(host, this.deps, {
      opts: {
        sessionKey: host.id,
        prompt: `A delegated task reached a state needing your attention while you were idle:\n${digest}\nReview it (answer a blocked task with message_task) and continue orchestrating.`,
        cwd: host.cwd,
        resumeId: host.sessionId ?? undefined,
        role: host.role,
        harness: host.harnessName,
      },
    });
  };

  /** Flatten the current registry into the `session_list` broadcast shape. */
  snapshot(): SessionListItem[] {
    return Array.from(this.map.entries()).map(([key, s]) =>
      buildSessionListItem(key, s),
    );
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
      for (const { row, tasks, render, events, usageTotals } of hydrated) {
        const host = new SessionHost(
          row.session_key,
          row.cwd ?? process.cwd(),
        );
        host.status = "stopped";
        host.totalCost = row.total_cost;
        host.turns = row.turns;
        host.usageTotals = usageTotals;
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
        if (
          row.worktree_path &&
          row.worktree_branch &&
          row.worktree_project_path
        ) {
          host.worktree = {
            path: row.worktree_path,
            branch: row.worktree_branch,
            projectPath: row.worktree_project_path,
            leaderSessionKey: row.session_key,
            createdAt: row.worktree_created_at ?? 0,
            lifecycle: (row.worktree_lifecycle as WorktreeLifecycle | null) ?? "active",
          };
          host.cwd = row.worktree_path;
        }
        // Restore the harness so a resumed session keeps running on the
        // harness it started with. Pre-migration rows return "claude"
        // via the schema default — no behaviour change for old DBs.
        host.harnessName = row.harness_name || "claude";
        host.taskState = tasks;
        if (host.taskState && this.deps) {
          for (const task of host.taskState.tasks.values()) {
            if (task.status !== "running" && task.status !== "starting" && task.status !== "blocked") continue;
            applyLifecycleEvent({
              bus: this.deps.bus,
              leaderSessionKey: row.session_key,
              taskState: host.taskState,
              taskId: task.taskId,
              event: { type: "rehydrated_orphan" },
              onStateChange: (state) => persistTaskState(row.session_key, state),
            });
          }
        }
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
