#!/usr/bin/env node
import { contentHash, implementationContent, taskContent, verifyLockDigest } from "../core/plan-lock.js";
/** Standalone command surface. Commands deliberately use only evals-owned files. */
import { operate, fakeAdapter, externalRoot, type OperationalLock } from "./operations.js";
import { verifyOracle } from "./oracles.js";
import { preflight } from "./preflight.js";
import { report } from "./report.js";
import { demoLock } from "./demo.js";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createExternalAdapter } from "../adapters/index.js";
import { createImmutablePlan, ResultStore, scheduleCells, validateTaskManifest, type ExecutionAdapter } from "../core/index.js";
import { analysisJson, renderOfflineReport, resultsCsv, type ReportRecord } from "../reports/index.js";
import { ExperimentPlanSchema, type AdapterConfig, type ExperimentPlan, type TaskDefinition } from "../../schemas/index.js";

type Json = Record<string, unknown>;
const moduleDir = dirname(fileURLToPath(import.meta.url));
// Source execution and the emitted dist tree have different depths.
const root = moduleDir.endsWith("/dist/src/cli") ? resolve(moduleDir, "../../..") : resolve(moduleDir, "../..");
let sourceRoot = root;
for (let cursor=root; dirname(cursor)!==cursor; cursor=dirname(cursor)) if ((existsSync(join(cursor,'.git','HEAD')) || (existsSync(join(cursor,'.git')) && statSync(join(cursor,'.git')).isFile()))) { sourceRoot=cursor; break; }
const taskRoot = join(root, "tasks");
const groundTruthRoot = join(root, "ground-truth");
const exit = { ok: 0, failed: 1, invalid: 2, infrastructure: 3, cancelled: 130 } as const;

function args(argv: string[]): { command: string; values: Map<string, string | true> } {
  const [command = "help", ...rest] = argv;
  const values = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i += 1) {
    const item = rest[i]!;
    if (!item.startsWith("--")) throw new Error(`unexpected argument: ${item}`);
    const key = item.slice(2); const value = rest[i + 1];
    if (!value || value.startsWith("--")) values.set(key, true); else { values.set(key, value); i += 1; }
  }
  return { command, values };
}
function required(values: Map<string, string | true>, key: string): string { const value = values.get(key); if (!value || value === true) throw new Error(`--${key} is required`); return value; }
function output(value: Json): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
async function json(path: string): Promise<Json> { return JSON.parse(await readFile(path, "utf8")) as Json; }
async function loadTasks(suite: Json): Promise<TaskDefinition[]> {
  const profiles = suite.profiles as Record<string, { taskIds: string[] }> | undefined;
  const ids = new Set(Object.values(profiles ?? {}).flatMap((p) => p.taskIds));
  const tasks: TaskDefinition[] = [];
  for (const id of ids) {
    const directory = join(taskRoot, id);
    const manifest = await json(join(directory, "manifest.json"));
    tasks.push(await validateTaskManifest(manifest, { taskRoot: directory, publicRoot: directory, graderRoot: groundTruthRoot }));
    await access(resolve(directory, (manifest.grader as Json).configFile as string));
  }
  return tasks;
}
async function validate(suitePath: string): Promise<Json> {
  const suite = await json(resolve(suitePath)); const tasks = await loadTasks(suite);
  const checks = []; for (const task of tasks) checks.push(await verifyOracle(task,root));
  return { command: "validate", valid: true, suite: (suite.id as string) ?? suitePath, tasks: checks, adapters: ["codex-raw", "minion-single", "minion-graph"], paidCalls: false };
}
async function plan(suitePath: string, profileName: string, repetitions: number | undefined, destination: string): Promise<Json> {
  const suite = await json(resolve(suitePath)); const profile = (suite.profiles as Record<string, Json> | undefined)?.[profileName];
  if (!profile) throw new Error(`unknown profile: ${profileName}`);
  const allTasks = await loadTasks(suite); const ids = new Set(profile.taskIds as string[]); const tasks = allTasks.filter((task) => ids.has(task.id));
  const reps = repetitions ?? Number(profile.repetitions);
  if (!Number.isInteger(reps) || reps < 1) throw new Error("repetitions must be a positive integer");
  const modes = profile.modes as string[];
  const adapterConfigs: AdapterConfig[] = modes.map((adapterId) => ({ schemaVersion: 1, adapterId, settings: { ...(profile.settings as Record<string, unknown>) ?? {}, ...((profile.modeSettings as Record<string,Record<string,unknown>> | undefined)?.[adapterId] ?? {}) }, requiredCapabilities: [] }));
  if (modes.some(id => id !== "process-fake") && !adapterConfigs.every(c => c.settings.model)) throw new Error("plan requires resolved model settings in profile.settings");
  for (const task of tasks) if (typeof profile.imageDigest === 'string') task.fixture.imageDigest = profile.imageDigest;
  const capabilities = await preflight(adapterConfigs,tasks);
  const implementationDigest = await implementationContent(root);
  const unlocked = { schemaVersion: 1 as const, experimentId: `${String(suite.id)}-${profileName}-${Date.now()}`, taskRevisions: Object.fromEntries(tasks.map((task) => [task.id, task.revision])), adapterConfigs, repetitions: reps, schedulingSeed: hash(`${suite.id}:${profileName}`).slice(0, 24), limits: { aggregateTokenCap: tasks.reduce((n, task) => n + task.limits.maxTotalTokens, 0) * modes.length * reps, storageBytes: 512 * 1024 * 1024 }, provenance: { evaluatorRevision: "0.1.0", implementationDigest, createdAt: new Date().toISOString() } };
  const seeds = Object.fromEntries(tasks.map((task) => [task.id, hash(`${unlocked.experimentId}:${task.id}`).slice(0, 24)]));
  const locked = createImmutablePlan(unlocked, tasks, seeds); const cells = scheduleCells(locked, tasks, seeds);
  destination = await externalRoot(destination, sourceRoot);
  const document = { ...locked, capabilities, fixtureSeeds: seeds, cells, tasks, taskRoots: Object.fromEntries(tasks.map(t => [t.id, join(taskRoot, t.id)])), taskDigests: Object.fromEntries(await Promise.all(tasks.map(async t => [t.id, await taskContent(t, join(taskRoot,t.id))]))) };
  await mkdir(destination, { recursive: true }); await writeFile(join(destination, "experiment.lock.json"), JSON.stringify({ ...document, lockDigest: contentHash(document) }, null, 2), {flag:"wx"});
  return { command: "plan", valid: true, experimentId: locked.experimentId, output: join(destination, "experiment.lock.json"), launchCount: cells.length, aggregateTokenAllowance: locked.limits.aggregateTokenCap, paidCalls: false };
}
async function status(experiment: string): Promise<Json> {
  const directory = resolve(experiment); const store = new ResultStore(join(directory, "state.json"));
  const [runs, results] = await Promise.all([store.listRuns(), store.listResults()]);
  return { command: "status", experiment: directory, runs, results, finalized: runs.filter((run) => run.status === "finalized").length };
}
async function main(): Promise<number> {
  let failureCode: number = exit.invalid;
  try {
    const input = args(process.argv.slice(2));
    if (input.command === "help") { output({ command: "help", commands: ["validate", "plan", "run", "status", "resume", "cancel", "grade", "report", "demo"], structuredOutput: true }); return exit.ok; }
    if (input.command === "validate") { output(await validate(required(input.values, "suite"))); return exit.ok; }
    if (input.command === "plan") { output(await plan(required(input.values, "suite"), required(input.values, "profile"), input.values.has("repetitions") ? Number(required(input.values, "repetitions")) : undefined, required(input.values, "output"))); return exit.ok; }
    if (input.command === "status") { output(await status(required(input.values, "experiment"))); return exit.ok; }
    if (input.command === "report") { output(await report(required(input.values, "experiment"))); return exit.ok; }
    if (["run", "resume", "cancel", "grade", "demo"].includes(input.command)) {
      let directory: string; let lock: OperationalLock;
      if (input.command === "demo") { directory = await externalRoot(required(input.values, "results-root"), sourceRoot); await mkdir(directory, { recursive: true }); lock = await demoLock(directory, Number(input.values.get("delay-ms") ?? 0), Number(input.values.get("timeout-ms") ?? 10000), await implementationContent(root)); }
      else if (input.command === "run") { lock = await json(resolve(required(input.values, "plan"))) as unknown as OperationalLock; verifyLockDigest(lock); const experimentId=ExperimentPlanSchema.shape.experimentId.parse(lock.experimentId); directory = join(await externalRoot(required(input.values, "results-root"), sourceRoot), experimentId); await mkdir(directory, { recursive: true }); await writeFile(join(directory, "experiment.lock.json"), JSON.stringify(lock), { flag: "wx" }); }
      else { directory = await externalRoot(resolve(required(input.values, "experiment")), sourceRoot); lock = await json(join(directory, "experiment.lock.json")) as unknown as OperationalLock; }
      verifyLockDigest(lock);
      if (['run','resume'].includes(input.command) && (lock.provenance as {implementationDigest:string}).implementationDigest !== await implementationContent(root)) throw new Error('evaluator implementation drift');
      const adapters = new Map<string, ExecutionAdapter>([["process-fake", fakeAdapter(directory)]]);
      for (const config of ExperimentPlanSchema.shape.adapterConfigs.parse(lock.adapterConfigs)) if (config.adapterId !== "process-fake") adapters.set(config.adapterId, createExternalAdapter({ ...config, settings: { ...config.settings, stateRoot: join(directory, "adapter-state", config.adapterId) } }));
      if (['run','resume'].includes(input.command)) {
        const current = await preflight(ExperimentPlanSchema.shape.adapterConfigs.parse(lock.adapterConfigs),lock.tasks);
        if (lock.capabilities && contentHash(current)!==contentHash(lock.capabilities)) throw new Error('adapter capability drift');
      }
      failureCode = exit.infrastructure;
      const code = await operate(input.command === "demo" ? "run" : input.command, directory, lock, adapters);
      output({ command: input.command, experiment: directory, exitCode: code, controlledMeasurement: (await new ResultStore(join(directory,"state.json")).listResults()).length > 0 && (await new ResultStore(join(directory,"state.json")).listResults()).every(r => r.controlledMeasurement === true), ...(input.command === "demo" ? { harness: "process-fake", paidCalls: false, report: await report(directory) } : {}) }); return code;
    }
    throw new Error(`unknown command: ${input.command}`);
  } catch (error) { output({ error: error instanceof Error ? error.message : String(error), providerCalls: "unknown" }); return failureCode; }
}
process.exitCode = await main();
