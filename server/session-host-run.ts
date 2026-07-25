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
import type {
  AgentHarness,
  HarnessStartOptions,
  NormalizedAttachment,
  NormalizedPermissionMode,
} from "./harness/types.ts";
import type { NormalizedEvent } from "../shared/normalized-event.ts";
import type { Bus } from "./bus.ts";
import { createWorktree, isGitRepo, provisionPlannedWorktree, type WorktreeInfo } from "./worktree.ts";
import {
  enrichSystemPromptForWorktree,
  modelSupportsAdaptive,
  type BufferedEvent,
} from "./session-host-config.ts";
import type { SessionHost, StartSessionOptions } from "./session-host.ts";
import { applySessionRunningForMinion } from "./task-lifecycle.ts";
import { captureUsageEvent } from "./session-usage-capture.ts";
import { captureCheckpointHandoffEvent, recordCompactionUsage, withCompactionReminder } from "./proactive-compaction.ts";
import { serverLogger } from "./logging.ts";
import { commitReviewLifecycle, finishRun } from "./session-review-lifecycle.ts";
import { emitMutationToolObservation } from "./mutation-observability.ts";
import { normalizedEventEnvelope, notifyRuntimeTerminal, sessionHostLogFields } from "./session-host-identity.ts";
import type { SessionHostDeps, WorkItemRuntimeLifecycle } from "./session-host-types.ts";
export { buildAgentContext } from "./session-host-agent-context.ts";
export { sessionHostLogFields } from "./session-host-identity.ts";

const log = serverLogger.child("session-host");

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
    log.debug("parent_worktree_inherited", { ...sessionHostLogFields(host), branch: opts.parentWorktree.branch, worktreePath: opts.parentWorktree.path });
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
    if (!inGitRepo) throw new Error("Worktree isolation requires a Git repository");
    const worktreeInfo = opts.plannedContribution
      ? await provisionPlannedWorktree(opts.plannedContribution)
      : await createWorktree(effectiveCwd, host.id);
    host.worktree = worktreeInfo;
    host.cwd = worktreeInfo.path;
    bus.emitToSession(host.id, {
      type: "worktree_created",
      sessionKey: host.id,
      worktreePath: worktreeInfo.path,
      branch: worktreeInfo.branch,
    });
    log.info("worktree_created", { ...sessionHostLogFields(host), branch: worktreeInfo.branch, worktreePath: worktreeInfo.path });
    effectiveCwd = worktreeInfo.path;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error("worktree_create_failed", { ...sessionHostLogFields(host), error: err });
    bus.emitToSession(host.id, {
      type: "worktree_failed",
      sessionKey: host.id,
      error: `Worktree creation failed: ${errMsg}`,
    });
    // Isolation is a safety boundary, especially for harnesses whose mutation
    // interception is observe-only. Never downgrade a requested worktree run
    // into a shared-directory writer when provisioning fails.
    throw err;
  }
  return effectiveCwd;
}
export async function ensureContributionWorktree(host: SessionHost, opts: StartSessionOptions, bus: Bus,
  agentType: AgentType, transition?: SessionHostDeps["transitionWorktreeProvisioning"]): Promise<void> {
  transition?.(host.runKey, "provisioning");
  try { await ensureWorktree(host, opts, bus, agentType); transition?.(host.runKey, "active"); }
  catch (error) { transition?.(host.runKey, "failed",
    error instanceof Error ? error.message : String(error)); throw error; }
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
  const effectiveSystemPrompt = opts.plannedContribution?.resolutionTargetRef
    ? `${systemPrompt}\n\nThis is a ${opts.plannedContribution.resolutionKind === "lineage" ? "final-lineage" : "contribution"} conflict-resolution iteration. In the retained worktree, merge the latest ${opts.plannedContribution.resolutionTargetRef} into ${opts.plannedContribution.branch}, resolve conflicts, and leave the branch clean. Do not promote directly; gates and approval run afterward.`
    : systemPrompt;

  const resolvedModel = host.model ? (harness.resolveModel(host.model) ?? host.model) : "";

  const startOpts: HarnessStartOptions = {
    sessionKey: host.id,
    cwd: host.cwd,
    prompt: withCompactionReminder(host, prompt),
    systemPrompt: effectiveSystemPrompt,
    model: resolvedModel,
    allowedTools,
    abortSignal: abortController.signal,
    // Provider continuations intentionally open a fresh SDK thread while
    // retaining the same Minions run identity.
    resumeId: opts.invocationKind === "provider_continuation"
      ? undefined
      : opts.resumeId,
    externalMcpServers: opts.externalMcpServers,
    ...(agentCtx.mutationCoordination
      ? { mutationCoordination: agentCtx.mutationCoordination } : {}),
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
      effort: host.thinkingConfig.effort,
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
  runtimeLifecycle?: WorkItemRuntimeLifecycle,
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
    if (host.workItemId) {
      const identity = { workItemId: host.workItemId, runKey: host.runKey, runKind: host.runKind, parentRunKey: host.parentRunKey, taskId: host.taskId };
      runtimeLifecycle?.providerInitialized({ ...identity, providerSessionId: event.sessionId,
        providerGeneration: host.providerInvocationGeneration, at: now });
      runtimeLifecycle?.runStarted({ ...identity, at: now });
    }
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

  // Phase 0 is deliberately observe-only: no lease, wait, block, or event
  // rewriting happens at this boundary.
  if (event.kind === "tool_call") {
    emitMutationToolObservation({
      bus,
      sessionKey: host.id,
      runKey: host.runKey,
      workItemId: host.workItemId,
      harness: host.harnessName,
      event,
      timestamp: now,
    });
  }

  // ── Session completion ──────────────────────────────────────────────────
  if (event.kind === "done") {
    if (event.turns != null) host.turns = event.turns;
    if (event.costUSD != null) host.totalCost = event.costUSD;

    host.status = event.reason === "error" ? "error" : "idle";
    if (event.reason === "error") {
      host.lastError = event.error ?? "unknown";
      host.lastErrorFull = event.fullError ?? host.lastError;
    }

    if (agentType.onComplete) {
      void agentType.onComplete(agentCtx, {
        is_error: event.reason === "error",
        result: event.result ?? null,
      });
    }
    let blocked = false;
    let durableTask: { status: string; result: string | null; taskId: string } | null = null;
    let durableLeaderKey: string | null = null;
    agentCtx.forEachLeaderTaskState?.((leaderKey, state) => {
      const task = [...state.tasks.values()].find((candidate) => candidate.minionSessionKey === host.id);
      if (!task) return;
      if (task.status === "blocked") blocked = true;
      durableTask = task;
      durableLeaderKey = leaderKey;
    });
    const waitKind = host.reviewLifecycle.reviewState === "decision_needed" ? "decision"
      : host.taskState?.pendingWait ? "timer"
      : blocked ? "blocked"
      : (host.status as string) === "running" ? "continuation" : null;
    if (waitKind) {
      if (host.workItemId && (waitKind === "blocked" || waitKind === "continuation")) runtimeLifecycle?.runWaiting({
        workItemId: host.workItemId, runKey: host.runKey, runKind: host.runKind,
        parentRunKey: host.parentRunKey, taskId: host.taskId, waitKind, at: now,
      });
      if ((host.status as string) !== "running") {
        host.status = "idle";
        const idle: BufferedEvent = { type: "session_status", sessionKey: host.id, status: "idle", sessionId: host.sessionId ?? undefined, timestamp: now };
        host.bufferEvent(idle);
        bus.emitToSession(host.id, idle);
      }
    } else {
      agentCtx.cleanupLiveEditRun?.(host.runKey);
      const normalizedReason = event.reason !== "error" && event.reason !== "abort"
        && Boolean(event.result?.trim()) ? "completed" : event.reason;
      commitReviewLifecycle(host, bus, finishRun(host.reviewLifecycle, { reason: normalizedReason, report: event.reason === "error" ? event.error : event.result, at: now }), now);
      const payload: BufferedEvent = event.reason === "error"
        ? { type: "session_error", sessionKey: host.id, error: host.lastError ?? "unknown", fullError: host.lastErrorFull ?? undefined, timestamp: now }
        : { type: "session_status", sessionKey: host.id, status: "idle", sessionId: host.sessionId ?? undefined, timestamp: now };
      host.bufferEvent(payload);
      bus.emitToSession(host.id, payload);
      if (host.workItemId) {
        const durable = durableTask as { status: string; result: string | null; taskId: string } | null;
        const taskStatus = durable?.status;
        const taskReport = durable?.result?.trim() || null;
        const eventReport = event.result?.trim() || null;
        const completed = host.runKind === "child" && taskStatus === "completed"
          ? Boolean(taskReport)
          : event.reason !== "error" && event.reason !== "abort" && Boolean(eventReport);
        const failed = host.runKind === "child" && taskStatus === "failed";
        const finalReport = host.runKind === "child" && (completed || failed)
          ? taskReport : completed ? eventReport : null;
        const finalReportId = finalReport && host.runKind === "child" && durableLeaderKey
          ? `task:${durableLeaderKey}:${durable!.taskId}:report`
          : finalReport ? `${host.runKey}:final-report` : null;
        notifyRuntimeTerminal(host, runtimeLifecycle, {
          outcome: event.reason === "error" || failed ? "error" : completed ? "completed" : "interrupted",
          finalReportId, finalReport, at: now,
        });
      }
    }
    log.info("run_finished", {
      ...sessionHostLogFields(host),
      outcome: event.reason,
    });
    return; // `done` is not emitted as sdk_event (signalled via session_status or session_error)
  }

  // ── Fan all remaining events to the bus as sdk_events ──────────────────
  const sdkEvent = normalizedEventEnvelope(host, event, now);
  host.bufferEvent(sdkEvent);
  bus.emitToSession(host.id, sdkEvent);
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
