import type { CapabilityReport, ExecutionSnapshot, ParticipantRunSpec, RunEvent, RunHandle } from "../../schemas/index.js";
import type { CollectedExecution, StopReason, StopReceipt } from "../core/contracts.js";

/** Boundary deliberately modelled as transport messages; implementations live outside evals. */
export interface MinionsProtocolClient {
  probe(): Promise<{ protocolVersion: number; capabilities: Record<string, boolean>; evidence: string[] }>;
  launch(input: { mode: "single" | "graph"; run: ParticipantRunSpec; restrictions: Record<string, unknown> }): Promise<RunHandle>;
  events(handle: RunHandle, afterSequence?: number): AsyncIterable<RunEvent>;
  snapshot(handle: RunHandle): Promise<ExecutionSnapshot>;
  cancel(handle: RunHandle, reason: StopReason): Promise<StopReceipt>;
  collect(handle: RunHandle): Promise<CollectedExecution>;
}

export interface ExternalAdapterDependencies { minions?: MinionsProtocolClient; now?: () => Date; }
export interface ProcessRun {
  id: string; createdAt?: string; events: AsyncIterable<Record<string, unknown>>; inspect(): Promise<{ terminal: boolean; outcome: ExecutionSnapshot["terminalOutcome"] }>;
  stop(reason: StopReason): Promise<boolean>; collect(): Promise<CollectedExecution["artifacts"]>;
}
export interface CodexProcessLauncher { reconnect?(id: string): ProcessRun; probe(): Promise<{ executable: string; version: string; binaryDigest?: string; supportsJson: boolean; supportsEphemeral: boolean; supportsDisableDelegation: boolean; supportsReconnect?: boolean }>; launch(input: { run: ParticipantRunSpec; args: string[]; environment: Record<string, string> }): Promise<ProcessRun>; }

export function report(adapterId: string, version: string, supported: boolean, capabilities: Record<string, boolean>, limitations: string[], evidence: string[]): CapabilityReport {
  return { schemaVersion: 1, adapterId, adapterVersion: version, supported, capabilities, limitations, evidence };
}
