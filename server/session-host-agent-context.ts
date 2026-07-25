import type { AgentTypeContext } from "./agents/index.ts";
import { randomUUID } from "node:crypto";
import type { SessionHost } from "./session-host.ts";
import type { SessionHostDeps, StartSessionOptions } from "./session-host-types.ts";
import { injectSessionMessage } from "./session-message.ts";
import { pauseActiveRunForWait, requestWaitResume } from "./wait-resume.ts";
import { reviewLifecycleCallbacks } from "./session-review-lifecycle.ts";
import { sessionHostLogFields } from "./session-host-identity.ts";
import { serverLogger } from "./logging.ts";
import { getHarness } from "./harness/index.ts";
import { getLiveEditCoordinator } from "./live-edit-runtime.ts";
import { RunMutationCoordination } from "./mutation-coordination.ts";

const log = serverLogger.child("session-host");

function runtimeIdentity(host: SessionHost) {
  return host.workItemId ? {
    workItemId: host.workItemId, runKey: host.runKey, runKind: host.runKind,
    parentRunKey: host.parentRunKey, taskId: host.taskId,
  } : null;
}

/** Build the MCP agent context for a session run. */
export function buildAgentContext(
  host: SessionHost,
  opts: StartSessionOptions,
  deps: SessionHostDeps,
): AgentTypeContext {
  const ctx: AgentTypeContext = {
    sessionKey: host.id,
    workItemId: host.workItemId,
    runKey: host.runKey,
    taskId: host.taskId,
    cwd: host.cwd,
    bus: deps.bus,
    worktreeInfo: host.worktree,
    worktreeIsolation: host.worktreeIsolation,
    forEachLeaderTaskState: deps.forEachLeaderTaskState,
    getSessionRuntime: deps.getSessionRuntime,
    startMinionSession: (params) => {
      const isResume = params.sessionKey === host.id;
      if (isResume && host.workItemId && host.runKind === "child" && deps.continueWorkItemChild) {
        return Promise.resolve(deps.continueWorkItemChild({ workItemId: host.workItemId,
          runKey: host.runKey, prompt: params.prompt,
          requestId: `continue:${host.runKey}:${randomUUID()}` })).then(() => ({
            sessionKey: host.runKey, harness: host.harnessName, model: host.model ?? "",
            permissionMode: host.permissionMode ?? "auto",
          }));
      }
      if (!isResume && host.workItemId && params.taskId && deps.startWorkItemChildRun) {
        return deps.startWorkItemChildRun({
          workItemId: host.workItemId, parentRunKey: host.runKey, taskId: params.taskId,
          requestId: `child:${host.runKey}:${params.taskId}`, prompt: params.prompt,
          cwd: params.cwd, systemPrompt: params.systemPrompt,
          ...(params.model ? { model: params.model } : {}),
          ...(params.harness ? { harness: params.harness } : {}),
          ...(params.thinkingConfig ? { thinkingConfig: params.thinkingConfig } : {}),
          ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
          ...(params.executorClass ? { executorClass: params.executorClass } : {}),
          ...(params.skillIds ? { skillIds: params.skillIds } : {}),
          ...(params.onAllocated ? { onAllocated: params.onAllocated } : {}),
        });
      }
      return deps.startChildSession({
      sessionKey: params.sessionKey,
      invocationKind: params.invocationKind
        ?? (params.sessionKey === host.id ? "resume_open_run" : "new_run"),
      prompt: params.prompt,
      ...(host.workItemId ? { workItemId: host.workItemId } : {}),
      runKind: isResume ? host.runKind : "child",
      parentRunKey: isResume ? host.parentRunKey : host.runKey,
      taskId: isResume ? host.taskId : (params.taskId ?? null),
      cwd: params.cwd,
      systemPrompt: params.systemPrompt,
      role: "minion",
      worktreeIsolation: false,
      parentWorktree: host.worktree ?? undefined,
      initialModel: params.model ?? null,
      thinkingConfig: params.thinkingConfig ?? undefined,
      resumeId: params.sessionKey === host.id ? host.sessionId ?? undefined : undefined,
      harness: params.harness ?? host.harnessName,
      permissionMode: params.permissionMode,
      executorClass: params.executorClass,
      skillIds: params.skillIds,
      });
    },
    scheduleWaitContinue: (durationMs, reason) => {
      host.clearWaitTimer();
      log.debug("wait_scheduled", { ...sessionHostLogFields(host), durationMs, reason });
      host.waitTimerId = setTimeout(() => {
        host.waitTimerId = null;
        requestWaitResume(host, deps, {
          completedReason: reason,
          opts: {
            sessionKey: host.id,
            invocationKind: "resume_open_run",
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
      const identity = runtimeIdentity(host);
      if (identity) deps.workItemLifecycle?.runWaiting({ ...identity, waitKind: "timer", at: Date.now() });
      return host.waitTimerId;
    },
    terminateSession: deps.terminateSession,
    messageSession: (sessionKey, message) =>
      injectSessionMessage(deps, sessionKey, message),
    wakeWaitingLeaderIfAllChildrenTerminal: deps.wakeWaitingLeaderIfAllChildrenTerminal,
    cleanupLiveEditRun: deps.cleanupLiveEditRun,
    getRenderComponents: () => host.renderState?.components ?? [],
    ...reviewLifecycleCallbacks(host, deps.bus),
  };
  if (host.workItemId && !host.worktreeIsolation
    && getHarness(host.harnessName).capabilities.mutationInterception === "complete") {
    ctx.mutationCoordination = new RunMutationCoordination(
      getLiveEditCoordinator(host.cwd), host.cwd, host.workItemId, host.runKey);
  }
  const markDecisionNeeded = ctx.markDecisionNeeded;
  ctx.markDecisionNeeded = (reason) => {
    markDecisionNeeded?.(reason);
    const identity = runtimeIdentity(host);
    if (identity) deps.workItemLifecycle?.runWaiting({ ...identity, waitKind: "decision", at: Date.now() });
  };
  if (host.taskState) ctx.existingTaskState = host.taskState;
  if (host.renderState) ctx.existingRenderState = host.renderState;
  if (host.skillIds.length > 0) ctx.skillIds = host.skillIds;
  if (Object.keys(host.skillValues).length > 0) ctx.skillValues = host.skillValues;
  if (opts.parentWorktree) ctx.parentWorktree = opts.parentWorktree;
  return ctx;
}
