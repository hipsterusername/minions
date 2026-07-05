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

export interface WaitResumeRequest {
  opts: StartSessionOptions;
  completedReason: string;
  immediate?: boolean;
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
        console.warn(`[wait] Failed to interrupt ${host.id}:`, err);
      });
      else control.abort();
    } catch (err) {
      console.warn(`[wait] Failed to pause ${host.id}:`, err);
    }
  }, 0);
  timer.unref?.();
}

export function requestWaitResume(
  host: SessionHost,
  deps: SessionHostDeps,
  request: WaitResumeRequest,
): boolean {
  if (host.status === "running") {
    host.clearWaitTimer();
    if (!queuedWaitResumes.has(host)) queuedWaitResumes.set(host, request);
    if (host.taskState) persistTaskState(host.id, host.taskState);
    return false;
  }
  return completeWaitAndResume(host, deps, request);
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
  return requestCoalescedWake(host, deps, {
    opts: request.opts,
    ...(request.immediate === undefined ? {} : { immediate: request.immediate }),
  });
}
