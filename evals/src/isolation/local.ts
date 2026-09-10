import { safeId } from "../core/durable.js";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { CapabilityReport, IsolationSpec } from "../../schemas/index.js";
import type { IsolationBackend } from "../core/contracts.js";

/** Development-only directory provisioning; callers must reject it for controlled comparisons. */
export class LocalDevelopmentIsolationBackend implements IsolationBackend {
  readonly id = "local-development"; readonly version = "1";
  constructor(readonly stateRoot: string) {}
  async preflight(_spec: IsolationSpec): Promise<CapabilityReport> { return { schemaVersion: 1, adapterId: this.id, adapterVersion: this.version, supported: true, capabilities: { controlled_isolation: false, filesystem_separation: true, descendant_stop: false }, limitations: ["Local development backend is not controlled isolation and is ineligible for comparisons"], evidence: ["directory-only backend"] }; }
  async provision(spec: IsolationSpec): Promise<{ workspaceId: string; mountPath: string }> { const mountPath = resolve(this.stateRoot, safeId(spec.runId), "workspace"); await mkdir(mountPath, { recursive: true }); return { workspaceId: spec.runId, mountPath }; }
  async teardown(workspaceId: string): Promise<void> { await rm(resolve(this.stateRoot, safeId(workspaceId)), { recursive: true, force: true }); }
}
