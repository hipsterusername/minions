import { atomicJson, locked, safeId } from "./durable.js";
import type { ParticipantRunSpec, Usage } from "../../schemas/index.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ResultRecordSchema, type ExperimentCell, type ResultRecord, type RunHandle } from "../../schemas/index.js";

export type LifecycleStatus = ExperimentCell["status"];
export interface DurableRun { readonly runId: string; readonly cellId: string; readonly taskId: string; readonly status: LifecycleStatus; readonly handle: RunHandle | null; readonly cancellationRequested: boolean; readonly launched: boolean; readonly executionOutcome: ResultRecord["executionOutcome"]; readonly updatedAt: string; readonly spec?: ParticipantRunSpec; readonly deadline?: string; readonly startedAt?: string; readonly stopReason?: string; readonly mode?: string; readonly repetition?: number; readonly usage?: Usage | null; readonly observedSequence?: number; readonly preparationMs?: number; }
interface StoreData { schemaVersion: 1; runs: Record<string, DurableRun>; results: Record<string, ResultRecord>; }
const initial = (): StoreData => ({ schemaVersion: 1, runs: {}, results: {} });

/** Atomic controller state. It intentionally has no adapter side effects. */
export class ResultStore {
  constructor(readonly path: string) {}
  async getRun(runId: string): Promise<DurableRun | null> { const runs = (await this.read()).runs; return Object.hasOwn(runs, runId) ? runs[runId]! : null; }
  async listRuns(): Promise<readonly DurableRun[]> { return Object.values((await this.read()).runs); }
  async putRun(run: DurableRun): Promise<void> { safeId(run.runId); await this.mutate((data) => { data.runs[run.runId] = run; }); await atomicJson(`${dirname(this.path)}/runs/${run.runId}/run.json`, run); }
  async updateRun(runId: string, update: Partial<Omit<DurableRun, "runId" | "cellId">>): Promise<DurableRun> { let saved!: DurableRun; await this.mutate((data) => { const current = data.runs[runId]; if (!current) throw new Error(`unknown run ${runId}`); saved = { ...current, ...update, updatedAt: new Date().toISOString() }; data.runs[runId] = saved; }); await atomicJson(`${dirname(this.path)}/runs/${safeId(runId)}/run.json`, saved); return saved; }
  async putResult(result: ResultRecord): Promise<void> { ResultRecordSchema.parse(result); safeId(result.runId); if (result.grade) await atomicJson(`${dirname(this.path)}/runs/${result.runId}/grades/${safeId(result.grade.gradeId)}.json`, result.grade); await atomicJson(`${dirname(this.path)}/runs/${result.runId}/result.json`, result); await this.mutate((data) => { data.results[result.runId] = result; }); }
  async getResult(runId: string): Promise<ResultRecord | null> { const results = (await this.read()).results; return Object.hasOwn(results,runId) ? results[runId]! : null; }
  async listResults(): Promise<readonly ResultRecord[]> { return Object.values((await this.read()).results); }
  private async read(): Promise<StoreData> { try { return JSON.parse(await readFile(this.path, "utf8")) as StoreData; } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return initial(); throw error; } }
  private async mutate(fn: (data: StoreData) => void): Promise<void> { await locked(this.path, async () => { const data = await this.read(); fn(data); await atomicJson(this.path, data); }); }
}
