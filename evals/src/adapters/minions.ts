import { resolveTreatment } from './treatment.js';
import type { AdapterConfig, CapabilityReport, ExecutionSnapshot, ParticipantRunSpec, RunEvent, RunHandle } from "../../schemas/index.js";
import type { CollectedExecution, ExecutionAdapter, StopReason, StopReceipt } from "../core/contracts.js";
import { report, type ExternalAdapterDependencies, type MinionsProtocolClient } from "./protocol.js";

abstract class MinionsExternalAdapter implements ExecutionAdapter {
  abstract readonly id: "minion-single" | "minion-graph"; readonly version = "1.0.0";
  #handles = new Map<string, RunHandle>();
  constructor(protected readonly client: MinionsProtocolClient | undefined) {}
  async preflight(config: AdapterConfig): Promise<CapabilityReport> {
    resolveTreatment(config.settings);
    if (!this.client) return report(this.id, this.version, false, {}, ["no external Minions protocol client configured"], ["Provide a dedicated-process WS/HTTP protocol client; evals never imports server modules."]);
    const probe = await this.client.probe(); const required = this.requiredCapabilities(); const absent = required.filter((key) => !probe.capabilities[key]);
    const requestedAbsent = config.requiredCapabilities.filter((key) => !probe.capabilities[key]);
    return report(this.id, this.version, absent.length === 0 && requestedAbsent.length === 0, probe.capabilities,
      [...absent.map((x) => `missing required capability: ${x}`), ...requestedAbsent.map((x) => `missing requested capability: ${x}`)], probe.evidence);
  }
  async start(run: ParticipantRunSpec): Promise<RunHandle> {
    resolveTreatment(run.configuration);
    const existing = this.#handles.get(run.idempotencyKey); if (existing) return existing;
    if (!this.client) throw new Error("Minions adapter requires an external protocol client");
    const handle = await this.client.launch({ mode: this.id === "minion-single" ? "single" : "graph", run, restrictions: this.restrictions() });
    this.#handles.set(run.idempotencyKey, handle); return handle;
  }
  observe(handle: RunHandle, afterSequence?: number): AsyncIterable<RunEvent> { if (!this.client) throw new Error("missing protocol client"); return this.client.events(handle, afterSequence); }
  inspect(handle: RunHandle): Promise<ExecutionSnapshot> { if (!this.client) throw new Error("missing protocol client"); return this.client.snapshot(handle); }
  stop(handle: RunHandle, reason: StopReason): Promise<StopReceipt> { if (!this.client) throw new Error("missing protocol client"); return this.client.cancel(handle, reason); }
  collect(handle: RunHandle): Promise<CollectedExecution> { if (!this.client) throw new Error("missing protocol client"); return this.client.collect(handle); }
  protected abstract requiredCapabilities(): string[]; protected abstract restrictions(): Record<string, unknown>;
}

export class MinionSingleAdapter extends MinionsExternalAdapter {
  readonly id = "minion-single" as const;
  protected requiredCapabilities(): string[] { return ["dedicated_state", "session_reconnect", "session_tree", "usage_export", "workspace_collection", "stop_descendants", "role_tool_restrictions"]; }
  protected restrictions(): Record<string, unknown> { return { role: "minion", taskGraphTools: false, delegationTools: false, nativeSubagents: false, requireDedicatedState: true }; }
}

export class MinionGraphAdapter extends MinionsExternalAdapter {
  readonly id = "minion-graph" as const;
  protected requiredCapabilities(): string[] { return ["dedicated_state", "session_reconnect", "session_tree", "usage_export", "workspace_collection", "stop_descendants", "headless_graph_start", "graph_self_decomposition", "graph_min_nodes_2", "graph_terminal_quiescence"]; }
  protected restrictions(): Record<string, unknown> { return { role: "leader", taskGraphTools: true, topology: "participant_authored", minimumMeaningfulNodes: 2, humanReview: "preconfigured", requireDedicatedState: true }; }
}
