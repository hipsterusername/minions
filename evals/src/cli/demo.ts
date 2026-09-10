import { contentHash, implementationContent } from "../core/plan-lock.js";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson } from "../core/durable.js";
import type { OperationalLock } from "./operations.js";
import type { TaskDefinition } from "../../schemas/index.js";
/** A tiny owned harness fixture. Success requires executing answer.mjs; it is not synthetic result JSON. */
export async function demoLock(directory: string, delayMs = 0, timeoutMs = 10000, implementationDigest = "demo-harness"): Promise<OperationalLock> {
  if (await access(join(directory,"experiment.lock.json")).then(()=>true,()=>false)) throw new Error("demo requires a fresh directory");
  const taskRoot = join(directory, "demo-fixture"); await mkdir(join(taskRoot, "starter"), { recursive: true });
  await writeFile(join(taskRoot, "fixture.mjs"), 'import {readFile} from "node:fs/promises"; export async function build(){return {schemaVersion:1,taskId:"process-demo",files:{"answer.mjs":await readFile(new URL("./starter/answer.mjs",import.meta.url),"utf8")}};}');
  await writeFile(join(taskRoot, "prompt.md"), "Write answer.mjs that prints 42.");
  await writeFile(join(taskRoot, "starter", "answer.mjs"), 'console.log(0)');
  await writeFile(join(taskRoot, "oracle.mjs"), 'export async function gradeFiles({submissionRoot,execute}) { const r=await execute({command:"node",args:["answer.mjs"],cwd:submissionRoot}); return [{criterionId:"answer.correct",pass:r.code===0&&r.stdout.trim()==="42",observed:r.stdout.trim()}]; }');
  const task: TaskDefinition = { schemaVersion: 1, id: "process-demo", revision: "1", family: "harness", difficulty: "simple", promptFile: "prompt.md", fixture: { builderId: "demo", configFile: "fixture.mjs", imageDigest: "node:22-alpine" }, requiredCapabilities: ["filesystem"], submission: { include: ["**"], exclude: [], maxBytes: 65536 }, criteria: [{ id: "answer.correct", description: "Print 42", mandatory: true }], grader: { id: "demo", revision: "1", configFile: "oracle.mjs" }, limits: { maxTotalTokens: 100, executionTimeoutMs: timeoutMs, preparationTimeoutMs: 1000, gradingTimeoutMs: 1000 } };
  const experimentId = "demo-" + randomUUID();
  const usage = { schemaVersion: 1, sourceId: "fixture-turn", participantId: null, turnId: "turn-1", observationKind: "turn_snapshot", inputTokensTotal: 2, inputTokensUncached: 2, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokensTotal: 1, reasoningTokens: null, totalTokens: 3, reportedCostUSD: null, estimatedCostUSD: null, coverage: "complete", coverageReasons: ["fixture counters, not model usage"] };
  const command = [process.execPath, "-e", 'const fs=require("node:fs");const path=require("node:path");const dir=process.cwd();const count=Number(fs.readFileSync(path.join(dir,"answer.mjs"),"utf8").match(/\\d+/)[0]);setTimeout(()=>{fs.writeFileSync("answer.mjs","console.log("+(count===0?42:0)+")");console.log('+JSON.stringify(JSON.stringify({type:"usage",usage}))+');},'+delayMs+');'];
  // Two modes use the same named process adapter with explicit task fixture variants via separate tasks.
  const badRoot = join(directory, "demo-bad-fixture"); await mkdir(join(badRoot, "starter"), {recursive:true});
  await writeFile(join(badRoot,"starter","answer.mjs"), 'console.log(1)'); await writeFile(join(badRoot,"prompt.md"), "Write answer.mjs that prints 42."); await writeFile(join(badRoot,"oracle.mjs"), 'export {gradeFiles} from "../demo-fixture/oracle.mjs";');
  await writeFile(join(badRoot,"fixture.mjs"), 'import {readFile} from "node:fs/promises"; export async function build(){return {schemaVersion:1,taskId:"process-demo-bad",files:{"answer.mjs":await readFile(new URL("./starter/answer.mjs",import.meta.url),"utf8")}};}');
  const bad = {...task,id:"process-demo-bad"};
  const lock: OperationalLock = { schemaVersion: 1, experimentId, taskRevisions: {[task.id]:"1",[bad.id]:"1"}, adapterConfigs: [{schemaVersion:1,adapterId:"process-fake",settings:{command,profile:"local-development"},requiredCapabilities:[]}], repetitions:1,schedulingSeed:"demo",limits:{aggregateTokenCap:100,storageBytes:1048576},provenance:{evaluatorRevision:"0.1.0",implementationDigest,createdAt:new Date().toISOString()}, tasks:[task,bad],taskRoots:{[task.id]:taskRoot,[bad.id]:badRoot}, fixtureSeeds:{[task.id]:"demo",[bad.id]:"demo"},cells:[task,bad].map(t=>({schemaVersion:1,cellId:t.id+":process-fake:0",experimentId,taskId:t.id,adapterId:"process-fake",repetition:0,fixtureSeed:"demo",status:"planned"})) };
  lock.lockDigest = contentHash(lock);
  await atomicJson(join(directory,"experiment.lock.json"),lock); return lock;
}
