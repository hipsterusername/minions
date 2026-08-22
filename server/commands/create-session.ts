/**
 * create_session — open a new Claude session and register it.
 *
 * Validates cwd against the path-guard, honours MAX_SESSIONS, and hands the
 * heavy lifting (SDK query open, worktree provisioning, event fan-out) off
 * to `SessionRegistry.start()`. Replies with a `session_created` envelope.
 *
 * Rejection routing: when the client supplies a `sessionKey` the rejection
 * goes out as a session-scoped `session_error` so the LeaderNode reducer
 * (which only wires up `session_error` → `status: "error"`) actually
 * surfaces it to the user. Without this the UI sticks at `creating`
 * forever because `unicastGlobal({type: "error", ...})` is dropped by the
 * session-stream reducer.
 */

import { unicastGlobal, unicastToSession } from "../bus.ts";
import { validateOwnedSessionCwd } from "../path-guard.ts";
import { isValidThinkingConfig, type ThinkingConfig } from "../session-host.ts";
import { registeredHarnessNames } from "../harness/index.ts";
import { sanitizeAttachments } from "./attachment-sanitize.ts";
import type { CommandContext, CommandHandler } from "./types.ts";
import type { WebSocket } from "ws";
import { SessionLaunchError } from "../session-launch.ts";
import { SessionCapacityError } from "../session-registry.ts";
import { listMcpServers, resolveClaudeMcpServers } from "../mcp-server-store.ts";
import { resolveWorkspace } from "../workspace-registry.ts";

const SAFE_SESSION_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Send a rejection back to the right scope based on whether we have a sessionKey. */
function rejectCreate(
  ws: WebSocket,
  sessionKey: string | undefined,
  message: string,
  details: Record<string, unknown> = {},
): void {
  if (sessionKey) {
    unicastToSession(ws, sessionKey, {
      type: "session_error",
      sessionKey,
      error: message,
      ...details,
      timestamp: Date.now(),
    });
    return;
  }
  unicastGlobal(ws, { type: "error", message });
}

export const createSession: CommandHandler = async (
  ctx: CommandContext,
  cmd,
  ws,
) => {
  const key = cmd.sessionKey ?? ctx.generateKey();
  let canonicalConfig: { workspaceId: string; projectPath: string;
    changeMode: "live" | "worktree" } | null = null;
  const resolveRegisteredWorkspace = ctx.resolveWorkspace ?? resolveWorkspace;
  const requestedWorkspace = cmd.workspaceId ? resolveRegisteredWorkspace(cmd.workspaceId) : null;
  if (cmd.workspaceId && !requestedWorkspace) {
    rejectCreate(ws, key, "Workspace is not registered", { code: "WORKSPACE_NOT_REGISTERED" });
    return;
  }
  if (requestedWorkspace && cmd.cwd !== undefined) {
    rejectCreate(ws, key, "Workspace launches cannot include cwd", {
      code: "WORKSPACE_CONFIGURATION_MISMATCH",
      guidance: "Omit cwd; it is resolved from workspaceId.",
    });
    return;
  }

  // Session keys become worktree directory and branch-name components. Keep
  // them to one bounded, traversal-free segment before they reach lifecycle
  // code or persistent storage.
  if (!SAFE_SESSION_KEY.test(key)) {
    rejectCreate(ws, cmd.sessionKey, "Invalid session key");
    return;
  }

  if (cmd.workItemId) {
    if (!ctx.workItems) {
      rejectCreate(ws, key, "Canonical work-item service is unavailable", {
        code: "WORK_ITEM_SERVICE_UNAVAILABLE",
        workItemId: cmd.workItemId,
      });
      return;
    }
    try {
      const detail = await ctx.workItems.get(cmd.workItemId);
      const run = detail?.currentRun;
      const registered = ctx.registry.get(key);
      const registeredMatches = !registered
        || (registered.workItemId === cmd.workItemId
          && registered.runKey === key
          && registered.runKind === "primary");
      const valid = detail?.workItem.currentRunKey === key
        && run?.runKey === key
        && run.runKind === "primary"
        && run.outcome === "none"
        && run.endedAt === null
        && registeredMatches;
      if (!valid) {
        rejectCreate(ws, key, "Session key is not the current preallocated open run for this work item", {
          code: "WORK_ITEM_RUN_MISMATCH",
          workItemId: cmd.workItemId,
          currentRunKey: detail?.workItem.currentRunKey ?? null,
          guidance: "Use start_work_item_run to allocate a new run.",
        });
        return;
      }
      const workItemWorkspace = resolveRegisteredWorkspace(detail!.workItem.projectId);
      if (!workItemWorkspace) {
        rejectCreate(ws, key, "Work item workspace is not registered", {
          code: "WORKSPACE_NOT_REGISTERED", workItemId: cmd.workItemId,
        });
        return;
      }
      canonicalConfig = {
        workspaceId: workItemWorkspace.id,
        projectPath: workItemWorkspace.sourceRoot,
        changeMode: detail!.workItem.lifecycle.changeMode,
      };
      if (cmd.cwd !== undefined
        || (cmd.workspaceId !== undefined && cmd.workspaceId !== canonicalConfig.workspaceId)
        || (cmd.role !== undefined && cmd.role !== "leader")
        || (cmd.worktreeIsolation !== undefined
          && cmd.worktreeIsolation !== (canonicalConfig.changeMode === "worktree"))) {
        rejectCreate(ws, key, "Session configuration does not match its canonical work item", {
          code: "WORK_ITEM_CONFIGURATION_MISMATCH", workItemId: cmd.workItemId,
          guidance: "Omit cwd, workspaceId, role, and worktreeIsolation; they are derived from the work item.",
        });
        return;
      }
    } catch {
      rejectCreate(ws, key, "Unable to verify canonical work-item run", {
        code: "WORK_ITEM_LOOKUP_FAILED",
        workItemId: cmd.workItemId,
      });
      return;
    }
  }

  // create_session is frequently sent from UI effects. Treat a repeated key
  // as an idempotent acknowledgement instead of re-entering SessionHost.start(),
  // which would open another SDK query for the same logical session.
  if (cmd.sessionKey && ctx.registry.get(key)) {
    unicastToSession(ws, key, { type: "session_created", sessionKey: key });
    return;
  }

  if (ctx.registry.capacityCount() >= ctx.maxSessions) {
    rejectCreate(
      ws,
      cmd.sessionKey,
      `Maximum session limit (${ctx.maxSessions}) reached. Remove unused sessions first.`,
    );
    return;
  }
  const rawCwd = canonicalConfig?.projectPath
    ?? requestedWorkspace?.sourceRoot
    ?? cmd.cwd
    ?? process.cwd();
  const activeWorktreePaths = Array.from(ctx.registry.values())
    .map((host) => host.worktree)
    .filter((worktree) => worktree?.lifecycle === "active")
    .map((worktree) => worktree!.path);
  const cwd = validateOwnedSessionCwd(rawCwd, activeWorktreePaths);
  if (!cwd) {
    rejectCreate(ws, key, "Invalid cwd: must be a registered project or active session worktree");
    return;
  }
  const prompt = cmd.prompt ?? "Hello";
  const initialThinking: ThinkingConfig | null = isValidThinkingConfig(
    cmd.thinkingConfig,
  )
    ? cmd.thinkingConfig
    : null;
  const attachments = sanitizeAttachments(cmd.attachments);
  // Validate harness up front so an unknown name surfaces as a session-scoped
  // session_error rather than crashing the SDK loop later. Empty / undefined
  // means "use the SessionHost default" (claude).
  if (cmd.harness !== undefined && cmd.harness !== "") {
    const known = registeredHarnessNames();
    if (!known.includes(cmd.harness)) {
      rejectCreate(
        ws,
        key,
        `Unknown harness "${cmd.harness}". Registered harnesses: ${
          known.join(", ") || "(none registered)"
        }.`,
      );
      return;
    }
  }
  const persistedMcp = listMcpServers(
    canonicalConfig?.projectPath ?? requestedWorkspace?.sourceRoot ?? cwd,
  ).entries;
  const claudeMcp =
    persistedMcp.length > 0 && (cmd.harness === undefined || cmd.harness === "claude")
      ? resolveClaudeMcpServers(persistedMcp)
      : null;
  const options = {
    sessionKey: key,
    invocationKind: "new_run" as const,
    ...(cmd.workItemId ? { workItemId: cmd.workItemId } : {}),
    ...(cmd.workItemId
      ? { runKind: "primary" as const, parentRunKey: null, taskId: null }
      : {}),
    prompt,
    cwd,
    systemPrompt: cmd.systemPrompt,
    role: canonicalConfig ? "leader" : cmd.role,
    ...(cmd.skillIds ? { skillIds: cmd.skillIds } : {}),
    ...(cmd.skillValues ? { skillValues: cmd.skillValues } : {}),
    worktreeIsolation: canonicalConfig
      ? canonicalConfig.changeMode === "worktree"
      : cmd.worktreeIsolation,
    initialModel: cmd.model ?? null,
    thinkingConfig: initialThinking,
    ...(attachments ? { attachments } : {}),
    ...(cmd.harness ? { harness: cmd.harness } : {}),
    ...(cmd.permissionMode ? { permissionMode: cmd.permissionMode } : {}),
    ...(cmd.sandboxPolicy ? { sandboxPolicy: cmd.sandboxPolicy } : {}),
    ...(claudeMcp && Object.keys(claudeMcp.servers).length > 0
      ? {
          externalMcpServers: claudeMcp.servers,
          externalMcpToolNames: claudeMcp.allowedTools,
        }
      : {}),
  };
  try {
    await ctx.launchSession(options);
  } catch (error) {
    if (error instanceof SessionCapacityError) {
      rejectCreate(ws, key, error.message, { code: error.code });
      return;
    }
    if (error instanceof SessionLaunchError) {
      rejectCreate(ws, key, error.message, { code: error.code, readiness: error.readiness });
      return;
    }
    rejectCreate(ws, key, error instanceof Error ? error.message : "Session launch failed");
    return;
  }
  ctx.bus.emitGlobal({ type: "session_list", sessions: ctx.registry.snapshot() });
  unicastToSession(ws, key, { type: "session_created", sessionKey: key });
};
