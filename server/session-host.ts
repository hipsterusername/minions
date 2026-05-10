/**
 * SessionHost — per-session lifecycle owner.
 *
 * Encapsulates the state and lifecycle of a single Claude Code session:
 * the abort controller, SDK query handle, event buffer, task/render state,
 * wait timer, and worktree handle. Owns the SDK `query()` loop and the
 * SQLite write-through persistence calls.
 *
 * Extracted from the old monolithic `server/index.ts` in Phase 5.1. The
 * goal of this module is to give `server/index.ts` a single object to
 * dispatch per-session work against instead of managing a flat struct in
 * a Map.
 *
 * Non-goals:
 *   - Does not own the WebSocket dispatcher (that stays in `server/index.ts`
 *     until Phase 5.2 splits the command table).
 *   - Does not own worktree lifecycle semantics (those still live in
 *     `server/worktree.ts`; the host merely holds the handle).
 */

import "./harness/claude/index.ts"; // side-effect: registers ClaudeHarness
import "./harness/echo/index.ts"; // side-effect: registers EchoHarness
import "./harness/codex/index.ts"; // side-effect: registers CodexHarness
import { getHarness } from "./harness/index.ts";
import type {
  HarnessRunControl,
  NormalizedEvent,
} from "./harness/types.ts";
import type { Bus } from "./bus.ts";
import { getAgentType, type AgentTypeContext } from "./agents/index.ts";
import type { WorktreeInfo } from "./worktree.ts";
import type { TaskManagerState } from "./task-tools.ts";
import type { RenderState } from "./render-tools.ts";
import {
  persistEvent as persistEventToDb,
  persistSession as persistSessionToDb,
  type PersistableSession,
} from "./session-persist.ts";
import {
  MAX_BUFFERED_EVENTS,
  deriveTaskName,
  type BufferedEvent,
  type SessionRole,
  type SessionStatus,
  type ThinkingConfig,
} from "./session-host-config.ts";
import {
  ensureWorktree,
  buildHarnessStartOpts,
  processNormalizedEvent,
} from "./session-host-run.ts";

// Re-export shared types so callers can import everything from session-host.
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

// ── Host dependencies + options ────────────────────────────

/**
 * External services the host needs to operate. Passed in at start time so the
 * host stays decoupled from `server/index.ts` and testable in isolation.
 */
export interface SessionHostDeps {
  bus: Bus;
  /**
   * Start (or resume) another session. Used by the host for minion spawning
   * and self-resume after a `wait_and_continue` timer fires. The registry
   * wires this so it routes back through itself.
   */
  startChildSession: (opts: StartSessionOptions) => void;
  /** Enumerate every leader's task state for MCP tools that need it. */
  forEachLeaderTaskState: (
    fn: (leaderKey: string, state: TaskManagerState) => void,
  ) => void;
}

/**
 * Binary image attachment pinned to the first user turn. The host
 * converts each one into a Base64-source {@link ImageBlockParam} so
 * the SDK sends real pixels to the model.
 */
export interface ImageAttachment {
  kind: "image";
  filename?: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  /** Pure base64 payload — no `data:` prefix. */
  data: string;
}

export interface StartSessionOptions {
  sessionKey: string;
  prompt: string;
  cwd: string;
  resumeId?: string | undefined;
  systemPrompt?: string | undefined;
  role?: SessionRole | undefined;
  worktreeIsolation?: boolean | undefined;
  parentWorktree?: WorktreeInfo | undefined;
  initialModel?: string | null | undefined;
  thinkingConfig?: ThinkingConfig | null | undefined;
  /** Multimodal attachments riding on the first user message. */
  attachments?: ImageAttachment[] | undefined;
  /**
   * External MCP servers resolved from a routine step's `mcpServerIds`.
   * Merged into the session's `mcpServers` dict alongside the agent's
   * built-in servers. Shape: server name → SDK-compatible config object.
   */
  externalMcpServers?: Record<string, unknown> | undefined;
  /**
   * Formatted tool names for servers in `externalMcpServers`.
   * Each name follows the `mcp__<serverId>__<toolName>` convention and
   * is appended to `allowedTools` so the agent can call without prompts.
   */
  externalMcpToolNames?: string[] | undefined;
  /**
   * Name of the registered AgentHarness to use for this session.
   * Defaults to "claude". Pass a different name to route the session
   * through a non-Claude harness registered via `registerHarness()`.
   */
  harness?: string | undefined;
}

// ── SessionHost ────────────────────────────────────────────

/**
 * Per-session lifecycle owner. Instances are long-lived — they survive
 * across `start()` calls (resume) until `dispose()` is invoked by the
 * registry on `remove_session`.
 */
export class SessionHost {
  // ── Identity ───────────────────────────────────────
  readonly id: string;
  sessionId: string | null = null;
  status: SessionStatus = "idle";
  cwd: string;
  role: SessionRole = "default";
  taskName: string | null = null;

  // ── Persisted metrics ──────────────────────────────
  totalCost = 0;
  turns = 0;

  // ── Volatile runtime state ─────────────────────────
  /** Registered harness name for this session (e.g. "claude"). */
  harnessName = "claude";
  abortController: AbortController = new AbortController();
  eventStream: AsyncIterable<NormalizedEvent> | null = null;
  runControl: HarnessRunControl | null = null;
  eventBuffer: BufferedEvent[] = [];
  lastError: string | null = null;
  model: string | null = null;
  permissionMode: string | null = null;
  /** Adaptive-thinking config supplied by the client. Refreshed on each turn. */
  thinkingConfig: ThinkingConfig | null = null;
  initData: Record<string, unknown> | null = null;
  /** For leader sessions: the task manager state tracking minion tasks */
  taskState: TaskManagerState | null = null;
  worktree: WorktreeInfo | null = null;
  worktreeIsolation = false;
  /** Active wait timer for wait_and_continue (leader only) */
  waitTimerId: ReturnType<typeof setTimeout> | null = null;
  /** Current render dashboard state (leader only) — kept in sync by render MCP tools */
  renderState: RenderState | null = null;

  constructor(id: string, cwd: string) {
    this.id = id;
    this.cwd = cwd;
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
      totalCost: this.totalCost,
      turns: this.turns,
      harnessName: this.harnessName,
    };
    persistSessionToDb(snap);
  }

  /** Clear any active wait_and_continue timer. */
  clearWaitTimer(): void {
    if (this.waitTimerId) {
      clearTimeout(this.waitTimerId);
      this.waitTimerId = null;
    }
  }

  /**
   * Build the MCP agent context for this run. Wires callbacks through
   * `deps` so the agent can spawn minions or schedule a delayed resume
   * without knowing about the registry directly.
   */
  private buildAgentContext(
    opts: StartSessionOptions,
    deps: SessionHostDeps,
  ): AgentTypeContext {
    const ctx: AgentTypeContext = {
      sessionKey: this.id,
      cwd: this.cwd,
      bus: deps.bus,
      worktreeInfo: this.worktree,
      worktreeIsolation: this.worktreeIsolation,
      forEachLeaderTaskState: deps.forEachLeaderTaskState,
      startMinionSession: (params) => {
        // Default the spawned minion to the leader's current harness so a
        // non-Claude leader spawns same-harness minions unless the caller
        // explicitly overrides it.
        deps.startChildSession({
          sessionKey: params.sessionKey,
          prompt: params.prompt,
          cwd: params.cwd,
          systemPrompt: params.systemPrompt,
          role: "minion",
          worktreeIsolation: false,
          parentWorktree: this.worktree ?? undefined,
          harness: params.harness ?? this.harnessName,
        });
      },
      scheduleWaitContinue: (durationMs, reason) => {
        this.clearWaitTimer();
        console.log(
          `[wait] Leader ${this.id} waiting ${durationMs}ms: ${reason}`,
        );
        this.waitTimerId = setTimeout(() => {
          this.waitTimerId = null;
          deps.bus.emitToSession(this.id, {
            type: "wait_state",
            sessionKey: this.id,
            action: "completed",
            reason,
            timestamp: Date.now(),
          });
          deps.startChildSession({
            sessionKey: this.id,
            prompt: `Continue. The ${Math.round(
              durationMs / 1000,
            )}s wait has elapsed (reason: ${reason}). Pick up where you left off.`,
            cwd: this.cwd,
            resumeId: this.sessionId ?? undefined,
            systemPrompt: opts.systemPrompt,
            role: this.role,
            harness: this.harnessName,
          });
        }, durationMs);
      },
    };
    if (this.taskState) ctx.existingTaskState = this.taskState;
    if (this.renderState) ctx.existingRenderState = this.renderState;
    if (opts.parentWorktree) ctx.parentWorktree = opts.parentWorktree;
    return ctx;
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
    // Derive a task name for agent types that want one (leader) — done
    // before we might mutate cwd based on worktree.
    const resolvedRole: SessionRole = opts.role ?? this.role ?? "default";
    const agentType = getAgentType(resolvedRole);

    // ── Reset per-run volatile state ──────────────────
    const abortController = new AbortController();
    this.status = "running";
    this.abortController = abortController;
    this.eventStream = null;
    this.runControl = null;
    this.lastError = null;
    this.role = resolvedRole;
    if (opts.resumeId) this.sessionId = opts.resumeId;
    if (opts.harness) this.harnessName = opts.harness;
    if (opts.initialModel && !this.model) this.model = opts.initialModel;
    if (opts.thinkingConfig !== undefined) {
      this.thinkingConfig = opts.thinkingConfig ?? this.thinkingConfig;
    }
    this.worktreeIsolation = opts.worktreeIsolation === true;

    // Clear any existing wait timer when the session resumes.
    this.clearWaitTimer();

    if (!this.taskName && agentType.wantsWorktree) {
      this.taskName = deriveTaskName(opts.prompt);
    }

    await ensureWorktree(this, opts, deps.bus, agentType);
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
    try {
      const agentCtx = this.buildAgentContext(opts, deps);
      const toolResult = agentType.getToolGroups(agentCtx);

      if (toolResult.taskState) this.taskState = toolResult.taskState;
      if (toolResult.renderState) this.renderState = toolResult.renderState;

      const harness = getHarness(this.harnessName);

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
      try {
        for await (const event of events) {
          if (abortController.signal.aborted) break;
          processNormalizedEvent(this, deps.bus, agentType, agentCtx, event);
        }
      } finally {
        this.eventStream = null;
        this.runControl = null;
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.status = "error";
      this.lastError = errorMessage;
      this.persist();
      const errorEvent: BufferedEvent = {
        type: "session_error",
        sessionKey: this.id,
        error: errorMessage,
        timestamp: Date.now(),
      };
      this.bufferEvent(errorEvent);
      deps.bus.emitToSession(this.id, errorEvent);
    }
  }
}

