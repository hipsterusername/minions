import type { LiveEditCoordinator, LiveEditLease } from "./live-edit-coordinator.ts";
import path from "node:path";
import { canonicalizeLiveEditPaths, type CanonicalLiveEditPath,
  type LiveEditPathInput } from "./live-edit-paths.ts";
import type { MutationDescriptor } from "./mutation-observability.ts";

interface ActiveTool { token: string; release: boolean; refreshOnSuccess: boolean;
  timer: ReturnType<typeof setInterval> }

function desiredPaths(descriptor: MutationDescriptor, projectPath: string): LiveEditPathInput[] {
  return descriptor.opaque || descriptor.operation === "shell"
    ? [{ path: ".", scope: "prefix" }]
    : descriptor.paths.map((candidate) => ({
      path: path.isAbsolute(candidate) ? path.relative(projectPath, candidate) : candidate,
      scope: descriptor.operation === "delete" || descriptor.operation === "rename"
        ? "prefix" as const : "file" as const,
    }));
}
function covers(held: CanonicalLiveEditPath, desired: CanonicalLiveEditPath): boolean {
  if (held.path === "." && held.scope === "prefix") return true;
  if (held.path === desired.path) return held.scope === "prefix" || desired.scope === "file";
  return held.scope === "prefix" && desired.path.startsWith(`${held.path}/`);
}

export class RunMutationCoordination {
  private explicit: LiveEditLease | null = null;
  private explicitTimer: ReturnType<typeof setInterval> | null = null;
  private readonly tools = new Map<string, ActiveTool>();
  private leaseLost: (() => void) | undefined;
  private readonly unsubscribe: () => void;
  private readonly allowedPaths: CanonicalLiveEditPath[] | null;
  constructor(readonly coordinator: LiveEditCoordinator, readonly projectPath: string,
    readonly workItemId: string, readonly runKey: string,
    private readonly heartbeatMs = 5_000,allowedPaths:readonly LiveEditPathInput[]|null=null) {
    this.allowedPaths=allowedPaths?canonicalizeLiveEditPaths(projectPath,allowedPaths):null;
    this.unsubscribe = coordinator.subscribe((event) => {
      if (event.runKey !== runKey || event.type !== "expired") return;
      if (this.explicit?.token === event.token) {
        if (this.explicitTimer) clearInterval(this.explicitTimer);
        this.explicitTimer = null; this.explicit = null;
      }
      for (const [callId, active] of this.tools) if (active.token === event.token) {
        clearInterval(active.timer); this.tools.delete(callId);
      }
      this.leaseLost?.();
    });
  }

  setLeaseLostHandler(handler: () => void): void { this.leaseLost = handler; }

  async openIntent(requestId: string, paths: readonly LiveEditPathInput[], opaqueShell = false) {
    if (this.explicit) throw new Error("a change intent is already open for this run");
    this.assertAllowed(opaqueShell?[{path:".",scope:"prefix"}]:paths);
    const lease = await this.coordinator.openIntent({ requestId, workItemId: this.workItemId,
      runKey: this.runKey, paths, ...(opaqueShell ? { opaqueShell: true } : {}) });
    this.explicit = lease;
    this.explicitTimer = setInterval(() => this.safeHeartbeat(lease.token), this.heartbeatMs);
    return lease;
  }
  closeIntent(token: string): boolean {
    if (!this.explicit || this.explicit.token !== token) throw new Error("change intent token is not active for this run");
    if (this.explicitTimer) clearInterval(this.explicitTimer);
    this.explicitTimer = null; this.explicit = null;
    return this.coordinator.closeIntent(token);
  }
  async beforeTool(callId: string, descriptor: MutationDescriptor): Promise<void> {
    const paths = desiredPaths(descriptor, this.projectPath);
    this.assertAllowed(paths);
    let token: string; let release = true; let refreshOnSuccess = false;
    if (this.explicit && this.intentCovers(paths)) {
      token = this.explicit.token; release = false; refreshOnSuccess = true;
    } else {
      const lease = await this.coordinator.claim({ requestId: callId,
        workItemId: this.workItemId, runKey: this.runKey, paths,
        ...(descriptor.opaque || descriptor.operation === "shell" ? { opaqueShell: true } : {}) });
      token = lease.token;
      if (this.explicit?.token === token) {
        // A same-run reentrant claim expanded the explicit lease. Balance its
        // claim depth after the tool, but retain and refresh the intent.
        this.explicit = lease; refreshOnSuccess = true;
      }
    }
    try { this.coordinator.revalidate(token); this.coordinator.beginMutation(token); }
    catch (error) { if (release) this.coordinator.release(token, "pre_tool_conflict"); throw error; }
    const timer = setInterval(() => this.safeHeartbeat(token, true), this.heartbeatMs);
    this.tools.set(callId, { token, release, refreshOnSuccess, timer });
  }
  finishTool(callId: string, outcome: "success" | "error" | "cancelled"): string | null {
    const active = this.tools.get(callId); if (!active) { this.coordinator.cancel(callId); return null; }
    clearInterval(active.timer); this.tools.delete(callId);
    let refreshError: unknown;
    try {
      if (active.refreshOnSuccess && outcome === "success") this.coordinator.refresh(active.token);
    } catch (error) { refreshError = error; }
    finally {
      // Never strand an execution pin, even when recapturing the successful
      // write's baseline fails. Balance any reentrant tool claim first.
      this.coordinator.endMutation(active.token);
      if (active.release) this.coordinator.release(active.token, `tool_${outcome}`);
      if (refreshError && this.explicit?.token === active.token) {
        if (this.explicitTimer) clearInterval(this.explicitTimer);
        this.explicitTimer = null; this.explicit = null;
        this.coordinator.closeIntent(active.token, "baseline_refresh_error");
      }
    }
    return refreshError
      ? `live-edit baseline refresh failed: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`
      : null;
  }
  cancelTool(callId: string): void { this.coordinator.cancel(callId); this.finishTool(callId, "cancelled"); }
  disconnect(): void {
    if (this.explicitTimer) clearInterval(this.explicitTimer);
    for (const active of this.tools.values()) clearInterval(active.timer);
    this.explicitTimer = null; this.explicit = null; this.tools.clear();
    this.coordinator.disconnect(this.runKey); this.unsubscribe();
  }
  private intentCovers(paths: readonly LiveEditPathInput[]): boolean {
    if (!this.explicit) return false;
    const desired = canonicalizeLiveEditPaths(this.projectPath, paths);
    return desired.every((entry) => this.explicit!.paths.some((held) => covers(held, entry)));
  }
  private assertAllowed(paths:readonly LiveEditPathInput[]):void {
    if (this.allowedPaths===null) return;
    const desired=canonicalizeLiveEditPaths(this.projectPath,paths);
    const outside=desired.filter(entry=>!this.allowedPaths!.some(allowed=>covers(allowed,entry)));
    if (outside.length) throw new Error(
      `mutation exceeds task ownership scope: ${outside.map(entry=>entry.path).join(", ")}`);
  }
  private safeHeartbeat(token: string, inFlight = false): void {
    try { this.coordinator.heartbeat(token, { inFlight }); } catch { /* expiry/max-hold is terminal */ }
  }
}
