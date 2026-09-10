import { WakeDeliveryError, wakeFailureDisposition, type WakeCheckpoint } from "./wake-delivery-store.ts";
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

export const MAX_PENDING_WAKES = 32;
export const MAX_PENDING_WAKE_BYTES = 256 * 1024;
export const WAKE_RETRY_DELAYS = [15_000, 30_000, 60_000, 120_000, 300_000];
interface Entry {
  key: string; request: CoalescedWakeRequest; bytes: number;
  checkpoint: WakeCheckpoint;
}
interface Queue {
  entries: Map<string, Entry>; receipts: Map<string, WakeCheckpoint>; bytes: number;
  timer?: ReturnType<typeof setTimeout>; inFlight: boolean; cancelled: boolean; overflowReported?: boolean;
}
const pendingWakes = new WeakMap<SessionHost, Queue>();
const lastResumeAt = new WeakMap<SessionHost, number>();

export function isHostWakeEligible(host: SessionHost, deps: SessionHostDeps): boolean {
  return !host.abortController.signal.aborted && !(host.workItemId && host.runKind === "primary"
    && deps.wakeDelivery?.eligibility(host.workItemId, host.runKey) === "obsolete");
}
export function getWakeQueueStats(host: SessionHost): { count: number; bytes: number; inFlight: boolean } {
  const queue = pendingWakes.get(host);
  return { count: queue?.entries.size ?? 0, bytes: queue?.bytes ?? 0, inFlight: queue?.inFlight ?? false };
}

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
  host: SessionHost, deps: SessionHostDeps, request: CoalescedWakeRequest,
): boolean {
  const key = createHash("sha256").update(request.idempotencyKey ?? request.opts.prompt).digest("hex").slice(0, 24);
  try {
    const saved = deps.wakeDelivery?.get(host.runKey, key) ?? pendingWakes.get(host)?.receipts.get(key);
    if (!isHostWakeEligible(host, deps)) {
      deps.wakeDelivery?.put(host.runKey, key, { attempts: saved?.attempts ?? 0,
        nextAt: 0, state: "obsolete", reason: "Run is sealed, superseded, removed or cancelled" });
      return false;
    }
    if (saved?.state === "delivered") { request.onDelivered?.(); return false; }
    if (saved && saved.state !== "pending") return false;
    if (saved && saved.attempts > WAKE_RETRY_DELAYS.length) {
      deps.wakeDelivery?.put(host.runKey, key, { ...saved, state: "failed", reason: "Wake retry budget exhausted" });
      return false;
    }
    let queue = pendingWakes.get(host);
    if (!queue) {
      queue = { entries: new Map(), receipts: new Map(), bytes: 0, inFlight: false, cancelled: false };
      pendingWakes.set(host, queue);
    }
    if (queue.cancelled && queue.inFlight) return false;
    queue.cancelled = false;
    if (queue.entries.has(key)) return false;
    const bytes = Buffer.byteLength(JSON.stringify(request.opts)) + Buffer.byteLength(request.idempotencyKey ?? "");
    if (queue.entries.size >= MAX_PENDING_WAKES || queue.bytes + bytes > MAX_PENDING_WAKE_BYTES) {
      if (!queue.overflowReported) log.warn("wake_capacity_exceeded", { sessionKey: host.id });
      queue.overflowReported = true;
      return false;
    }
    const now = Date.now();
    const batchDue = queue.entries.values().next().value?.checkpoint.nextAt;
    const entry: Entry = { key, request, bytes, checkpoint: saved ?? { attempts: 0, state: "pending",
      nextAt: Math.max(Math.min(batchDue ?? Infinity, now + (request.immediate ? 0 : WAKE_COALESCE_WINDOW_MS)),
        (lastResumeAt.get(host) ?? -MIN_WAKE_RESUME_INTERVAL_MS) + MIN_WAKE_RESUME_INTERVAL_MS) } };
    deps.wakeDelivery?.put(host.runKey, key, entry.checkpoint);
    queue.entries.set(key, entry); queue.bytes += bytes;
    if (!host.workItemId && request.immediate) {
      for (const pending of queue.entries.values()) {
        if (pending.checkpoint.attempts === 0) pending.checkpoint.nextAt = Math.min(pending.checkpoint.nextAt, entry.checkpoint.nextAt);
      }
    }
    if (!queue.inFlight && entry.checkpoint.nextAt <= now) {
      flushWake(host, deps, queue); return true;
    }
    arm(host, deps, queue);
  } catch (error) { log.warn("wake_checkpoint_failed", { sessionKey: host.id, error }); }
  return false;
}

export function cancelCoalescedWake(host: SessionHost): void {
  const queue = pendingWakes.get(host);
  if (!queue) return;
  clearTimeout(queue.timer); queue.timer = undefined;
  queue.cancelled = true; queue.entries.clear(); queue.bytes = 0;
}

function arm(host: SessionHost, deps: SessionHostDeps, queue: Queue): void {
  clearTimeout(queue.timer); queue.timer = undefined;
  if (queue.cancelled || queue.inFlight || !queue.entries.size) return;
  const due = Math.min(...Array.from(queue.entries.values(), e => e.checkpoint.nextAt));
  queue.timer = setTimeout(() => flushWake(host, deps, queue), Math.max(0, due - Date.now()));
  queue.timer.unref?.();
}
function remove(queue: Queue, entry: Entry): void {
  if (queue.entries.delete(entry.key)) queue.bytes -= entry.bytes;
}
function checkpoint(host: SessionHost, deps: SessionHostDeps, entry: Entry): void {
  deps.wakeDelivery?.put(host.runKey, entry.key, entry.checkpoint);
  const receipts = pendingWakes.get(host)?.receipts;
  if (receipts) {
    receipts.delete(entry.key); receipts.set(entry.key, { ...entry.checkpoint });
    if (receipts.size > MAX_PENDING_WAKES * 4) receipts.delete(receipts.keys().next().value!);
  }
}
function fail(host: SessionHost, deps: SessionHostDeps, queue: Queue, entry: Entry, error: unknown): void {
  const disposition = isHostWakeEligible(host, deps) ? wakeFailureDisposition(error) : "obsolete";
  const delay = WAKE_RETRY_DELAYS[entry.checkpoint.attempts - 1];
  entry.checkpoint = { attempts: entry.checkpoint.attempts,
    state: disposition === "obsolete" ? "obsolete" : disposition === "transient" && delay ? "pending" : "failed",
    nextAt: delay ? Date.now() + Math.round(delay * (1 + Math.random() * 0.1)) : 0,
    reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) };
  checkpoint(host, deps, entry);
  if (entry.checkpoint.state !== "pending") {
    remove(queue, entry);
    if (entry.checkpoint.state === "failed") log.warn("wake_delivery_exhausted", {
      sessionKey: host.id, key: entry.key, attempts: entry.checkpoint.attempts, reason: entry.checkpoint.reason,
    });
  }
}
function flushWake(host: SessionHost, deps: SessionHostDeps, queue: Queue): void {
  clearTimeout(queue.timer); queue.timer = undefined;
  if (queue.inFlight || queue.cancelled) return;
  try {
    if (!isHostWakeEligible(host, deps)) {
      for (const entry of queue.entries.values()) fail(host, deps, queue, entry, new WakeDeliveryError("obsolete", "Run no longer eligible"));
      return;
    }
    const ready = [...queue.entries.values()].filter(e => e.checkpoint.nextAt <= Date.now());
    if (!ready.length) { arm(host, deps, queue); return; }
    if (host.status === "stopped" && !ready.some(e => e.request.allowStopped)) {
      for (const entry of ready) { fail(host, deps, queue, entry, new WakeDeliveryError("obsolete", "Host stopped")); }
      arm(host, deps, queue); return;
    }
    if (host.status === "running" || host.runControl !== null || host.eventStream !== null) {
      // Waiting for a live turn to finish is not a failed delivery attempt.
      // Keep one bounded timer without exhausting attention during long turns.
      for (const entry of ready) {
        entry.checkpoint.nextAt = Date.now() + MIN_WAKE_RESUME_INTERVAL_MS;
        checkpoint(host, deps, entry);
      }
      arm(host, deps, queue); return;
    }
    // Keep canonical request identities independent of batch membership across restart.
    const entries = host.workItemId && host.runKind === "primary" ? ready.slice(0, 1) : ready;
    for (const entry of entries) { entry.checkpoint.attempts++; checkpoint(host, deps, entry); }
    queue.inFlight = true;
    const first = entries[0]!;
    const prompt = entries.length === 1 ? first.request.opts.prompt : [
      "Multiple wake events occurred for this leader session. Review each event and continue orchestrating.",
      ...entries.map((entry, i) => `Wake event ${i + 1}:\n${entry.request.opts.prompt}`),
    ].join("\n\n");
    lastResumeAt.set(host, Date.now());
    const signal = host.abortController.signal;
    const finish = (error?: unknown) => {
      if (queue.cancelled || signal.aborted) { cancelCoalescedWake(host); queue.inFlight = false; return; }
      try {
        if (error !== undefined) {
          log.warn(host.workItemId ? "work_item_resume_failed" : "leader_resume_failed",
            { sessionKey: host.id, workItemId: host.workItemId, runKey: host.runKey, error });
          for (const entry of entries) fail(host, deps, queue, entry, error);
        } else {
          for (const entry of entries) {
            entry.checkpoint.state = "delivered"; checkpoint(host, deps, entry); remove(queue, entry);
            try { entry.request.onDelivered?.(); }
            catch (error) { log.warn("wake_delivery_checkpoint_failed", { error }); }
          }
        }
      } catch (error) {
        // Persistence failure is visible and never starts a perpetual automatic retry.
        for (const entry of entries) remove(queue, entry);
        log.warn("wake_checkpoint_failed", { sessionKey: host.id, error });
      }
      queue.inFlight = false;
      const floor = Date.now() + MIN_WAKE_RESUME_INTERVAL_MS;
      for (const entry of queue.entries.values()) entry.checkpoint.nextAt = Math.max(entry.checkpoint.nextAt, floor);
      arm(host, deps, queue);
    };
    try {
      if (host.workItemId && host.runKind === "primary" && !deps.resumeWorkItemRun) {
        throw new WakeDeliveryError("unknown", "Canonical wake dispatch unavailable");
      }
      const result = host.workItemId && host.runKind === "primary" && deps.resumeWorkItemRun
        ? deps.resumeWorkItemRun({ workItemId: host.workItemId, runKey: host.runKey, prompt,
            continuitySource: "system", requestId: `wake:${host.runKey}:${first.key}` })
        : deps.startChildSession({ ...first.request.opts, continuitySource: "system", invocationKind: "resume_open_run", prompt });
      if (result && typeof result.then === "function") void result.then(() => finish(), finish);
      else finish();
    } catch (error) { finish(error); }
  } catch (error) {
    cancelCoalescedWake(host);
    log.warn("wake_checkpoint_failed", { sessionKey: host.id, error });
  }
}

export function assertWakeStart(opts: StartSessionOptions, host: SessionHost | undefined, deps: SessionHostDeps): void {
  if (opts.continuitySource !== "system" || opts.runKind !== "primary") return;
  if (!host || !isHostWakeEligible(host, deps)) throw new WakeDeliveryError("obsolete", "Wake host no longer eligible");
  if (host.status === "running" || host.runControl || host.eventStream) throw new WakeDeliveryError("transient", "Wake host busy");
}
