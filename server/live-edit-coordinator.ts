import crypto from "node:crypto";
import { captureLiveEditBaseline, sameLiveEditBaseline, type LiveEditBaseline } from "./live-edit-baseline.ts";
import { canonicalizeLiveEditPaths, liveEditPathsOverlap,
  type CanonicalLiveEditPath, type LiveEditPathInput } from "./live-edit-paths.ts";

export interface LiveEditClaimRequest {
  requestId: string; workItemId: string; runKey: string;
  paths: readonly LiveEditPathInput[]; opaqueShell?: boolean; ttlMs?: number;
}
export interface LiveEditLease {
  token: string; workItemId: string; runKey: string; paths: readonly CanonicalLiveEditPath[];
  baselines: readonly LiveEditBaseline[]; acquiredAt: number; expiresAt: number; maxHoldAt: number;
}
export type LiveEditRunState = "clean" | "editing" | "waiting";
export type LiveEditEvent = {
  type: "queued" | "granted" | "heartbeat" | "released" | "expired" | "cancelled" | "baseline_conflict";
  requestId?: string; token?: string; workItemId: string; runKey: string;
  paths: readonly string[]; at: number; runState: LiveEditRunState;
  workItemState: LiveEditRunState;
  queuePosition?: number; blockingRunKeys?: readonly string[];
  acquiredAt?: number; expiresAt?: number; maxHoldAt?: number; reason?: string;
  workItemPaths?: readonly string[]; workItemQueuePosition?: number | null;
  workItemBlockingRunKeys?: readonly string[]; workItemBaselineConflict?: boolean;
};
export class LiveEditBaselineConflictError extends Error {
  constructor(readonly paths: readonly string[]) { super(`live-edit baseline changed: ${paths.join(", ")}`); }
}
export class LiveEditClaimCancelledError extends Error {}

interface Active extends LiveEditLease { requestId: string; ttlMs: number; depth: number;
  conflicted: boolean; inFlightMutations: number }
interface Queued { request: LiveEditClaimRequest; paths: CanonicalLiveEditPath[];
  waiters: Array<{ resolve: (lease: LiveEditLease) => void; reject: (error: Error) => void }>; queuedAt: number }
export interface LiveEditRunSnapshot { state: LiveEditRunState; active: readonly LiveEditLease[];
  queued: readonly { requestId: string; workItemId: string; runKey: string; paths: readonly string[];
    queuePosition: number; blockingRunKeys: readonly string[] }[]; baselineConflict: boolean }
export interface LiveEditCoordinatorOptions { projectPath: string; now?: () => number;
  token?: () => string; defaultTtlMs?: number; maxHoldMs?: number }

export class LiveEditCoordinator {
  private readonly active = new Map<string, Active>();
  private readonly tokenByOwner = new Map<string, string>();
  private readonly queue: Queued[] = [];
  private readonly listeners = new Set<(event: LiveEditEvent) => void>();
  private readonly now: () => number; private readonly token: () => string;
  private readonly defaultTtlMs: number; private readonly maxHoldMs: number;
  constructor(private readonly options: LiveEditCoordinatorOptions) {
    this.now = options.now ?? Date.now; this.token = options.token ?? crypto.randomUUID;
    this.defaultTtlMs = options.defaultTtlMs ?? 30_000; this.maxHoldMs = options.maxHoldMs ?? 120_000;
  }
  subscribe(listener: (event: LiveEditEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /** Explicit open_change_intent protocol entrypoint; aliases the atomic claim operation. */
  openIntent(request: LiveEditClaimRequest): Promise<LiveEditLease> { return this.claim(request); }
  /** Explicit close_change_intent protocol entrypoint. */
  closeIntent(token: string, reason = "intent_closed"): boolean { return this.release(token, reason); }
  claim(request: LiveEditClaimRequest): Promise<LiveEditLease> {
    this.sweep();
    if (!request.requestId || !request.workItemId || !request.runKey) return Promise.reject(new Error("claim identity required"));
    const paths = canonicalizeLiveEditPaths(this.options.projectPath,
      request.opaqueShell ? [{ path: ".", scope: "prefix" }] : request.paths);
    if (paths.length === 0) return Promise.reject(new Error("at least one live-edit path is required"));
    const retriedActive = [...this.active.values()].find((entry) => entry.requestId === request.requestId);
    if (retriedActive) return Promise.resolve(this.publicLease(retriedActive));
    const retriedQueued = this.queue.find((entry) => entry.request.requestId === request.requestId);
    if (retriedQueued) return new Promise((resolve, reject) => retriedQueued.waiters.push({ resolve, reject }));
    const ownToken = this.tokenByOwner.get(`${request.workItemId}\0${request.runKey}`);
    if (ownToken) {
      const own = this.active.get(ownToken)!;
      if (own.runKey === request.runKey) {
        const additions = paths.filter((entry) => !own.paths.some((prior) => prior.path === entry.path && prior.scope === entry.scope));
        if (this.conflictingActive(additions, own.token).length !== 0) {
          return Promise.reject(new Error("reentrant expansion conflicts; close the existing intent and reclaim atomically"));
        }
        const baselines = additions.map(captureLiveEditBaseline).filter((value): value is LiveEditBaseline => value !== null);
        own.paths = [...own.paths, ...additions]; own.baselines = [...own.baselines, ...baselines]; own.depth += 1;
        own.expiresAt = Math.min(this.now() + own.ttlMs, own.maxHoldAt);
        this.emitFor("granted", own, { requestId: request.requestId }); return Promise.resolve(this.publicLease(own));
      }
    }
    return new Promise((resolve, reject) => {
      const queued: Queued = { request, paths, waiters: [{ resolve, reject }], queuedAt: this.now() };
      this.queue.push(queued); this.drain();
      if (this.queue.includes(queued)) this.emitQueued(queued);
    });
  }
  heartbeat(token: string, options: { inFlight?: boolean } = {}): LiveEditLease {
    const now = this.now(); const candidate = this.active.get(token);
    if (options.inFlight && candidate && now < candidate.expiresAt) {
      candidate.maxHoldAt = Math.max(candidate.maxHoldAt, now + this.maxHoldMs);
    }
    this.sweep(); const lease = this.require(token);
    lease.expiresAt = Math.min(now + lease.ttlMs, lease.maxHoldAt);
    this.emitFor("heartbeat", lease); return this.publicLease(lease);
  }
  /** Pin a lease while a pre-authorized mutation tool is executing. */
  beginMutation(token: string): LiveEditLease {
    this.sweep(); const lease = this.require(token); lease.inFlightMutations += 1;
    return this.publicLease(lease);
  }
  /** Clear one execution pin after PostToolUse/PostToolUseFailure. */
  endMutation(token: string): LiveEditLease {
    const lease = this.require(token);
    if (lease.inFlightMutations === 0) throw new Error("live-edit mutation is not in flight");
    lease.inFlightMutations -= 1; const result = this.publicLease(lease);
    if (lease.inFlightMutations === 0) this.sweep();
    return result;
  }
  revalidate(token: string): void {
    this.sweep(); const lease = this.require(token); const byPath = new Map(lease.paths.map((entry) => [entry.path, entry]));
    const conflicts = lease.baselines.filter((baseline) => {
      const current = captureLiveEditBaseline(byPath.get(baseline.path)!); return !current || !sameLiveEditBaseline(baseline, current);
    }).map((entry) => entry.path);
    if (conflicts.length) { lease.conflicted = true; this.emitFor("baseline_conflict", lease, { paths: conflicts }); throw new LiveEditBaselineConflictError(conflicts); }
  }
  /** Accept current filesystem state after this lease's own successful mutation. */
  refresh(token: string): LiveEditLease {
    this.sweep(); const lease = this.require(token); const now = this.now();
    lease.baselines = lease.paths.map(captureLiveEditBaseline)
      .filter((value): value is LiveEditBaseline => value !== null);
    lease.conflicted = false; lease.expiresAt = Math.min(now + lease.ttlMs, lease.maxHoldAt);
    this.emitFor("heartbeat", lease); return this.publicLease(lease);
  }
  release(token: string, reason = "released"): boolean { return this.releaseInternal(token, reason, false); }
  cancel(requestId: string): boolean {
    const index = this.queue.findIndex((entry) => entry.request.requestId === requestId); if (index < 0) return false;
    const [queued] = this.queue.splice(index, 1);
    for (const waiter of queued!.waiters) waiter.reject(new LiveEditClaimCancelledError("live-edit claim cancelled"));
    this.emitQueuedTerminal("cancelled", queued!); this.drain(); this.refreshQueuedEvents(); return true;
  }
  disconnect(runKey: string): void {
    for (const queued of [...this.queue].filter((entry) => entry.request.runKey === runKey)) this.cancel(queued.request.requestId);
    for (const lease of [...this.active.values()].filter((entry) => entry.runKey === runKey)) this.releaseInternal(lease.token, "disconnect", true);
  }
  sweep(): void {
    const now = this.now();
    for (const lease of [...this.active.values()]) if (lease.inFlightMutations === 0
      && (now >= lease.expiresAt || now >= lease.maxHoldAt))
      this.releaseInternal(lease.token, now >= lease.maxHoldAt ? "max_hold" : "ttl", true, "expired");
  }
  restart(): void {
    for (const queued of [...this.queue]) this.cancel(queued.request.requestId);
    for (const lease of [...this.active.values()]) this.releaseInternal(lease.token, "restart", true);
  }
  snapshotRun(runKey: string): LiveEditRunSnapshot {
    const active = [...this.active.values()].filter((entry) => entry.runKey === runKey).map((entry) => this.publicLease(entry));
    const queued = this.queue.filter((entry) => entry.request.runKey === runKey).map((entry) => ({
      requestId: entry.request.requestId, workItemId: entry.request.workItemId, runKey,
      paths: entry.paths.map((path) => path.path),
      queuePosition: this.queue.indexOf(entry) + 1,
      blockingRunKeys: this.blockingRunKeys(entry),
    }));
    const conflicted = [...this.active.values()].some((entry) => entry.runKey === runKey && entry.conflicted);
    return { state: queued.length || conflicted ? "waiting" : active.length ? "editing" : "clean",
      active, queued, baselineConflict: conflicted };
  }
  snapshotWorkItem(workItemId: string): LiveEditRunSnapshot {
    const active = [...this.active.values()].filter((entry) => entry.workItemId === workItemId)
      .map((entry) => this.publicLease(entry));
    const queued = this.queue.filter((entry) => entry.request.workItemId === workItemId).map((entry) => ({
      requestId: entry.request.requestId, workItemId, runKey: entry.request.runKey,
      paths: entry.paths.map((path) => path.path),
      queuePosition: this.queue.indexOf(entry) + 1,
      blockingRunKeys: this.blockingRunKeys(entry),
    }));
    const conflicted = [...this.active.values()].some((entry) => entry.workItemId === workItemId && entry.conflicted);
    return { state: queued.length || conflicted ? "waiting" : active.length ? "editing" : "clean",
      active, queued, baselineConflict: conflicted };
  }
  private drain(): void {
    let changed = true; let granted = false;
    while (changed) { changed = false;
      for (let index = 0; index < this.queue.length; index += 1) {
        const queued = this.queue[index]!;
        const earlierConflict = this.queue.slice(0, index).some((earlier) => this.setsOverlap(earlier.paths, queued.paths));
        if (earlierConflict || this.conflictingActive(queued.paths).length) continue;
        this.queue.splice(index, 1); this.grant(queued); changed = true; granted = true; break;
      }
    }
    if (granted) this.refreshQueuedEvents();
  }
  private grant(queued: Queued): void {
    const at = this.now(); const ttlMs = queued.request.ttlMs ?? this.defaultTtlMs;
    const lease: Active = { token: this.token(), requestId: queued.request.requestId,
      workItemId: queued.request.workItemId, runKey: queued.request.runKey, paths: queued.paths,
      baselines: queued.paths.map(captureLiveEditBaseline).filter((v): v is LiveEditBaseline => v !== null),
      acquiredAt: at, expiresAt: Math.min(at + ttlMs, at + this.maxHoldMs), maxHoldAt: at + this.maxHoldMs,
      ttlMs, depth: 1, conflicted: false, inFlightMutations: 0 };
    this.active.set(lease.token, lease); this.tokenByOwner.set(`${lease.workItemId}\0${lease.runKey}`, lease.token);
    this.emitFor("granted", lease, { requestId: lease.requestId });
    for (const waiter of queued.waiters) waiter.resolve(this.publicLease(lease));
  }
  private releaseInternal(token: string, reason: string, force: boolean, type: "released" | "expired" = "released"): boolean {
    const lease = this.active.get(token); if (!lease) return false;
    if (!force && lease.inFlightMutations > 0) {
      throw new Error("cannot release a live-edit lease while a mutation is in flight");
    }
    if (!force && lease.depth > 1) { lease.depth -= 1; return true; }
    this.active.delete(token); this.tokenByOwner.delete(`${lease.workItemId}\0${lease.runKey}`);
    this.emitFor(type, lease, { reason }); this.drain(); return true;
  }
  private require(token: string) { const lease = this.active.get(token); if (!lease) throw new Error("live-edit lease is not active"); return lease; }
  private conflictingActive(paths: readonly CanonicalLiveEditPath[], except?: string) {
    return [...this.active.values()].filter((lease) => lease.token !== except && this.setsOverlap(paths, lease.paths));
  }
  private setsOverlap(a: readonly CanonicalLiveEditPath[], b: readonly CanonicalLiveEditPath[]) {
    return a.some((left) => b.some((right) => liveEditPathsOverlap(left, right)));
  }
  private publicLease(lease: Active): LiveEditLease {
    const { requestId: _r, ttlMs: _t, depth: _d, conflicted: _c,
      inFlightMutations: _i, ...value } = lease; return value;
  }
  private runState(runKey: string): LiveEditRunState { return this.snapshotRun(runKey).state; }
  private emitFor(type: LiveEditEvent["type"], lease: Active, extra: Partial<LiveEditEvent> = {}) {
    this.emit({ type, token: lease.token, workItemId: lease.workItemId, runKey: lease.runKey,
      paths: lease.paths.map((path) => path.path), at: this.now(), runState: this.runState(lease.runKey),
      workItemState: this.snapshotWorkItem(lease.workItemId).state,
      acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt, maxHoldAt: lease.maxHoldAt,
      ...this.workItemAwareness(lease.workItemId), ...extra });
  }
  private emitQueued(queued: Queued) {
    const index = this.queue.indexOf(queued);
    const blockers = [...this.conflictingActive(queued.paths).map((lease) => lease.runKey),
      ...this.queue.slice(0, Math.max(0, index)).filter((earlier) => this.setsOverlap(earlier.paths, queued.paths))
        .map((earlier) => earlier.request.runKey)];
    this.emit({ type: "queued", requestId: queued.request.requestId, workItemId: queued.request.workItemId,
      runKey: queued.request.runKey, paths: queued.paths.map((path) => path.path), at: this.now(), runState: "waiting",
      workItemState: this.snapshotWorkItem(queued.request.workItemId).state,
      ...this.workItemAwareness(queued.request.workItemId),
      queuePosition: index + 1, blockingRunKeys: [...new Set(blockers)] });
  }
  private blockingRunKeys(queued: Queued): string[] {
    const index = this.queue.indexOf(queued);
    return [...new Set([...this.conflictingActive(queued.paths).map((lease) => lease.runKey),
      ...this.queue.slice(0, Math.max(0, index)).filter((earlier) => this.setsOverlap(earlier.paths, queued.paths))
        .map((earlier) => earlier.request.runKey)])];
  }
  private emitQueuedTerminal(type: "cancelled", queued: Queued) {
    this.emit({ type, requestId: queued.request.requestId, workItemId: queued.request.workItemId,
      runKey: queued.request.runKey, paths: queued.paths.map((path) => path.path), at: this.now(),
      runState: this.runState(queued.request.runKey),
      workItemState: this.snapshotWorkItem(queued.request.workItemId).state,
      ...this.workItemAwareness(queued.request.workItemId) });
  }
  private refreshQueuedEvents() { for (const queued of this.queue) this.emitQueued(queued); }
  private workItemAwareness(workItemId: string) {
    const snapshot = this.snapshotWorkItem(workItemId); const first = snapshot.queued[0];
    return { workItemPaths: [...new Set([...snapshot.active.flatMap((lease) => lease.paths.map((entry) => entry.path)),
      ...snapshot.queued.flatMap((entry) => entry.paths)])],
      workItemQueuePosition: first?.queuePosition ?? null,
      workItemBlockingRunKeys: first ? [...first.blockingRunKeys] : [],
      workItemBaselineConflict: snapshot.baselineConflict };
  }
  private emit(event: LiveEditEvent) {
    for (const listener of this.listeners) { try { listener(event); } catch { /* observers cannot break lease safety */ } }
  }
}

export function createLiveEditCoordinator(options: LiveEditCoordinatorOptions): LiveEditCoordinator {
  return new LiveEditCoordinator(options);
}
