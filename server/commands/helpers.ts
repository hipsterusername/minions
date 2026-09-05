/**
 * Shared helpers for WebSocket command handlers.
 *
 * Cross-command behavior lives here so each per-command file stays focused.
 */

import type { WebSocket } from "ws";
import { unicastToSession, unicastGlobal, type BusPayload } from "../bus.ts";
import type { SessionHost } from "../session-host.ts";
import type { Bus } from "../bus.ts";
import type { SessionRegistry } from "../session-registry.ts";
import type { BufferedEvent } from "../session-host.ts";
import { mergeAndCleanup, type MergeResult } from "../worktree.ts";
import { persistTaskState } from "../session-persist.ts";
import {
  evaluateMergeGates,
  type MergeGateVerdict,
  shouldEvaluateMergeGates,
  shouldWarnForMergeGates,
} from "../system-model/gates.ts";
import {
  worktreeBusyReason,
  beginWorktreeOperation,
  type WorktreeOperationLease,
} from "./worktree-operation-lock.ts";

/** Options bag accepted by mergeAndCleanup. Inlined here because worktree.ts
 *  does not export the shape directly. */
export interface MergeOptions {
  force?: boolean;
  strategy?: "ours" | "theirs";
  rebase?: boolean;
}
import type { CommandContext, WsCommand } from "./types.ts";

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
  data?: Record<string, unknown>,
): void {
  unicastToSession(ws, sessionKey, {
    type: "control_response",
    command,
    sessionKey,
    requestId: requestId ?? null,
    success: false,
    error,
    ...data,
  });
}

/** Stringify any caught error for a control_response payload. */
export function errToMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Emit the standard "not supported by harness" control_response error.
 * Called when `host.runControl[fn]` is absent, indicating the harness
 * does not implement the requested operation.
 *
 * Error message format: `"<command>" is not supported by harness "<name>".`
 * (quotes around command and harness name, ending with a period).
 */
export function unsupportedByHarness(
  ws: WebSocket,
  command: string,
  host: SessionHost,
  requestId: string | undefined,
): void {
  sendControlError(
    ws,
    command,
    host.id,
    requestId,
    `"${command}" is not supported by harness "${host.harnessName}".`,
  );
}

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
  if (host.workItemId) {
    sendControlError(ws, command, host.id, cmd.requestId,
      "Canonical work-item contributions must use review and the lineage integration queue");
    return;
  }
  const lease = beginWorktreeOperation(host, command);
  if (!lease) {
    sendControlError(
      ws,
      command,
      host.id,
      cmd.requestId,
      `Worktree operation "${worktreeBusyReason(host) ?? "unknown"}" is already in progress`,
    );
    return;
  }
  const gateVerdict = shouldEvaluateMergeGates(host) ? evaluateMergeGates(host) : null;
  if (!gateVerdict) {
    continueMergeFlow(bus, host, ws, command, cmd, lease, options);
    return;
  }

  void gateVerdict
    .then((verdict) => {
      if (shouldWarnForMergeGates(verdict)) {
        bus.emitToSession(host.id, {
          type: "merge_gate_warning",
          sessionKey: host.id,
          verdict,
          timestamp: Date.now(),
        });
      }
      if (blockForMergeGates(bus, host.id, ws, command, cmd.requestId, verdict)) {
        lease.release();
        return;
      }
      continueMergeFlow(bus, host, ws, command, cmd, lease, options);
    })
    .catch((err: unknown) => {
      lease.release();
      sendControlError(ws, command, cmd.sessionKey!, cmd.requestId, errToMessage(err));
    });
}

export function blockForMergeGates(
  bus: Bus,
  sessionKey: string,
  ws: WebSocket,
  command: string,
  requestId: string | undefined,
  verdict: MergeGateVerdict,
): boolean {
  if (verdict.mode !== "enforced" || verdict.allowed) return false;
  bus.emitToSession(sessionKey, {
    type: "merge_blocked_by_gate",
    sessionKey,
    verdict,
    timestamp: Date.now(),
  });
  sendControlError(ws, command, sessionKey, requestId, "Merge blocked by system-model gate", {
    verdict,
  });
  return true;
}

function continueMergeFlow(
  bus: Bus,
  host: SessionHost,
  ws: WebSocket,
  command: string,
  cmd: WsCommand,
  lease: WorktreeOperationLease,
  options?: MergeOptions,
): void {
  const projectPath = host.worktree!.projectPath;

  // Abort + clear any pending wait before we delete the worktree under
  // the agent's feet.
  if (host.status === "running") host.abortController.abort();
  host.clearWaitTimer();

  mergeWithCurrentGates(host, options)
    .then((result: MergeResult) => {
      if (result.success) {
        if (host.taskState?.approval) host.taskState.approval = null;
        if (host.taskState) persistTaskState(host.id, host.taskState);
        host.worktree = null;
        host.cwd = projectPath;
        host.status = "completed";
        host.persist();

        const completedEvent: BufferedEvent = {
          type: "session_status",
          sessionKey: cmd.sessionKey!,
          status: "completed",
          timestamp: Date.now(),
        };
        host.bufferEvent(completedEvent);
        bus.emitToSession(cmd.sessionKey!, completedEvent as BusPayload);
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
    })
    .finally(() => lease.release());
}

export function mergeWithCurrentGates(host: SessionHost, options?: MergeOptions): Promise<MergeResult> {
  return mergeAndCleanup(host.worktree!, undefined, shouldEvaluateMergeGates(host) ? {
    ...options, validateResult: async () => {
      const verdict = await evaluateMergeGates(host);
      return verdict.mode !== "enforced" || verdict.allowed;
    },
  } : options);
}
