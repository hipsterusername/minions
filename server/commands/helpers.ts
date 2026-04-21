/**
 * Shared helpers for WebSocket command handlers.
 *
 * Extracted from `server/index.ts` in Phase 5.2. Anything that appeared in
 * more than one case of the original switch statement lives here so each
 * per-command file stays tiny.
 */

import type { WebSocket } from "ws";
import { unicastToSession, unicastGlobal } from "../bus.ts";
import type { SessionHost } from "../session-host.ts";
import type { Bus } from "../bus.ts";
import type { SessionRegistry } from "../session-registry.ts";
import type { BufferedEvent } from "../session-host.ts";
import { mergeAndCleanup, type MergeResult } from "../worktree.ts";

/** Options bag accepted by mergeAndCleanup. Inlined here because worktree.ts
 *  does not export the shape directly. */
export interface MergeOptions {
  force?: boolean;
  strategy?: "ours" | "theirs";
  rebase?: boolean;
}
import type { CommandContext, WsCommand } from "./types.ts";

// ── Session lookup helpers ────────────────────────────────

/**
 * Fetch a session host or emit a client-visible error. Returns null when the
 * session is missing, letting callers early-return cleanly.
 */
export function getSessionOrError(
  registry: SessionRegistry,
  sessionKey: string | undefined,
  ws: WebSocket,
): SessionHost | null {
  if (!sessionKey) {
    unicastGlobal(ws, { type: "error", message: "sessionKey required" });
    return null;
  }
  const session = registry.get(sessionKey);
  if (!session) {
    unicastToSession(ws, sessionKey, {
      type: "error",
      message: `Session ${sessionKey} not found`,
    });
    return null;
  }
  return session;
}

// ── control_response helpers ──────────────────────────────

/** Emit a success `control_response` back to the originating socket. */
export function sendControlResponse(
  ws: WebSocket,
  command: string,
  sessionKey: string,
  requestId: string | undefined,
  data?: Record<string, unknown>,
): void {
  unicastToSession(ws, sessionKey, {
    type: "control_response",
    command,
    sessionKey,
    requestId: requestId ?? null,
    success: true,
    ...data,
  });
}

/** Emit a failure `control_response` back to the originating socket. */
export function sendControlError(
  ws: WebSocket,
  command: string,
  sessionKey: string,
  requestId: string | undefined,
  error: string,
): void {
  unicastToSession(ws, sessionKey, {
    type: "control_response",
    command,
    sessionKey,
    requestId: requestId ?? null,
    success: false,
    error,
  });
}

/** Stringify any caught error for a control_response payload. */
export function errToMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── queryHandle delegation pattern ────────────────────────

/**
 * The dominant shape among info/mcp/query commands is: lookup the session,
 * assert `queryHandle` exists, call a method on it, then forward the
 * resolution to a control_response. This helper collapses that boilerplate.
 */
export function runQueryOp<T>(
  ctx: CommandContext,
  cmd: WsCommand,
  ws: WebSocket,
  command: string,
  invoke: (host: SessionHost) => Promise<T> | null,
  toPayload?: (value: T) => Record<string, unknown>,
): void {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  const promise = invoke(host);
  if (!promise) {
    sendControlError(ws, command, cmd.sessionKey!, cmd.requestId, "No active query");
    return;
  }
  promise
    .then((value) => {
      const data = toPayload ? toPayload(value) : undefined;
      sendControlResponse(ws, command, cmd.sessionKey!, cmd.requestId, data);
    })
    .catch((err: unknown) => {
      sendControlError(ws, command, cmd.sessionKey!, cmd.requestId, errToMessage(err));
    });
}

// ── Merge flow helper (approve/force/theirs/retry all share this) ─

/**
 * Shared merge/cleanup flow for approve_changes, force_merge, theirs_merge,
 * and retry_merge. All four commands:
 *   1. Abort the agent + clear the wait timer
 *   2. Call mergeAndCleanup with the strategy-specific options
 *   3. On success: mark session completed, emit worktree_merged +
 *      approval_resolved + session_completed, clear worktree
 *   4. On failure: emit worktree_merge_failed (approval state preserved)
 *   5. Either way: reply with a control_response carrying the result
 */
export function runMergeFlow(
  bus: Bus,
  host: SessionHost,
  ws: WebSocket,
  command: string,
  cmd: WsCommand,
  options?: MergeOptions,
): void {
  const projectPath = host.worktree!.projectPath;

  // Abort + clear any pending wait before we delete the worktree under
  // the agent's feet.
  if (host.status === "running") host.abortController.abort();
  host.clearWaitTimer();

  mergeAndCleanup(host.worktree!, undefined, options)
    .then((result: MergeResult) => {
      if (result.success) {
        if (host.taskState?.approval) host.taskState.approval = null;
        host.worktree = null;
        host.cwd = projectPath;
        host.status = "completed";

        const completedEvent: BufferedEvent = {
          type: "session_status",
          sessionKey: cmd.sessionKey!,
          status: "completed",
          timestamp: Date.now(),
        };
        host.bufferEvent(completedEvent);
        bus.emitToSession(cmd.sessionKey!, completedEvent);
        bus.emitToSession(cmd.sessionKey!, {
          type: "worktree_merged",
          sessionKey: cmd.sessionKey,
          result,
          cleaned: true,
          approved: true,
          timestamp: Date.now(),
        });
        bus.emitToSession(cmd.sessionKey!, {
          type: "approval_resolved",
          sessionKey: cmd.sessionKey,
          action: "approved",
          timestamp: Date.now(),
        });
        bus.emitToSession(cmd.sessionKey!, {
          type: "session_completed",
          sessionKey: cmd.sessionKey,
          reason: "merged",
          timestamp: Date.now(),
        });
      } else {
        bus.emitToSession(cmd.sessionKey!, {
          type: "worktree_merge_failed",
          sessionKey: cmd.sessionKey,
          result,
          timestamp: Date.now(),
        });
      }
      sendControlResponse(ws, command, cmd.sessionKey!, cmd.requestId, { result });
    })
    .catch((err: unknown) => {
      sendControlError(ws, command, cmd.sessionKey!, cmd.requestId, errToMessage(err));
    });
}
