import type {
  SessionHost,
  SessionHostDeps,
  StartSessionOptions,
} from "./session-host.ts";
import { persistTaskState } from "./session-persist.ts";
import {
  cancelCoalescedWake,
  requestCoalescedWake,
} from "./wake-coalescer.ts";
import { serverLogger } from "./logging.ts";

const log = serverLogger.child("wait-resume");

export interface WaitResumeRequest {
  opts: StartSessionOptions;
  completedReason: string;
  immediate?: boolean;
  onDelivered?: () => void;
  idempotencyKey?: string;
}

const queuedWaitResumes = new WeakMap<SessionHost, WaitResumeRequest>();

export function getQueuedWaitResume(host: SessionHost): WaitResumeRequest | null {
  return queuedWaitResumes.get(host) ?? null;
}

export function cancelQueuedWaitResume(host: SessionHost): void {
  queuedWaitResumes.delete(host);
  cancelCoalescedWake(host);
}

export function pauseActiveRunForWait(host: SessionHost): void {
  const timer = setTimeout(() => {
    if (host.status !== "running" || !host.taskState?.pendingWait) return;
    const control = host.runControl;
    if (!control) return;
    try {
      if (control.interrupt) void control.interrupt().catch((err: unknown) => {
        log.warn("interrupt_failed", { sessionKey: host.id, error: err });
      });
      else control.abort();
    } catch (err) {
      log.warn("pause_failed", { sessionKey: host.id, error: err });
    }
  }, 0);
  timer.unref?.();
}

export function requestWaitResume(
  host: SessionHost,
  deps: SessionHostDeps,
  request: WaitResumeRequest,
): boolean {
  const continuation: WaitResumeRequest = {
    ...request,
    opts: { ...request.opts, invocationKind: "resume_open_run" },
  };
  if (host.status === "running") {
    host.clearWaitTimer();
    if (!queuedWaitResumes.has(host)) queuedWaitResumes.set(host, continuation);
    if (host.taskState) persistTaskState(host.id, host.taskState);
    return false;
  }
  return completeWaitAndResume(host, deps, continuation);
}

export function drainQueuedWaitResume(
  host: SessionHost,
  deps: SessionHostDeps,
): boolean {
  if (host.status !== "idle") return false;
  const request = queuedWaitResumes.get(host);
  if (!request) return false;
  queuedWaitResumes.delete(host);
  return completeWaitAndResume(host, deps, {
    ...request,
    immediate: request.immediate ?? true,
  });
}

function completeWaitAndResume(
  host: SessionHost,
  deps: SessionHostDeps,
  request: WaitResumeRequest,
): boolean {
  host.clearWaitTimer();
  const pendingWait = host.taskState?.pendingWait ?? null;
  return requestCoalescedWake(host, deps, {
    opts: request.opts,
    ...(request.immediate === undefined ? {} : { immediate: request.immediate }),
    allowStopped: true,
    idempotencyKey: request.idempotencyKey
      ?? (pendingWait ? `wait:${host.id}:${pendingWait.scheduledAt}` : undefined),
    onDelivered: () => {
      if (host.taskState?.pendingWait) {
        host.taskState.pendingWait = null;
        persistTaskState(host.id, host.taskState);
      }
      deps.bus.emitToSession(host.id, {
        type: "wait_state",
        sessionKey: host.id,
        action: "completed",
        reason: request.completedReason,
        timestamp: Date.now(),
      });
      request.onDelivered?.();
    },
  });
}
