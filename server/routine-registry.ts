/**
 * RoutineRunRegistry — live-run tracking + bus integration for Routines.
 *
 * The pure scheduler in `server/routines/scheduler.ts` runs a routine
 * to completion given an injected `StepRunner`. This registry is the
 * thin layer that:
 *
 *   1. Builds a runner backed by `SessionRegistry.start()` so each step
 *      spawns a real Leader session.
 *   2. Tracks the in-flight `RoutineRunSnapshot` per `runId`.
 *   3. Emits `routine_progress` envelopes on the bus every time the
 *      snapshot changes so the canvas RoutineNode can render live status.
 *   4. Exposes start / abort / get / list to the WS command handlers.
 *
 * The registry stays small on purpose — orchestration logic lives in the
 * scheduler, completion in step-tools, spawning in leader-runner. This
 * file is glue.
 */

import { randomUUID } from "node:crypto";
import { runRoutine } from "./routines/scheduler.ts";
import { createLeaderStepRunner } from "./routines/leader-runner.ts";
import { extractSessionEnd } from "./routines/session-end.ts";
import { loadRoutineById } from "./routine-store.ts";
import {
  loadRecentRuns,
  persistRun,
  pruneRunsOlderThan,
  MAX_RETAINED_RUNS,
} from "./routine-persist.ts";
import type { Bus } from "./bus.ts";
import type { SessionRegistry } from "./session-registry.ts";
import type {
  Routine,
  RoutineRunSnapshot,
} from "../shared/routines/types.ts";
import { sessionKeyFromTopic } from "../shared/ws-envelope.ts";

/** Runs older than 30 days are eligible for time-based pruning. */
const ROUTINE_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Public summary the WS layer sends to clients. */
export interface RoutineRunSummary {
  runId: string;
  routineId: string;
  routineName: string;
  state: RoutineRunSnapshot["state"];
  startedAt: string;
  endedAt?: string;
}

/** Args for {@link RoutineRunRegistry.start}. */
export interface StartRunArgs {
  /** Already-loaded routine (saves the registry from owning a project path). */
  routine: Routine;
  inputs: Record<string, unknown>;
  /** Project path used to resolve skill ids. */
  projectPath: string;
  /** Working directory for spawned leaders. */
  cwd: string;
  /** Optional caller-supplied id; the registry auto-generates otherwise. */
  runId?: string;
}

/**
 * Per-run handle held by the registry. The scheduler promise is kept so
 * we can `await` it in tests (and so the registry can clean up after
 * completion); the snapshot is the source of truth for status queries.
 */
interface RunSlot {
  runId: string;
  routineId: string;
  /** Project path the run was started under — used for persistence and pruning. */
  projectPath: string;
  snapshot: RoutineRunSnapshot;
  /** Resolves when the run completes, fails, or aborts. */
  donePromise: Promise<RoutineRunSnapshot>;
  /** Best-effort abort: signals scheduler-spawned sessions to stop. */
  abort(): void;
  /** Step → Leader sessionKey, kept in sync with the leader-runner. */
  liveSessions: ReadonlyMap<string, string>;
}

/**
 * Registry of every live + recently-completed routine run for a server
 * instance.
 *
 * Recently-completed runs are retained until {@link prune} drops them so
 * a `list_routines` request right after a run ends still shows its
 * terminal snapshot.
 */
export class RoutineRunRegistry {
  private readonly runs = new Map<string, RunSlot>();
  private readonly bus: Bus;
  private readonly sessionRegistry: SessionRegistry;
  /** Active session-end listeners keyed by sessionKey. */
  private readonly endListeners = new Map<
    string,
    Set<(info: { reason: string; isError: boolean }) => void>
  >();
  private busUnsubscribe: (() => void) | null = null;

  constructor(opts: { bus: Bus; sessionRegistry: SessionRegistry }) {
    this.bus = opts.bus;
    this.sessionRegistry = opts.sessionRegistry;
    this.installBusListener();
    this.hydrateTerminalRuns();
  }

  /** Begin a run. Returns the runId; the scheduler runs in the background. */
  start(args: StartRunArgs): string {
    const runId = args.runId ?? randomUUID();
    const seedSnapshot = createPendingSnapshot({
      runId,
      routine: args.routine,
    });

    const aborter = new AbortController();
    const slot: RunSlot = {
      runId,
      routineId: args.routine.id,
      projectPath: args.projectPath,
      snapshot: seedSnapshot,
      donePromise: Promise.resolve(seedSnapshot), // overwritten below
      abort: () => aborter.abort(),
      liveSessions: new Map(),
    };
    this.runs.set(runId, slot);
    this.emitProgress(slot);

    const handle = createLeaderStepRunner({
      projectPath: args.projectPath,
      cwd: args.cwd,
      bus: this.bus,
      startLeaderSession: (opts) => {
        this.sessionRegistry.start({
          sessionKey: opts.sessionKey,
          prompt: opts.prompt,
          cwd: opts.cwd,
          systemPrompt: opts.systemPrompt,
          role: "leader",
          // Routines run worktree-less — they compose ideas, not code.
          worktreeIsolation: false,
          externalMcpServers: opts.externalMcpServers,
          externalMcpToolNames: opts.externalMcpToolNames,
        });
      },
      abortSession: (sessionKey) => {
        const host = this.sessionRegistry.get(sessionKey);
        host?.abortController.abort();
      },
      subscribeSessionEnded: (key, handler) => {
        return this.subscribeSessionEnded(key, handler);
      },
    });
    slot.liveSessions = handle.liveSessions;

    const donePromise = runRoutine({
      routine: args.routine,
      inputs: args.inputs,
      runner: handle.runner,
      runId,
      onSnapshot: (snap) => {
        slot.snapshot = snap;
        this.emitProgress(slot);
      },
    }).then(
      (final) => {
        slot.snapshot = final;
        this.emitProgress(slot);
        return final;
      },
      (err: unknown) => {
        const errorMessage =
          err instanceof Error ? err.message : String(err);
        slot.snapshot = {
          ...slot.snapshot,
          state: "error",
          error: errorMessage,
          endedAt: new Date().toISOString(),
        };
        this.emitProgress(slot);
        return slot.snapshot;
      },
    );

    slot.donePromise = donePromise;

    // When abort() is called, interrupt every leader session still in
    // flight. The scheduler can't be cancelled mid-phase but each leader
    // can be — that's enough to make the routine fail-fast.
    aborter.signal.addEventListener("abort", () => {
      for (const sessionKey of slot.liveSessions.values()) {
        const host = this.sessionRegistry.get(sessionKey);
        host?.abortController.abort();
      }
    });

    return runId;
  }

  /** Mark a run as aborted and interrupt its in-flight leader sessions. */
  abort(runId: string): boolean {
    const slot = this.runs.get(runId);
    if (!slot) return false;
    if (
      slot.snapshot.state === "success" ||
      slot.snapshot.state === "error" ||
      slot.snapshot.state === "aborted"
    ) {
      return false;
    }
    slot.abort();
    slot.snapshot = {
      ...slot.snapshot,
      state: "aborted",
      endedAt: new Date().toISOString(),
    };
    this.emitProgress(slot);
    return true;
  }

  /** Look up a run by id. Returns the latest snapshot or null. */
  get(runId: string): RoutineRunSnapshot | null {
    return this.runs.get(runId)?.snapshot ?? null;
  }

  /** All known runs (live + recently completed). */
  list(): RoutineRunSummary[] {
    const out: RoutineRunSummary[] = [];
    for (const slot of this.runs.values()) {
      out.push(this.summarize(slot.snapshot));
    }
    out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return out;
  }

  /**
   * Drop completed runs older than `olderThan` ms. Live runs are kept
   * regardless. Useful in tests to clean state between cases.
   */
  prune(olderThanMs: number): void {
    const cutoff = Date.now() - olderThanMs;
    for (const [runId, slot] of this.runs) {
      const isTerminal =
        slot.snapshot.state === "success" ||
        slot.snapshot.state === "error" ||
        slot.snapshot.state === "aborted";
      if (!isTerminal) continue;
      const endedAt = slot.snapshot.endedAt
        ? Date.parse(slot.snapshot.endedAt)
        : 0;
      if (endedAt && endedAt < cutoff) this.runs.delete(runId);
    }
  }

  /**
   * Helper for callers that have a routineId rather than a routine. Loads
   * from disk and starts. Returns null if the routine can't be loaded —
   * the caller should surface that as a WS error.
   */
  startById(args: {
    projectPath: string;
    cwd: string;
    routineId: string;
    inputs: Record<string, unknown>;
    runId?: string;
  }): { runId: string } | { error: string } {
    const routine = loadRoutineById(args.projectPath, args.routineId);
    if (!routine) {
      return { error: `Routine "${args.routineId}" not found or invalid.` };
    }
    const runId = this.start({
      routine,
      inputs: args.inputs,
      projectPath: args.projectPath,
      cwd: args.cwd,
      ...(args.runId !== undefined ? { runId: args.runId } : {}),
    });
    return { runId };
  }

  /**
   * Tear down. Drops all bus listeners. Safe to call multiple times.
   */
  dispose(): void {
    if (this.busUnsubscribe) {
      this.busUnsubscribe();
      this.busUnsubscribe = null;
    }
    this.endListeners.clear();
  }

  // ── Internals ───────────────────────────────────────────

  private summarize(snap: RoutineRunSnapshot): RoutineRunSummary {
    const out: RoutineRunSummary = {
      runId: snap.runId,
      routineId: snap.routineId,
      routineName: snap.routineName,
      state: snap.state,
      startedAt: snap.startedAt,
    };
    if (snap.endedAt) out.endedAt = snap.endedAt;
    return out;
  }

  private emitProgress(slot: RunSlot): void {
    this.bus.emitGlobal({
      type: "routine_progress",
      runId: slot.runId,
      snapshot: slot.snapshot as unknown as Record<string, unknown>,
    });
    if (slot.projectPath) {
      persistRun(slot.snapshot, slot.projectPath);
      pruneRunsOlderThan(slot.projectPath, ROUTINE_RUN_RETENTION_MS);
    }
  }

  /** Load terminal runs from SQLite into the in-memory map on boot. */
  private hydrateTerminalRuns(): void {
    const snapshots = loadRecentRuns(null, MAX_RETAINED_RUNS);
    for (const snap of snapshots) {
      if (this.runs.has(snap.runId)) continue;
      this.runs.set(snap.runId, {
        runId: snap.runId,
        routineId: snap.routineId,
        projectPath: "",
        snapshot: snap,
        donePromise: Promise.resolve(snap),
        abort: () => {},
        liveSessions: new Map(),
      });
    }
  }

  /**
   * Listen for session-end events on the bus and route them to anyone
   * who has subscribed via `subscribeSessionEnded`.
   */
  private installBusListener(): void {
    this.busUnsubscribe = this.bus.subscribe((envelope) => {
      const sessionKey = sessionKeyFromTopic(envelope.topic);
      if (!sessionKey) return;
      const handlers = this.endListeners.get(sessionKey);
      if (!handlers || handlers.size === 0) return;
      const ended = extractSessionEnd(envelope);
      if (!ended) return;
      // Snapshot before invoking — handlers usually unsubscribe themselves.
      for (const handler of [...handlers]) {
        handler(ended);
      }
    });
  }

  /** Subscribe one consumer to session-end signals for a given key. */
  subscribeSessionEnded(
    sessionKey: string,
    handler: (info: { reason: string; isError: boolean }) => void,
  ): () => void {
    let set = this.endListeners.get(sessionKey);
    if (!set) {
      set = new Set();
      this.endListeners.set(sessionKey, set);
    }
    set.add(handler);
    return () => {
      const current = this.endListeners.get(sessionKey);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.endListeners.delete(sessionKey);
    };
  }
}

/** Seed snapshot before the first scheduler tick — mirrors runRoutine's. */
function createPendingSnapshot(args: {
  runId: string;
  routine: Routine;
}): RoutineRunSnapshot {
  return {
    runId: args.runId,
    routineId: args.routine.id,
    routineName: args.routine.name,
    state: "pending",
    inputs: {},
    phases: args.routine.phases.map((p) => ({
      phaseId: p.id,
      label: p.label,
      state: "pending",
      steps: p.steps.map((s) => ({ stepId: s.id, label: s.label })),
    })),
    startedAt: new Date().toISOString(),
  };
}

