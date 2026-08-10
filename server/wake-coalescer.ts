import { createHash } from "node:crypto";
import type {
  SessionHost,
  SessionHostDeps,
  StartSessionOptions,
} from "./session-host.ts";
import { serverLogger } from "./logging.ts";
import type { TaskRecord } from "./task-tools.ts";
import { isTerminalTaskStatus } from "./task-lifecycle.ts";

export const WAKE_COALESCE_WINDOW_MS = 15_000;
export const MIN_WAKE_RESUME_INTERVAL_MS = 15_000;
export const WAKE_DIGEST_EXCERPT_CHARS = 300;

const TRUNCATION_MARKER = "…[truncated]";
const log = serverLogger.child("wake-coalescer");

export interface CoalescedWakeRequest {
  opts: StartSessionOptions;
  /** Skip the coalescing window, but still obey the minimum resume interval. */
  immediate?: boolean;
  /** A recovered durable wait is authorized to resume a stopped host. */
  allowStopped?: boolean;
  /** Runs only after the continuation dispatch succeeds. */
  onDelivered?: () => void;
  /** Stable identity used to deduplicate canonical dispatch across recovery. */
  idempotencyKey?: string;
}

interface PendingWake {
  requests: CoalescedWakeRequest[];
  timer: ReturnType<typeof setTimeout>;
  dueAt: number;
}

const pendingWakes = new WeakMap<SessionHost, PendingWake>();
const lastResumeAt = new WeakMap<SessionHost, number>();

export function isWakeWorthyStatus(status: TaskRecord["status"]): boolean {
  return status === "blocked" || isTerminalTaskStatus(status);
}

export function capWakeExcerpt(text: string | null | undefined): string {
  const value = text ?? "";
  if (value.length <= WAKE_DIGEST_EXCERPT_CHARS) return value;
  return `${value.slice(0, WAKE_DIGEST_EXCERPT_CHARS)}${TRUNCATION_MARKER}`;
}

export function buildWakeTaskDigest(tasks: TaskRecord[], sinceMs?: number): string {
  return tasks
    .filter((t) => {
      if (t.status === "blocked") return true;
      return (
        isTerminalTaskStatus(t.status) &&
        (sinceMs == null || (t.completedAt != null && t.completedAt >= sinceMs))
      );
    })
    .map((t) =>
      t.status === "blocked"
        ? `${t.taskId} — blocked — ${capWakeExcerpt(t.lastStep)}`
        : `${t.taskId} — ${t.status} — ${capWakeExcerpt(t.result)}`,
    )
    .join("\n");
}

export function requestCoalescedWake(
  host: SessionHost,
  deps: SessionHostDeps,
  request: CoalescedWakeRequest,
): boolean {
  const now = Date.now();
  const existing = pendingWakes.get(host);
  if (existing) {
    existing.requests.push(request);
    const dueAt = nextDueAt(host, now, request.immediate === true);
    if (dueAt < existing.dueAt) {
      clearTimeout(existing.timer);
      existing.timer = schedule(host, deps, dueAt - now);
      existing.dueAt = dueAt;
    }
    return false;
  }

  const dueAt = nextDueAt(host, now, request.immediate === true);
  if (dueAt <= now) {
    deliverWake(host, deps, [request]);
    return true;
  }

  pendingWakes.set(host, {
    requests: [request],
    timer: schedule(host, deps, dueAt - now),
    dueAt,
  });
  return false;
}

export function cancelCoalescedWake(host: SessionHost): void {
  const pending = pendingWakes.get(host);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingWakes.delete(host);
}

function nextDueAt(host: SessionHost, now: number, immediate: boolean): number {
  const lastResume = lastResumeAt.get(host);
  const floorUntil = lastResume == null ? now : lastResume + MIN_WAKE_RESUME_INTERVAL_MS;
  const coalesceUntil = immediate ? now : now + WAKE_COALESCE_WINDOW_MS;
  return Math.max(floorUntil, coalesceUntil);
}

function schedule(
  host: SessionHost,
  deps: SessionHostDeps,
  delayMs: number,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => flushWake(host, deps), Math.max(0, delayMs));
  timer.unref?.();
  return timer;
}

function flushWake(host: SessionHost, deps: SessionHostDeps): void {
  const pending = pendingWakes.get(host);
  if (!pending) return;
  pendingWakes.delete(host);

  if (host.abortController.signal.aborted) return;
  if (host.status === "stopped" && !pending.requests.some((request) => request.allowStopped)) return;
  if (host.status === "running" || host.runControl !== null || host.eventStream !== null) {
    const now = Date.now();
    pendingWakes.set(host, {
      requests: pending.requests,
      timer: schedule(host, deps, MIN_WAKE_RESUME_INTERVAL_MS),
      dueAt: now + MIN_WAKE_RESUME_INTERVAL_MS,
    });
    return;
  }

  deliverWake(host, deps, pending.requests);
}

function deliverWake(
  host: SessionHost,
  deps: SessionHostDeps,
  requests: CoalescedWakeRequest[],
): void {
  lastResumeAt.set(host, Date.now());
  const [first, ...rest] = requests;
  if (!first) return;
  const prompt =
    rest.length === 0
      ? first.opts.prompt
      : [
          "Multiple wake events occurred for this leader session. Review each event and continue orchestrating.",
          "",
          ...requests.flatMap((request, index) => [
            `Wake event ${index + 1}:`,
            request.opts.prompt,
            "",
          ]),
        ].join("\n").trim();

  if (host.workItemId && host.runKind === "primary" && deps.resumeWorkItemRun) {
    const workItemId = host.workItemId;
    try {
      const stableKeys = [...new Set(
        requests.map((request) => request.idempotencyKey).filter((key): key is string => !!key),
      )].sort();
      const identity = stableKeys.length > 0 ? stableKeys.join("\n") : prompt;
      const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
      const resume = deps.resumeWorkItemRun({ workItemId, runKey: host.runKey,
        prompt, requestId: `wake:${host.runKey}:${digest}` });
      void Promise.resolve(resume).then(() => markDelivered(requests), (error: unknown) => {
        log.warn("work_item_resume_failed", {
          sessionKey: host.id,
          workItemId,
          runKey: host.runKey,
          error,
        });
        retryDelivery(host, deps, requests);
      });
    } catch (error) {
      log.warn("work_item_resume_failed", {
        sessionKey: host.id,
        workItemId,
        runKey: host.runKey,
        error,
      });
      retryDelivery(host, deps, requests);
    }
    return;
  }
  try {
    deps.startChildSession({
      ...first.opts,
      invocationKind: "resume_open_run",
      prompt,
    });
    markDelivered(requests);
  } catch (error) {
    log.warn("leader_resume_failed", { sessionKey: host.id, error });
    retryDelivery(host, deps, requests);
  }
}

function retryDelivery(
  host: SessionHost,
  deps: SessionHostDeps,
  requests: CoalescedWakeRequest[],
): void {
  if (host.abortController.signal.aborted) return;
  for (const request of requests) {
    requestCoalescedWake(host, deps, { ...request, immediate: false });
  }
}

function markDelivered(requests: CoalescedWakeRequest[]): void {
  for (const request of requests) {
    try {
      request.onDelivered?.();
    } catch (error) {
      log.warn("wake_delivery_checkpoint_failed", { error });
    }
  }
}
