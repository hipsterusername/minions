import { resolveTreatment } from './treatment.js';
import type { AdapterConfig, CapabilityReport, ExecutionSnapshot, ParticipantRunSpec, RunEvent, RunHandle } from "../../schemas/index.js";
import type { CollectedExecution, ExecutionAdapter, StopReason, StopReceipt } from "../core/contracts.js";
import { UsageLedger } from '../telemetry/usage.js';
import { report, type CodexProcessLauncher, type ProcessRun } from "./protocol.js";

export class CodexRawAdapter implements ExecutionAdapter {
  readonly id = "codex-raw"; readonly version = "1.0.0";
  #byKey = new Map<string, { handle: RunHandle; process: ProcessRun }>(); #byHandle = new Map<string, ProcessRun>();
  constructor(private readonly launcher: CodexProcessLauncher) {}
  async preflight(config: AdapterConfig): Promise<CapabilityReport> {
    resolveTreatment(config.settings);
    const p = await this.launcher.probe(); const caps = { direct_executable: true, fresh_state: p.supportsEphemeral, json_events: p.supportsJson, delegation_disabled: p.supportsDisableDelegation, reconnect: p.supportsReconnect === true, workspace_collection: true, stop_descendants: true, usage_export: p.supportsJson };
    const missing = ["fresh_state", "json_events", "delegation_disabled", "reconnect", ...config.requiredCapabilities].filter((key) => !caps[key as keyof typeof caps]);
    return report(this.id, this.version, missing.length === 0, caps, missing.map((x) => `missing capability: ${x}`), [`${p.executable} ${p.version} sha256:${p.binaryDigest ?? "unavailable"}`, "Requires `codex exec --json --ephemeral` and a documented delegation-disable config flag."]);
  }
  async start(run: ParticipantRunSpec): Promise<RunHandle> {
    resolveTreatment(run.configuration);
    const existing = this.#byKey.get(run.idempotencyKey); if (existing) return existing.handle;
    const process = await this.launcher.launch({ run, args: ["--disable", "multi_agent", "--disable", "multi_agent_v2", "exec", "--strict-config", "--json", "--ephemeral", "--ignore-user-config", "--sandbox", "workspace-write", "--skip-git-repo-check", ...(typeof run.configuration.model === "string" ? ["--model", run.configuration.model] : []), ...(typeof run.configuration.reasoningEffort === "string" ? ["-c", `model_reasoning_effort=${JSON.stringify(run.configuration.reasoningEffort)}`] : []), "--cd", (run.configuration.execution as {workdir?:string} | undefined)?.workdir ?? run.workspace.mountPath], environment: {} });
    const handle: RunHandle = { schemaVersion: 1, adapterId: this.id, handleId: process.id, runId: run.runId, createdAt: process.createdAt ?? new Date().toISOString() };
    this.#byKey.set(run.idempotencyKey, { handle, process }); this.#byHandle.set(handle.handleId, process); return handle;
  }
  async *observe(handle: RunHandle, afterSequence = 0): AsyncIterable<RunEvent> {
    const p=this.process(handle); const ledger=new UsageLedger();let sequence=0;let turn=0;
    for await (const payload of p.events) {
      sequence++;if(payload.type==='turn.started')turn++;
      const counts=payload.usage as Record<string,number>|undefined;
      const turnId=typeof payload.turn_id==='string'?payload.turn_id:`turn-${turn}`;
      let usage;
      if(payload.type==='turn.completed'&&counts) {
        ledger.ingest({sourceId:turnId,participantId:handle.runId,turnId,kind:'turn_snapshot',semantics:'codex_raw',revision:typeof payload.revision==='number'?payload.revision:undefined,
          input:counts.input_tokens,output:counts.output_tokens,cacheRead:counts.cached_input_tokens,cacheWrite:counts.cache_creation_input_tokens,
          reasoning:counts.reasoning_output_tokens});usage=ledger.aggregate([handle.runId]).usage;
      }
      if(sequence<=afterSequence)continue;
      yield {schemaVersion:1,eventId:`${handle.runId}:${sequence}`,experimentId:'external',runId:handle.runId,sequence,observedAt:new Date().toISOString(),providerTimestamp:null,adapterId:this.id,participantId:handle.runId,sessionId:handle.handleId,turnId,type:usage?'usage':'lifecycle',payload:{...payload,...(usage?{normalizedUsage:usage}: {})}};
    }
    const outcome=(await p.inspect()).outcome;
    const aggregate=ledger.aggregate([handle.runId]);
    if(outcome!=='completed'&&aggregate.usage&&++sequence>afterSequence)yield {schemaVersion:1,eventId:`${handle.runId}:${sequence}`,experimentId:'external',runId:handle.runId,sequence,observedAt:new Date().toISOString(),providerTimestamp:null,adapterId:this.id,participantId:handle.runId,sessionId:handle.handleId,turnId:null,type:'usage',payload:{usage:{...aggregate.usage,coverage:'partial',coverageReasons:[`terminal outcome ${outcome}; in-flight usage may be unreported`]}}};
  }
  async inspect(handle: RunHandle): Promise<ExecutionSnapshot> { const x = await this.process(handle).inspect(); return { schemaVersion: 1, handle, state: x.terminal ? "terminal" : "running", terminalOutcome: x.outcome, participants: [{ id: handle.runId, parentId: null, state: x.terminal ? "terminal" : "running", terminal: x.terminal }], observedAt: new Date().toISOString() }; }
  async stop(handle: RunHandle, reason: StopReason): Promise<StopReceipt> { const accepted = await this.process(handle).stop(reason); return { schemaVersion: 1, handle, reason, accepted, stoppedAt: new Date().toISOString(), descendantsAccountedFor: accepted }; }
  async collect(handle: RunHandle): Promise<CollectedExecution> { const artifacts = await this.process(handle).collect(); return { schemaVersion: 1, handle, artifacts, provenance: { executable: "codex", mode: "raw", direct: true, protocolAdherence: "valid" }, usageCoverage: "partial", logTruncated: false }; }
  private process(handle: RunHandle): ProcessRun { const p = this.#byHandle.get(handle.handleId) ?? this.launcher.reconnect?.(handle.handleId); if (!p) throw new Error(`unknown durable handle ${handle.handleId}`); return p; }
}
