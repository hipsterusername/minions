import { prepareRuntime } from "./runtime.js";
import { prepareWorkspaceRepository } from "./workspace-repository.js";
import { writeChangesPatch } from "../isolation/changes.js";
import { localSubmissionGrader } from "./grading.js";
import { taskContent, verifyLockDigest } from "../core/plan-lock.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile, access } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { EventStore, LifecycleRunner, ResultStore, type ExecutionAdapter } from "../core/index.js";
import { ProcessFakeAdapter } from "../core/testing-runtime.js";
import { atomicJson, locked } from "../core/durable.js";
import { exportPublicFixture, preparePublicFixture, snapshotSubmission, freezeSubmission, DockerIsolationBackend, LocalDevelopmentIsolationBackend } from "../isolation/index.js";
import { fileGrader, processExecutor } from "../graders/executor.js";
import { ExperimentCellSchema, ExperimentPlanSchema, type TaskDefinition, type ExperimentCell, type IsolationSpec } from "../../schemas/index.js";
import type { DurableRun } from "../core/store.js";
export interface OperationalLock { tasks: TaskDefinition[]; taskRoots: Record<string, string>; fixtureSeeds: Record<string, string>; cells: ExperimentCell[]; [key: string]: unknown; }
export async function externalRoot(path: string, sourceRoot: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("output root must be absolute");
  let parent = resolve(path); const suffix: string[] = [];
  while (true) { try { parent = await realpath(parent); break; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; suffix.unshift(parent.slice(dirname(parent).length + 1)); parent = dirname(parent); } }
  const canonical = resolve(parent, ...suffix); const rel = relative(await realpath(sourceRoot), canonical);
  if (rel === "" || (!rel.startsWith("../") && rel !== "..")) throw new Error("output root must be outside source checkout");
  return canonical;
}
export async function operate(command: string, directory: string, lock: OperationalLock, adapters: Map<string, ExecutionAdapter>): Promise<number> {
  verifyLockDigest(lock);
  const { tasks, taskRoots, cells, fixtureSeeds, taskDigests, lockDigest, capabilities, ...document } = lock;
  const plan = ExperimentPlanSchema.parse(document); cells.forEach(cell => ExperimentCellSchema.parse(cell));
  const store = new ResultStore(join(directory, "state.json"));
  if (command === "cancel") { await atomicJson(join(directory, "cancel.json"), { requestedAt: new Date().toISOString() }); for (const run of await store.listRuns()) if (run.handle && run.status !== "finalized") { await store.updateRun(run.runId, { cancellationRequested: true, stopReason: "cancelled" }); const adapter = adapters.get(run.mode!); if (!adapter) throw new Error("unknown adapter on cancel"); await adapter.stop(run.handle, "cancelled"); } }
  return locked(join(directory, "controller"), async () => {
    for (const cell of cells) {
      const task = tasks.find(t => t.id === cell.taskId); if (!task) throw new Error("missing locked task");
      const adapter = adapters.get(cell.adapterId); if (!adapter) throw new Error("adapter unavailable: " + cell.adapterId);
      if (command !== "grade" && taskDigests && (taskDigests as Record<string,string>)[task.id] !== await taskContent(task,taskRoots[task.id]!)) throw new Error("locked task content drift: " + task.id);
      const config = plan.adapterConfigs.find(c => c.adapterId === cell.adapterId)!;
      const previous = (await store.listRuns()).find(r => r.cellId === cell.cellId);
      if (previous?.status === "finalized" && command !== "grade") {
        if ('shutdown' in adapter) await (adapter as ExecutionAdapter & {shutdown(runId:string):Promise<void>}).shutdown(previous.runId);
        const oldBackend = config.settings.isolation === 'docker' ? new DockerIsolationBackend({stateRoot:join(directory,'isolation')}) : new LocalDevelopmentIsolationBackend(join(directory,'isolation'));
        await oldBackend.teardown(previous.runId); continue;
      }
      if (command === "grade" && !previous) continue;
      const runId = previous?.runId ?? randomUUID(); const runDir = join(directory, "runs", runId);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(directory,".agent-evals-owned"),"1");
      const submissionRoot = join(runDir, "submission"); const isolationState = join(directory, "isolation");
      const controlled = config.settings.isolation === "docker";
      if (!controlled && cell.adapterId !== "process-fake" && config.settings.profile !== "local-development") throw new Error("real adapter requires Docker or explicit local-development profile");
      const backend = controlled ? new DockerIsolationBackend({ stateRoot: isolationState }) : new LocalDevelopmentIsolationBackend(isolationState);
      const iso: IsolationSpec = { schemaVersion: 1, backendId: backend.id, runId, participantRoot: taskRoots[task.id]!, networkPolicy: config.settings.networkPolicy === "declared_only" ? "declared_only" : "none", cpuLimit: 1, memoryBytes: 512 * 1024 * 1024, storageBytes: task.submission.maxBytes, imageDigest: task.fixture.imageDigest };
      if (!previous) {
        if (await access(join(directory, "cancel.json")).then(() => true, () => false)) break;
        if ((await store.listRuns()).reduce((n, r) => n + (r.usage?.totalTokens ?? 0), 0) >= plan.limits.aggregateTokenCap) break;
        const capability = await backend.preflight(iso); if (!capability.supported) throw new Error(capability.limitations.join("; "));
        const adapterCapability = await adapter.preflight(config); if (!adapterCapability.supported) throw new Error(adapterCapability.limitations.join("; "));
      }
      const oracle = resolve(taskRoots[task.id]!, task.grader.configFile);
      const localGrader = localSubmissionGrader(task, oracle, submissionRoot, cell.fixtureSeed);
      const grader: typeof localGrader = controlled ? { id: localGrader.id, version: localGrader.version, async grade(input, context) {
        const gradeBackend = new DockerIsolationBackend({ stateRoot: join(directory, "grader-isolation") });
        const workspace = await gradeBackend.provision({ ...iso, runId: "grade-" + randomUUID() });
        try { await exportPublicFixture({ sourceRoot: submissionRoot, destinationRoot: workspace.mountPath, include: ["."], maxBytes: task.submission.maxBytes }); if (task.requiredCapabilities.includes('browser')) {
          const result=await gradeBackend.execute(workspace.workspaceId,['node','-e',"require('fs').symlinkSync('/opt/evals-runtime/node_modules','/workspace/node_modules','dir')"]);
          if (result.code) throw new Error('grader browser runtime preparation failed: '+result.stderr);
        }
        const descriptor = await gradeBackend.descriptor(workspace.workspaceId); return await fileGrader(task, oracle, "/workspace", cell.fixtureSeed, processExecutor(submissionRoot, task.limits.gradingTimeoutMs, descriptor)).grade(input, context); }
        finally { await gradeBackend.teardown(workspace.workspaceId); }
      } } : localGrader;
      const runner = new LifecycleRunner({ experimentId: plan.experimentId, aggregateTokenCap: plan.limits.aggregateTokenCap, store, stopWriters: async run => { if (controlled && run.spec) await (backend as DockerIsolationBackend).stopDescendants(run.spec.workspace.id); }, events: new EventStore(join(runDir, "events.jsonl")), graderContext: { schemaVersion: 1, graderRevision: task.grader.revision, timeoutMs: task.limits.gradingTimeoutMs, environment: {} }, snapshotSubmission: async run => {
        if (run.spec?.configuration.execution && (run.spec.configuration.execution as {kind:string}).kind === "docker") await (backend as DockerIsolationBackend).stopDescendants(run.spec.workspace.id);
        try { const existing = JSON.parse(await readFile(join(runDir, "submission.json"), "utf8")); const actual = await freezeSubmission(submissionRoot, task.submission.maxBytes); if (actual.submissionHash !== existing.submissionHash) throw new Error("frozen submission changed"); return existing; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        const snapshot = await snapshotSubmission(run.spec!.workspace.mountPath, submissionRoot, task.submission.maxBytes, task.submission); await atomicJson(join(runDir, "submission.json"), snapshot);
        const baseline=JSON.parse(await readFile(join(runDir,'baseline.json'),'utf8'));
        await writeChangesPatch(join(runDir,'baseline'),baseline,submissionRoot,snapshot,join(runDir,'changes.patch'));
        return snapshot;
      } }, adapter, grader);
      if (command === "grade") { const result = await store.getResult(runId); if (!result?.submission) continue; const actual = await freezeSubmission(submissionRoot, task.submission.maxBytes); if (actual.submissionHash !== result.submission.submissionHash) throw new Error("frozen submission changed"); const grade = await grader.grade(result.submission, { schemaVersion: 1, taskId: task.id, graderRevision: task.grader.revision, timeoutMs: task.limits.gradingTimeoutMs, environment: {} }); await store.putResult({ ...result, grade, gradeOutcome: grade.outcome }); continue; }
      if (!previous) {
        await store.putRun({ runId, cellId: cell.cellId, taskId: task.id, mode: cell.adapterId, repetition: cell.repetition, status: "preparing", handle: null, cancellationRequested: false, launched: false, executionOutcome: null, updatedAt: new Date().toISOString() });
        try {
        const preparationStart=performance.now();
        const workspace = await backend.provision(iso);
        await prepareRuntime(config,task,controlled?{backend:backend as DockerIsolationBackend,workspaceId:workspace.workspaceId}:undefined);
        await preparePublicFixture(task, taskRoots[task.id]!, workspace.mountPath, cell.fixtureSeed);
        if (cell.adapterId !== 'process-fake') await prepareWorkspaceRepository(workspace.mountPath,
          controlled ? await (backend as DockerIsolationBackend).descriptor(workspace.workspaceId) : undefined);
        const baseline=await snapshotSubmission(workspace.mountPath,join(runDir,'baseline'),task.submission.maxBytes,task.submission);
        await atomicJson(join(runDir,'baseline.json'),baseline);
        await store.updateRun(runId,{preparationMs:performance.now()-preparationStart});
        const execution = controlled ? await (backend as DockerIsolationBackend).descriptor(workspace.workspaceId) : { kind: "local", workdir: workspace.mountPath, stateRoot: join(runDir, "participant-state") };
        await runner.start({ cell, spec: { schemaVersion: 1, runId, idempotencyKey: runId, taskId: task.id, prompt: await readFile(join(taskRoots[task.id]!, task.promptFile), "utf8"), workspace: { id: workspace.workspaceId, mountPath: workspace.mountPath }, limits: task.limits, configuration: { ...config.settings, execution, experimentId: plan.experimentId }, visibleAssets: [] } });
        } catch (error) {
          const state = await store.getRun(runId);
          if (state?.deadline) throw error; // Uncertain adapter start remains fenced for recovery.
          await store.putResult({ schemaVersion: 1, runId, cellId: cell.cellId, taskId: task.id, mode: cell.adapterId, repetition: cell.repetition, executionOutcome: "infra_error", gradeOutcome: "not_run", protocolAdherence: "unverified", usage: null, submission: null, grade: null, timings: {preparationMs:0,executionMs:0,collectionMs:0,gradingMs:0} });
          await store.updateRun(runId,{status:"finalized",executionOutcome:"infra_error"});
          await backend.teardown(runId);
          return 3;
        }
      } else if (!previous.handle) {
        if (!previous.spec) { await store.putResult({ schemaVersion:1,runId,cellId:cell.cellId,taskId:task.id,mode:cell.adapterId,repetition:cell.repetition,executionOutcome:"interrupted",gradeOutcome:"not_run",protocolAdherence:"unverified",usage:null,submission:null,grade:null,timings:{preparationMs:0,executionMs:0,collectionMs:0,gradingMs:0} }); await store.updateRun(runId,{status:"finalized",executionOutcome:"interrupted"}); continue; }
        await runner.start({ cell, spec: previous.spec });
      }
      try { await runner.drive(runId); }
      finally { if ((await store.getRun(runId))?.status === 'finalized') {
        if ('shutdown' in adapter) await (adapter as ExecutionAdapter & {shutdown(runId:string):Promise<void>}).shutdown(runId);
        await backend.teardown(runId);
      } }
    }
    const results = await store.listResults();
    if (results.some(r => r.executionOutcome === "cancelled")) return 130;
    if (results.some(r => r.executionOutcome === "infra_error" || r.gradeOutcome === "error")) return 3;
    return results.length === cells.length && results.every(r => r.executionOutcome === "completed" && r.gradeOutcome === "passed" && r.grade && r.protocolAdherence === "valid") ? 0 : 1;
  });
}
export function fakeAdapter(directory: string) { return new ProcessFakeAdapter(join(directory, "process-handles")); }
