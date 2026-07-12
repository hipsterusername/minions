/**
 * SessionHost — per-session lifecycle owner.
 *
 * Encapsulates the state and lifecycle of a single Claude Code session:
 * the abort controller, SDK query handle, event buffer, task/render state,
 * wait timer, and worktree handle. Owns the SDK `query()` loop and the
 * SQLite write-through persistence calls.
 * WebSocket dispatch lives under `server/commands/`; worktree lifecycle
 * semantics live under `server/worktree*.ts`. The host coordinates those
 * subsystems but does not own their policies.
 */

import "./harness/register-production.ts";
import "./harness/echo/index.ts"; // side-effect: registers EchoHarness
import { getHarness } from "./harness/index.ts";
import { assertSafeHarnessMutationMode, installChangeIntentTools } from "./session-mutation-enforcement.ts";
import type {
  HarnessRunControl,
  NormalizedEvent,
} from "./harness/types.ts";
import { getAgentType } from "./agents/index.ts";
import type { WorktreeInfo } from "./worktree.ts";
import type { TaskManagerState } from "./task-tools.ts";
import type { RenderState } from "./render-tools.ts";
import { persistEvent as persistEventToDb, persistSession as persistSessionToDb, type PersistableSession } from "./session-persist.ts";
import { emptyUsageTotals, type SessionUsageTotals } from "./usage-telemetry.ts";
import { buildPendingCompactionStartOptions, createProactiveCompactionState, type ProactiveCompactionState } from "./proactive-compaction.ts";
import {
  MAX_BUFFERED_EVENTS,
  deriveTaskName,
  type BufferedEvent,
  type SessionRole,
  type SessionStatus,
  type ThinkingConfig,
} from "./session-host-config.ts";
import {
  ensureContributionWorktree,
  buildContextRecoveryStartOptions,
  buildHarnessStartOpts,
  processNormalizedEvent,
  shouldRecoverFromContextWindow,
} from "./session-host-run.ts";
import {
  terminateSessionHost,
  type SessionTerminateDeps,
  type SessionTerminateReason,
} from "./session-host-terminate.ts";
import { applySessionEndedForMinion } from "./task-lifecycle.ts";
import { setSessionCanvasContext } from "./canvas-context-store.ts";
import { drainQueuedWaitResume } from "./wait-resume.ts";
import type { ContextCheckpoint } from "./context-checkpoint.ts";
import { commitCheckpointOnInit, failUninitializedCheckpoint } from "./session-host-checkpoint.ts";
import { beginRun, commitReviewLifecycle, finishRun, initialSessionReviewLifecycle, type SessionReviewLifecycle } from "./session-review-lifecycle.ts";
import { serverLogger } from "./logging.ts";
import { normalizedEventEnvelope, notifyRuntimeTerminal, seedSessionRunLineage, sessionHostLogFields } from "./session-host-identity.ts";
import { buildAgentContext } from "./session-host-agent-context.ts";
import type {
  SessionHostDeps,
  SessionInvocationKind,
  SessionRunKind,
  WorkItemRuntimeLifecycle,
  StartSessionOptions,
} from "./session-host-types.ts";

const log = serverLogger.child("session-host");
export {
  MAX_BUFFERED_EVENTS,
  isValidThinkingConfig,
} from "./session-host-config.ts";
export type {
  BufferedEvent,
  SessionRole,
  SessionStatus,
  ThinkingConfig,
  EffortLevel,
  ThinkingDisplay,
} from "./session-host-config.ts";
export type {
  ImageAttachment,
  SessionHostDeps,
  SessionInvocationKind,
  SessionRunKind,
  WorkItemRuntimeLifecycle,
  StartSessionOptions,
} from "./session-host-types.ts";

// ── SessionHost ────────────────────────────────────────────
/**
 * Per-session lifecycle owner. Instances are long-lived — they survive
 * across `start()` calls (resume) until `dispose()` is invoked by the
 * registry on `remove_session`.
 */
export class SessionHost {
  readonly id: string;
  /** Canonical run identity; `sessionKey` remains its compatibility alias. */
  readonly runKey: string;
  /** Durable parent identity, if supplied by the launch boundary. */
  workItemId: string | null = null;
  runKind: SessionRunKind = "primary";
  parentRunKey: string | null = null;
  taskId: string | null = null;
  runLineageSeeded = false; runtimeTerminalNotified = false; runtimeTerminalInFlight = false;
  sessionId: string | null = null;
  providerInvocationGeneration = 0;
  status: SessionStatus = "idle";
  cwd: string;
  role: SessionRole = "default";
  /** Skill IDs tagged on this session (leader only); gate opt-in tools. */
  skillIds: string[] = [];
  taskName: string | null = null;

  totalCost = 0;
  turns = 0;
  usageTotals: SessionUsageTotals = emptyUsageTotals();

  // ── Volatile runtime state ─────────────────────────
  /** Registered harness name for this session (e.g. "claude"). */
  harnessName = "claude";
  abortController: AbortController = new AbortController();
  eventStream: AsyncIterable<NormalizedEvent> | null = null;
  runControl: HarnessRunControl | null = null;
  eventBuffer: BufferedEvent[] = [];
  lastError: string | null = null;
  lastErrorFull: string | null = null;
  model: string | null = null;
  permissionMode: string | null = null;
  thinkingConfig: ThinkingConfig | null = null;
  initData: Record<string, unknown> | null = null;
  taskState: TaskManagerState | null = null;
  worktree: WorktreeInfo | null = null;
  worktreeIsolation = false;
  waitTimerId: ReturnType<typeof setTimeout> | null = null;
  renderState: RenderState | null = null;
  canvasContext: string | null = null;
  proactiveCompaction: ProactiveCompactionState = createProactiveCompactionState();
  contextCheckpoint: ContextCheckpoint | null = null;
  reviewLifecycle: SessionReviewLifecycle = initialSessionReviewLifecycle();
  private terminateDeps: SessionTerminateDeps | null = null;
  constructor(id: string, cwd: string) {
    this.id = id;
    this.runKey = id;
    this.cwd = cwd;
  }
  seedRunLineage(input: {
    runKind?: SessionRunKind;
    parentRunKey?: string | null;
    taskId?: string | null;
  }): boolean {
    return seedSessionRunLineage(this, input);
  }

  // ── Small helpers ───────────────────────────────────
  /**
   * Push an event onto the buffer, trimming to the retention cap, and
   * write it through to the on-disk event_log so it survives a restart.
   * Persistence failures are swallowed inside `persistEventToDb` so the
   * SDK loop keeps running even if the DB is unavailable.
   */
  bufferEvent(event: BufferedEvent): void {
    this.eventBuffer.push(event);
    if (this.eventBuffer.length > MAX_BUFFERED_EVENTS) {
      this.eventBuffer = this.eventBuffer.slice(-MAX_BUFFERED_EVENTS);
    }
    persistEventToDb(this.id, event);
  }

  /** Write-through persistence to SQLite (idempotent). */
  persist(): void {
    const snap: PersistableSession = {
      id: this.id,
      status: this.status,
      cwd: this.cwd,
      model: this.model,
      role: this.role,
      taskName: this.taskName,
      sessionId: this.sessionId,
      worktreeIsolation: this.worktreeIsolation,
      worktree: this.worktree,
      approval: this.taskState?.approval ?? null,
      totalCost: this.totalCost,
      turns: this.turns,
      harnessName: this.harnessName,
      reviewLifecycle: this.reviewLifecycle,
    };
    persistSessionToDb(snap);
  }
  /** Clear any active wait_and_continue timer. */
  clearWaitTimer(): void {
    if (this.waitTimerId) {
      clearTimeout(this.waitTimerId);
      this.waitTimerId = null;
    }
    if (this.taskState?.pendingWait) this.taskState.pendingWait.timerId = null;
  }

  setCanvasContext(canvasContext: string | null): void {
    this.canvasContext = canvasContext;
    setSessionCanvasContext(this.id, canvasContext);
  }

  // ── Lifecycle ───────────────────────────────────────
  /**
   * Start or resume this session. Corresponds to the old `runSession` flow:
   *   1. Reset volatile state for a fresh SDK run
   *   2. Create or reuse a worktree for agent types that want one
   *   3. Build the MCP agent context
   *   4. Open the SDK query and fan events out onto the bus
   *
   * Safe to call repeatedly — each call supersedes the previous run.
   */
  async start(opts: StartSessionOptions, deps: SessionHostDeps): Promise<void> {
    if (this.status === "running") { return; }
    const abortController = new AbortController();
    this.terminateDeps = deps;

    try {
      if ((opts.runKind !== undefined || opts.parentRunKey !== undefined || opts.taskId !== undefined)
        && !this.seedRunLineage(opts)) {
        log.warn("run_lineage_context_mismatch", {
          ...sessionHostLogFields(this),
          receivedRunKind: opts.runKind ?? null,
          receivedParentRunKey: opts.parentRunKey ?? null,
          receivedTaskId: opts.taskId ?? null,
        });
      } else if (!this.runLineageSeeded) {
        this.seedRunLineage({ runKind: "primary" });
      }
      if (opts.workItemId !== undefined) {
        if (opts.workItemId && this.workItemId === null) {
          this.workItemId = opts.workItemId;
        } else if (opts.workItemId && this.workItemId !== opts.workItemId) {
          // Phase 0 must not alter session behavior. Keep the first identity
          // and expose a mismatch for Phase 1's command boundary to reject.
          log.warn("work_item_context_mismatch", {
            ...sessionHostLogFields(this),
            receivedWorkItemId: opts.workItemId,
          });
        }
      }
      log.info("run_starting", sessionHostLogFields(this));
      this.abortController = abortController;
      // Derive a task name for agent types that want one (leader) — done
      // before we might mutate cwd based on worktree.
      const resolvedRole: SessionRole = opts.role ?? this.role ?? "default";
      const agentType = getAgentType(resolvedRole);
      // ── Reset per-run volatile state ──────────────────
      this.status = "running";
      // Internal continuations supply explicit invocation semantics.
      const invocationKind: SessionInvocationKind = opts.invocationKind ?? "new_run";
      this.providerInvocationGeneration += 1;
      if (invocationKind === "new_run") {
        this.runtimeTerminalNotified = false; this.runtimeTerminalInFlight = false;
        this.reviewLifecycle = beginRun(this.reviewLifecycle);
      }
      this.eventStream = null;
      this.runControl = null;
      this.lastError = null;
      this.lastErrorFull = null;
      this.role = resolvedRole;
      // Seed tagged skills from the launch payload; persist across resume/wait
      // cycles where opts no longer carries them.
      if (opts.skillIds) this.skillIds = opts.skillIds;
      if (opts.resumeId) this.sessionId = opts.resumeId;
      if (opts.harness) this.harnessName = opts.harness;
      if (opts.initialModel && !this.model) this.model = opts.initialModel;
      // Seed permission mode from create_session on the first run only;
      // resume / wait_and_continue keep the persisted live value.
      if (opts.permissionMode && !this.permissionMode) {
        this.permissionMode = opts.permissionMode;
      }
      if (opts.thinkingConfig !== undefined) {
        this.thinkingConfig = opts.thinkingConfig ?? this.thinkingConfig;
      }
      if (opts.worktreeIsolation !== undefined) {
        this.worktreeIsolation = opts.worktreeIsolation === true;
      }
      const harness = getHarness(this.harnessName);
      assertSafeHarnessMutationMode(this, harness, deps.bus, opts.parentWorktree !== undefined);
      // Clear any existing wait timer when the session resumes.
      this.clearWaitTimer();

      if (!this.taskName && agentType.wantsWorktree) {
        this.taskName = deriveTaskName(opts.prompt);
      }

      await ensureContributionWorktree(this, opts, deps.bus, agentType, deps.transitionWorktreeProvisioning);
      this.persist();

      // ── Broadcast running status ──────────────────────
      const statusEvent: BufferedEvent = {
        type: "session_status",
        sessionKey: this.id,
        status: "running",
        timestamp: Date.now(),
      };
      this.bufferEvent(statusEvent);
      deps.bus.emitToSession(this.id, statusEvent);

      // ── Run the harness query ─────────────────────────
      const agentCtx = buildAgentContext(this, opts, deps);
      const toolResult = agentType.getToolGroups(agentCtx);
      installChangeIntentTools(agentCtx, toolResult);
      if (toolResult.taskState) this.taskState = toolResult.taskState;
      if (toolResult.renderState) this.renderState = toolResult.renderState;
      // Register tools with the harness (grouped by MCP server name).
      harness.registerTools(toolResult.toolGroups);

      const { startOpts } = buildHarnessStartOpts({
        host: this,
        opts,
        agentType,
        agentCtx,
        toolResult,
        abortController,
        harness,
        prompt: opts.prompt,
      });

      const { events, control } = harness.start(startOpts);
      this.eventStream = events;
      this.runControl = control;
      let recoveryOpts: StartSessionOptions | null = null;
      let checkpointInitialized = false;
      try {
        for await (const event of events) {
          if (abortController.signal.aborted) break;
          if (
            event.kind === "done" &&
            shouldRecoverFromContextWindow(opts, event)
          ) {
            recoveryOpts = buildContextRecoveryStartOptions(this, opts, event);
            const recoveryEvent = normalizedEventEnvelope(
              this,
              {
                kind: "text",
                role: "assistant",
                text:
                  "The Codex thread exceeded the model context window. Starting a fresh continuation with compacted session state.",
              },
            );
            this.bufferEvent(recoveryEvent);
            deps.bus.emitToSession(this.id, recoveryEvent);
            break;
          }
          processNormalizedEvent(this, deps.bus, agentType, agentCtx, event, deps.workItemLifecycle);
          checkpointInitialized = commitCheckpointOnInit(this, deps, opts, event) || checkpointInitialized;
        }
      } finally {
        this.eventStream = null;
        this.runControl = null;
      }
      if (!recoveryOpts) {
        recoveryOpts = buildPendingCompactionStartOptions(this, opts);
      }
      failUninitializedCheckpoint(this, opts, checkpointInitialized, "Fresh provider thread ended before initialization.");
      // Reset status so the guard allows the recursive recovery start.
      if (recoveryOpts) { this.status = "idle"; await this.start(recoveryOpts, deps); }
      else drainQueuedWaitResume(this, deps);
    } catch (err: unknown) {
      if (abortController.signal.aborted || this.abortController !== abortController) return;
      const errorMessage = err instanceof Error ? err.message : String(err);
      failUninitializedCheckpoint(this, opts, false, errorMessage);
      this.status = "error";
      this.lastError = errorMessage;
      this.lastErrorFull = errorMessage;
      deps.cleanupLiveEditRun?.(this.runKey);
      notifyRuntimeTerminal(this, deps.workItemLifecycle, { outcome: "error", finalReportId: null, finalReport: null, at: Date.now() });
      log.error("run_failed", {
        ...sessionHostLogFields(this),
        error: err,
      });
      commitReviewLifecycle(this, deps.bus, finishRun(this.reviewLifecycle, { reason: "error", report: errorMessage, at: Date.now() }));
      this.persist();
      const errorEvent: BufferedEvent = {
        type: "session_error",
        sessionKey: this.id,
        error: errorMessage,
        fullError: errorMessage,
        timestamp: Date.now(),
      };
      this.bufferEvent(errorEvent);
      deps.bus.emitToSession(this.id, errorEvent);
      if (this.role === "minion") {
        applySessionEndedForMinion({
          bus: deps.bus,
          minionSessionKey: this.id,
          reason: "error",
          result: errorMessage,
          forEachLeaderTaskState: deps.forEachLeaderTaskState,
          onAfterLifecycle: deps.wakeWaitingLeaderIfAllChildrenTerminal,
        });
      }
    }
  }
  terminate(reason: SessionTerminateReason, deps?: SessionTerminateDeps): void {
    const base = this.terminateDeps;
    const effective = deps ? { ...base, ...deps, workItemLifecycle: deps.workItemLifecycle ?? base?.workItemLifecycle } : base;
    void terminateSessionHost(this, effective, reason);
  }
}
