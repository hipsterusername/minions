/**
 * Lifecycle helpers for `SessionHost`.
 *
 *   - `ensureWorktree`       — resolves the effective cwd/worktree for this run
 *   - `buildHarnessStartOpts` — assembles the HarnessStartOptions for harness.start()
 *   - `processNormalizedEvent` — the per-event body of the `for await` loop
 */

import type {
  AgentType,
  AgentTypeContext,
  AgentToolResult,
} from "./agents/index.ts";
import type { SessionHostDeps } from "./session-host.ts";
import type {
  AgentHarness,
  HarnessStartOptions,
  NormalizedAttachment,
  NormalizedPermissionMode,
} from "./harness/types.ts";
import type { NormalizedEvent } from "../shared/normalized-event.ts";
import type { Bus } from "./bus.ts";
import { createWorktree, isGitRepo, type WorktreeInfo } from "./worktree.ts";
import {
  enrichSystemPromptForWorktree,
  modelSupportsAdaptive,
  type BufferedEvent,
} from "./session-host-config.ts";
import type { SessionHost, StartSessionOptions } from "./session-host.ts";
import { applySessionRunningForMinion } from "./task-lifecycle.ts";
import { injectSessionMessage } from "./session-message.ts";
import { pauseActiveRunForWait, requestWaitResume } from "./wait-resume.ts";
import { captureUsageEvent } from "./session-usage-capture.ts";
import { captureCheckpointHandoffEvent, recordCompactionUsage, withCompactionReminder } from "./proactive-compaction.ts";
/**
 * Ensure the host has the correct cwd + worktree wiring before the SDK
 * query opens. Mutates `host` in place and emits bus events on failure.
 *
 * Returns the effective cwd the SDK should use.
 */
export async function ensureWorktree(
  host: SessionHost,
  opts: StartSessionOptions,
  bus: Bus,
  agentType: AgentType,
): Promise<string> {
  let effectiveCwd = opts.cwd;

  // Inherit parent worktree for minion sessions
  if (opts.parentWorktree) {
    host.worktree = opts.parentWorktree;
    host.cwd = opts.parentWorktree.path;
    effectiveCwd = opts.parentWorktree.path;
    console.log(
      `[worktree] Minion ${host.id} inheriting worktree ${opts.parentWorktree.branch} at ${opts.parentWorktree.path}`,
    );
  } else {
    host.cwd = effectiveCwd;
  }

  if (!(agentType.wantsWorktree && host.worktreeIsolation)) {
    return effectiveCwd;
  }

  if (host.worktree && !opts.parentWorktree) {
    // Resume: reuse existing worktree
    host.cwd = host.worktree.path;
    return host.worktree.path;
  }

  if (opts.parentWorktree) return effectiveCwd;

  try {
    const inGitRepo = await isGitRepo(effectiveCwd);
    if (inGitRepo) {
      const worktreeInfo = await createWorktree(effectiveCwd, host.id);
      host.worktree = worktreeInfo;
      host.cwd = worktreeInfo.path;
      bus.emitToSession(host.id, {
        type: "worktree_created",
        sessionKey: host.id,
        worktreePath: worktreeInfo.path,
        branch: worktreeInfo.branch,
      });
      console.log(
        `[worktree] Created worktree for ${host.id} at ${worktreeInfo.path} (branch: ${worktreeInfo.branch})`,
      );
      effectiveCwd = worktreeInfo.path;
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[worktree] Failed to create worktree for ${host.id}: ${errMsg}`);
    bus.emitToSession(host.id, {
      type: "worktree_failed",
      sessionKey: host.id,
      error: `Worktree creation failed: ${errMsg}`,
    });
    host.worktreeIsolation = false;
    return effectiveCwd;
  }
  return effectiveCwd;
}

/** Parameters for `buildHarnessStartOpts`. */
export interface HarnessStartInput {
  host: SessionHost;
  opts: StartSessionOptions;
  agentType: AgentType;
  agentCtx: AgentTypeContext;
  toolResult: AgentToolResult;
  abortController: AbortController;
  harness: AgentHarness;
  prompt: string | AsyncIterable<{ role: "user"; content: string }>;
}

/**
 * Assemble the HarnessStartOptions passed to `harness.start()`.
 *
 * Harness-agnostic: each Claude-specific option lives inside ClaudeHarness
 * itself. This function only assembles the normalized contract fields.
 */
export function buildHarnessStartOpts(
  input: HarnessStartInput,
): { startOpts: HarnessStartOptions; allowedTools: string[] } {
  const { host, opts, agentType, agentCtx, toolResult, abortController, harness, prompt } = input;
  const externalToolNames = opts.externalMcpToolNames ?? [];
  const derivedMcpToolNames = Object.entries(toolResult.toolGroups).flatMap(
    ([serverName, defs]) => defs.map((def) => `mcp__${serverName}__${def.name}`),
  );
  const allowedTools = [
    ...harness.builtInTools,
    ...toolResult.mcpToolNames,
    ...derivedMcpToolNames,
    ...externalToolNames,
  ];

  const basePrompt = agentType.buildSystemPrompt(agentCtx, opts.systemPrompt, harness.builtInTools);
  const systemPrompt = basePrompt
    ? host.worktree
      ? enrichSystemPromptForWorktree(basePrompt, host.worktree, agentType.id === "minion")
      : basePrompt
    : "";

  const resolvedModel = host.model ? (harness.resolveModel(host.model) ?? host.model) : "";

  const startOpts: HarnessStartOptions = {
    sessionKey: host.id,
    cwd: host.cwd,
    prompt: withCompactionReminder(host, prompt),
    systemPrompt,
    model: resolvedModel,
    allowedTools,
    abortSignal: abortController.signal,
    resumeId: opts.resumeId,
    externalMcpServers: opts.externalMcpServers,
  };

  if (opts.attachments && opts.attachments.length > 0) {
    startOpts.attachments = opts.attachments as ReadonlyArray<NormalizedAttachment>;
  }
  const persistedPermissionMode = host.permissionMode;
  if (isNormalizedPermissionMode(persistedPermissionMode)) {
    startOpts.permissionMode = persistedPermissionMode;
  }

  if (
    harness.capabilities.thinking &&
    host.thinkingConfig?.enabled &&
    modelSupportsThinkingForHarness(harness.name, host.model)
  ) {
    startOpts.thinking = {
      effort: host.thinkingConfig.effort as "low" | "medium" | "high",
      display: host.thinkingConfig.display,
    };
  }

  return { startOpts, allowedTools };
}

function modelSupportsThinkingForHarness(
  harnessName: string,
  model: string | null,
): boolean {
  if (harnessName === "claude") return modelSupportsAdaptive(model);
  return true;
}

/**
 * Handle a single NormalizedEvent from `harness.start()`:
 *   - Capture session metadata from `init`.
 *   - Fan every event out to the bus as an `sdk_event` envelope.
 *   - Rebroadcast sub-agent events as canvas-aware bus events.
 *   - Update session status and trigger `onComplete` on `done`.
 */
export function processNormalizedEvent(
  host: SessionHost,
  bus: Bus,
  agentType: AgentType,
  agentCtx: AgentTypeContext,
  event: NormalizedEvent,
): void {
  const now = Date.now();
  if (host.role === "minion")
    applySessionRunningForMinion({ bus, minionSessionKey: host.id, forEachLeaderTaskState: agentCtx.forEachLeaderTaskState });

  // ── Capture session metadata ────────────────────────────────────────────
  if (event.kind === "init") {
    host.sessionId = event.sessionId;
    if (event.model) host.model = event.model;
    // Only refresh `host.permissionMode` when the harness reports one on init.
    // Harnesses that don't surface a permission mode in their init event
    // (Codex, Echo) leave the existing seed from `StartSessionOptions` /
    // `set_permission_mode` in place — Claude is the only one that overwrites
    // here, and only when the SDK actually returns a value.
    if (event.permissionMode) host.permissionMode = event.permissionMode;
    // `meta` carries Claude-specific init data (tools, mcp_servers, etc.).
    if (event.meta) host.initData = event.meta;
    host.persist();
  }

  // ── Sub-agent events (Claude Agent-tool) ────────────────────────────────
  if (event.kind === "agent_spawned" && agentType.detectsSubagents) {
    bus.emitToSession(host.id, {
      type: "agent_spawned",
      leaderSessionKey: host.id,
      taskId: event.taskId,
      title: event.description,
      description: event.description,
      timestamp: now,
    });
    return; // not emitted as sdk_event — it's a canvas-level event
  }

  if (event.kind === "agent_task_update" && agentType.detectsSubagents) {
    bus.emitToSession(host.id, {
      type: "agent_task_update",
      leaderSessionKey: host.id,
      taskId: event.taskId,
      status: event.status,
      summary: event.summary,
      timestamp: now,
    });
    return; // not emitted as sdk_event
  }

  // ── Accumulate cost from usage events ──────────────────────────────────
  if (event.kind === "usage") {
    captureUsageEvent(host, event, now);
    recordCompactionUsage(host, event);
  }
  captureCheckpointHandoffEvent(host, event);

  // ── Session completion ──────────────────────────────────────────────────
  if (event.kind === "done") {
    if (event.turns != null) host.turns = event.turns;
    if (event.costUSD != null) host.totalCost = event.costUSD;

    if (event.reason === "error") {
      host.status = "error";
      host.lastError = event.error ?? "unknown";
      host.lastErrorFull = event.fullError ?? host.lastError;
      host.persist();

      const errEvent: BufferedEvent = {
        type: "session_error",
        sessionKey: host.id,
        error: host.lastError,
        fullError: host.lastErrorFull,
        timestamp: now,
      };
      host.bufferEvent(errEvent);
      bus.emitToSession(host.id, errEvent);
    } else {
      host.status = "idle";
      host.persist();

      const idleEvent: BufferedEvent = {
        type: "session_status",
        sessionKey: host.id,
        status: "idle",
        sessionId: host.sessionId ?? undefined,
        timestamp: now,
      };
      host.bufferEvent(idleEvent);
      bus.emitToSession(host.id, idleEvent);
    }

    if (agentType.onComplete) {
      void agentType.onComplete(agentCtx, {
        is_error: event.reason === "error",
        result: event.result ?? null,
      });
    }
    return; // `done` is not emitted as sdk_event (signalled via session_status or session_error)
  }

  // ── Fan all remaining events to the bus as sdk_events ──────────────────
  const sdkEvent: BufferedEvent = {
    type: "sdk_event",
    sessionKey: host.id,
    event,
    timestamp: now,
  };
  host.bufferEvent(sdkEvent);
  bus.emitToSession(host.id, sdkEvent);
}

// ── Agent context builder ───────────────────────────────────────────────────

/**
 * Build the MCP agent context for a session run.
 */
export function buildAgentContext(
  host: SessionHost,
  opts: StartSessionOptions,
  deps: SessionHostDeps,
): AgentTypeContext {
  const ctx: AgentTypeContext = {
    sessionKey: host.id,
    cwd: host.cwd,
    bus: deps.bus,
    worktreeInfo: host.worktree,
    worktreeIsolation: host.worktreeIsolation,
    forEachLeaderTaskState: deps.forEachLeaderTaskState,
    getSessionRuntime: deps.getSessionRuntime,
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
        parentWorktree: host.worktree ?? undefined,
        initialModel: params.model ?? null,
        thinkingConfig: params.thinkingConfig ?? undefined,
        resumeId: params.sessionKey === host.id ? host.sessionId ?? undefined : undefined,
        harness: params.harness ?? host.harnessName,
      });
    },
    scheduleWaitContinue: (durationMs, reason) => {
      host.clearWaitTimer();
      console.log(
        `[wait] Leader ${host.id} waiting ${durationMs}ms: ${reason}`,
      );
      host.waitTimerId = setTimeout(() => {
        host.waitTimerId = null;
        requestWaitResume(host, deps, {
          completedReason: reason,
          opts: {
            sessionKey: host.id,
            prompt: `Continue. The ${Math.round(durationMs / 1000)}s wait has elapsed (reason: ${reason}). Pick up where you left off.`,
            cwd: host.cwd,
            resumeId: host.sessionId ?? undefined,
            systemPrompt: opts.systemPrompt,
            role: host.role,
            harness: host.harnessName,
          },
        });
      }, durationMs);
      pauseActiveRunForWait(host);
      return host.waitTimerId;
    },
    terminateSession: deps.terminateSession,
    messageSession: (sessionKey, message) =>
      injectSessionMessage(deps, sessionKey, message),
    wakeWaitingLeaderIfAllChildrenTerminal: deps.wakeWaitingLeaderIfAllChildrenTerminal,
  };
  if (host.taskState) ctx.existingTaskState = host.taskState;
  if (host.renderState) ctx.existingRenderState = host.renderState;
  if (opts.parentWorktree) ctx.parentWorktree = opts.parentWorktree;
  return ctx;
}

// Context-window recovery — extracted to session-host-context-recovery.ts.
export {
  isContextWindowError,
  shouldRecoverFromContextWindow,
  buildContextRecoveryStartOptions,
} from "./session-host-context-recovery.ts";

// Worktree type re-export — keeps the import surface narrow for session-host.ts.
export type { WorktreeInfo };

const VALID_PERMISSION_MODES: ReadonlySet<NormalizedPermissionMode> = new Set([
  "default",
  "auto",
  "bypassPermissions",
  "plan",
]);

function isNormalizedPermissionMode(
  v: string | null | undefined,
): v is NormalizedPermissionMode {
  return typeof v === "string" && VALID_PERMISSION_MODES.has(v as NormalizedPermissionMode);
}
