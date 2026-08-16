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

const queuedWaitResumes = new WeakMap<SessionHost, WaitResumeRequest[]>();

export function getQueuedWaitResume(host: SessionHost): WaitResumeRequest | null {
  const requests = queuedWaitResumes.get(host);
  return requests?.length ? mergeWaitResumes(requests) : null;
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
    const queued = queuedWaitResumes.get(host) ?? [];
    if (!continuation.idempotencyKey
      || !queued.some((candidate) => candidate.idempotencyKey === continuation.idempotencyKey)) {
      queued.push(continuation);
      queuedWaitResumes.set(host, queued);
    }
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
  const requests = queuedWaitResumes.get(host);
  if (!requests?.length) return false;
  queuedWaitResumes.delete(host);
  const merged = mergeWaitResumes(requests);
  return completeWaitAndResume(host, deps, {
    ...merged,
    immediate: merged.immediate ?? true,
  });
}

function mergeWaitResumes(requests: WaitResumeRequest[]): WaitResumeRequest {
  const first = requests[0]!;
  if (requests.length === 1) return first;
  const keys = [...new Set(requests
    .map((request) => request.idempotencyKey).filter((key): key is string => !!key))].sort();
  return {
    ...first,
    immediate: requests.some((request) => request.immediate === true) ? true
      : requests.every((request) => request.immediate === false) ? false : undefined,
    idempotencyKey: keys.length ? keys.join("\n") : undefined,
    completedReason: "Multiple queued continuations were delivered.",
    opts: {
      ...first.opts,
      prompt: [
        "Multiple wake events occurred for this leader session. Review each event and continue orchestrating.",
        "",
        ...requests.flatMap((request, index) => [
          `Wake event ${index + 1}:`, request.opts.prompt, "",
        ]),
      ].join("\n").trim(),
    },
    onDelivered: () => {
      for (const request of requests) {
        try {
          request.onDelivered?.();
        } catch (error) {
          log.warn("queued_wait_delivery_checkpoint_failed", { error });
        }
      }
    },
  };
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
