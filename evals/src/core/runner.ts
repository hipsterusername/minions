import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomicJson, locked } from "./durable.js";
import { UsageSchema } from "../../schemas/index.js";
import type { ExperimentCell, ParticipantRunSpec, RunHandle, ResultRecord, Usage } from "../../schemas/index.js";
import type { ExecutionAdapter, Grader, GraderContext, StopReason } from "./contracts.js";
import type { FrozenSubmission } from "../../schemas/index.js";
import { EventStore } from "./events.js";
import { ResultStore, type DurableRun } from "./store.js";

const transitions: Readonly<Record<ExperimentCell["status"], readonly ExperimentCell["status"][]>> = { planned: ["preparing", "finalized"], preparing: ["ready", "finalized"], ready: ["running", "finalized"], running: ["stopping", "collecting", "finalized"], stopping: ["collecting", "finalized"], collecting: ["grading", "finalized"], grading: ["finalized"], finalized: [] };
export interface RunnerOptions { readonly experimentId: string; readonly aggregateTokenCap: number; readonly store: ResultStore; readonly events: EventStore; readonly now?: () => Date; readonly stopWriters?: (run: DurableRun) => Promise<void>; readonly snapshotSubmission?: (run: DurableRun) => Promise<FrozenSubmission>; readonly graderContext?: Omit<GraderContext, "taskId">; readonly usageForCollected?: (run: DurableRun, collected: Awaited<ReturnType<ExecutionAdapter["collect"]>>) => Promise<Usage | null>; readonly timingsForRun?: (run: DurableRun) => ResultRecord["timings"]; }
export interface RunRequest { readonly cell: ExperimentCell; readonly spec: ParticipantRunSpec; }

export class LifecycleRunner {
  readonly #now: () => Date;
  constructor(readonly options: RunnerOptions, readonly adapter: ExecutionAdapter, readonly grader?: Grader) { this.#now = options.now ?? (() => new Date()); if ((options.snapshotSubmission || options.graderContext) && !grader) throw new Error("snapshot/grade configuration requires a grader"); }
  async start(request: RunRequest): Promise<RunHandle> {
    return locked(this.options.store.path + ".launch", async () => {
    let current = await this.options.store.getRun(request.spec.runId);
    if (current?.handle) { if (current.status === "ready") await this.transition(current, "running"); return current.handle; }
    if (current?.status === "finalized") throw new Error(`run ${request.spec.runId} is finalized`);
    if (!current) { current = this.newRun(request); await this.options.store.putRun(current); }
    if (!current.spec) await this.options.store.updateRun(request.spec.runId, { spec: request.spec });
    if (current.status === "planned") await this.transition(current, "preparing");
    if ((await this.requireRun(request.spec.runId)).status === "preparing") await this.transition(await this.requireRun(request.spec.runId), "ready");
    if (!current.deadline) await this.options.store.updateRun(request.spec.runId, { startedAt: this.#now().toISOString(), deadline: new Date(this.#now().getTime() + request.spec.limits.executionTimeoutMs).toISOString() });
    // Persisted idempotency key plus adapter idempotency contract prevents relaunch after controller recovery.
    const handle = await this.adapter.start(request.spec);
    await this.options.store.updateRun(request.spec.runId, { handle, launched: true });
    await this.transition(await this.requireRun(request.spec.runId), "running");
    return handle;
    });
  }
  async cancel(runId: string, reason: StopReason = "cancelled"): Promise<void> { const run = await this.requireRun(runId); if (run.status === "finalized") return; await this.options.store.updateRun(runId, { cancellationRequested: true, stopReason: reason }); if (run.handle) { if (run.status === "running") await this.transition(await this.requireRun(runId), "stopping"); await this.adapter.stop(run.handle, reason); } }
  async reconcile(): Promise<void> { for (const run of await this.options.store.listRuns()) { if (run.status === "finalized") continue; if (!run.handle) continue; const snapshot = await this.adapter.inspect(run.handle); if (snapshot.state === "terminal") await this.drive(run.runId); else if (snapshot.state === "unknown") { await this.adapter.stop(run.handle, "controller_shutdown"); await this.finishExecution(run, "interrupted"); } } }
  async drive(runId: string): Promise<void> {
    // A controller may die between persisting the handle and the running transition.
    const recovered = await this.requireRun(runId);
    if (recovered.status === "ready" && recovered.handle) await this.transition(recovered, "running");
    if ((await this.requireRun(runId)).status === "grading" || (await this.requireRun(runId)).status === "collecting") { const pending = await this.requireRun(runId); await this.finishExecution(pending, pending.executionOutcome ?? "interrupted"); return; }
    let observerError: unknown;
    const run = await this.requireRun(runId); if (!run.handle) throw new Error("missing durable handle");
    const observe = (async () => { try { for await (const event of this.adapter.observe(run.handle!, run.observedSequence ?? -1)) { await this.options.events.append({ ...event, experimentId: this.options.experimentId }); if (event.type === "graph_changed") await atomicJson(join(dirname(this.options.events.path),"graph.json"),event.payload); const usage = UsageSchema.safeParse(event.payload.normalizedUsage ?? event.payload.usage ?? event.payload); if (event.type === "usage") await new EventStore(join(dirname(this.options.events.path),"usage.raw.jsonl")).append({...event,experimentId:this.options.experimentId}); if (usage.success) { const base = dirname(this.options.events.path); await new EventStore(join(base,"usage.normalized.jsonl")).append({...event,experimentId:this.options.experimentId,payload:{usage:usage.data}}); } await this.options.store.updateRun(runId, { observedSequence: event.sequence, ...(usage.success ? { usage: usage.data } : {}) }); } } catch (e) { observerError = e; } })();
    while (true) {
      let current = await this.requireRun(runId); if (current.status === "finalized") return;
      if (current.cancellationRequested) await this.cancel(runId, (current.stopReason ?? "cancelled") as StopReason);
      if (current.deadline) await this.watchdog(runId, new Date(current.deadline));
      const total = (await this.options.store.listRuns()).reduce((n, r) => n + (r.usage?.totalTokens ?? 0), 0);
      await this.enforceLimits(runId, total);
      if (current.spec && (current.usage?.totalTokens ?? 0) > current.spec.limits.maxTotalTokens) await this.cancel(runId, "budget_exceeded");
      const state = await this.adapter.inspect(run.handle);
      if (state.state === "terminal" || state.state === "unknown") {
        if (state.state === "unknown") { await this.adapter.stop(run.handle, "controller_shutdown"); throw new Error("uncertain external launch; admission blocked pending reconciliation"); }
        await observe;
        if (observerError) throw observerError;
        await atomicJson(join(dirname(this.options.events.path),"participant-tree.json"), state.participants);
        current = await this.requireRun(runId);
        await this.finishExecution(current, current.stopReason === "timeout" ? "timeout" : current.stopReason === "budget_exceeded" ? "budget_exceeded" : current.cancellationRequested ? "cancelled" : state.terminalOutcome ?? "interrupted"); return;
      }
      if (observerError) { await this.cancel(runId, "controller_shutdown"); }
      await delay(25);
    }
  }
  async enforceLimits(runId: string, observedTotalTokens: number): Promise<boolean> { if (observedTotalTokens <= this.options.aggregateTokenCap) return false; await this.cancel(runId, "budget_exceeded"); return true; }
  async watchdog(runId: string, deadline: Date): Promise<boolean> { if (this.#now() <= deadline) return false; await this.cancel(runId, "timeout"); return true; }
  async finishExecution(run: DurableRun, outcome: NonNullable<DurableRun["executionOutcome"]>): Promise<void> {
    if (run.status === "finalized") return;
    const persisted = await this.options.store.getResult(run.runId);
    if (persisted) { await this.transition(run, "finalized"); return; }
    const stoppedAt = this.#now().getTime();
    const collectionStart = performance.now();
    if (run.status === "running" || run.status === "stopping") await this.transition(await this.requireRun(run.runId), "collecting");
    let current = await this.requireRun(run.runId);
    let writersStopped = false;
    if (current.handle) { const receipt = await this.adapter.stop(current.handle, "controller_shutdown"); writersStopped = receipt.accepted && receipt.descendantsAccountedFor; }
    if (!writersStopped) outcome = "infra_error";
    let collected: Awaited<ReturnType<ExecutionAdapter["collect"]>> | null = null;
    try { if (current.handle) collected = await this.adapter.collect(current.handle); } catch { outcome = "infra_error"; }
    if (collected?.provenance.resolvedTreatment) await atomicJson(join(dirname(this.options.events.path), "resolved-treatment.json"), collected.provenance.resolvedTreatment);
    if (this.options.stopWriters) await this.options.stopWriters(current);
    await this.options.store.updateRun(run.runId, { executionOutcome: outcome });
    current = await this.requireRun(run.runId);
    const collectionMs = performance.now() - collectionStart;
    const gradingStart = performance.now();
    let submission: FrozenSubmission | null = null;
    let grade: ResultRecord["grade"] = null;
    let gradeOutcome: ResultRecord["gradeOutcome"] = "not_run";
    if (writersStopped && this.grader && this.options.snapshotSubmission && this.options.graderContext) {
      if (current.status !== "grading") await this.transition(current, "grading");
      try {
        submission = await this.options.snapshotSubmission(await this.requireRun(run.runId));
        grade = await this.grader.grade(submission, { ...this.options.graderContext, taskId: current.taskId });
        gradeOutcome = grade.outcome;
      } catch (error) {
        gradeOutcome = "error";
        await this.options.events.append({ schemaVersion: 1, eventId: `${run.runId}:grade-error`, experimentId: this.options.experimentId, runId: run.runId, observedAt: this.#now().toISOString(), providerTimestamp: null, adapterId: this.adapter.id, participantId: null, sessionId: null, turnId: null, type: "error", payload: { phase: "grading", message: error instanceof Error ? error.message : String(error) } });
      }
    }
    const finalRun = await this.requireRun(run.runId);
    await this.options.store.putResult({ schemaVersion: 1, runId: finalRun.runId, cellId: finalRun.cellId, taskId: finalRun.taskId, mode: finalRun.mode, repetition: finalRun.repetition, handle: finalRun.handle, deadline: finalRun.deadline, controlledMeasurement: (finalRun.spec?.configuration.execution as {kind?:string})?.kind === "docker", executionOutcome: outcome, gradeOutcome, protocolAdherence: this.adapter.id === "process-fake" || collected?.provenance.protocolAdherence === "valid" ? "valid" : collected?.provenance.protocolAdherence === "violated" ? "violated" : "unverified", usage: collected && this.options.usageForCollected ? await this.options.usageForCollected(finalRun, collected) : finalRun.usage ?? null, submission, grade, timings: this.options.timingsForRun?.(finalRun) ?? { preparationMs: finalRun.preparationMs ?? 0, executionMs: finalRun.startedAt ? Math.max(0, stoppedAt - Date.parse(finalRun.startedAt)) : 0, collectionMs, gradingMs: performance.now() - gradingStart } });
    if (grade) await this.options.events.append({ schemaVersion: 1, eventId: `${run.runId}:grade:${grade.gradeId}`, experimentId: this.options.experimentId, runId: run.runId, observedAt: this.#now().toISOString(), providerTimestamp: null, adapterId: this.adapter.id, participantId: null, sessionId: null, turnId: null, type: "grade_published", payload: { gradeId: grade.gradeId, outcome: grade.outcome } });
    await this.transition(await this.requireRun(run.runId), "finalized");
  }
  private newRun(request: RunRequest): DurableRun { return { runId: request.spec.runId, cellId: request.cell.cellId, taskId: request.cell.taskId, status: "planned", handle: null, cancellationRequested: false, launched: false, executionOutcome: null, updatedAt: this.#now().toISOString(), spec: request.spec, mode: request.cell.adapterId, repetition: request.cell.repetition }; }
  private async transition(run: DurableRun, next: ExperimentCell["status"]): Promise<void> { if (!transitions[run.status].includes(next)) throw new Error(`invalid lifecycle transition ${run.status} -> ${next}`); await this.options.store.updateRun(run.runId, { status: next }); await this.options.events.append({ schemaVersion: 1, eventId: `${run.runId}:lifecycle:${next}`, experimentId: this.options.experimentId, runId: run.runId, observedAt: this.#now().toISOString(), providerTimestamp: null, adapterId: this.adapter.id, participantId: null, sessionId: null, turnId: null, type: "lifecycle", payload: { from: run.status, to: next } }); }
  private async requireRun(runId: string): Promise<DurableRun> { const run = await this.options.store.getRun(runId); if (!run) throw new Error(`unknown run ${runId}`); return run; }
}
