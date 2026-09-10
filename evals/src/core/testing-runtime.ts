/** Credential-free harness check: real executable/file output; never a benchmark model. */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExecutionAdapter, StopReason } from "./contracts.js";
import type { ParticipantRunSpec, RunHandle, RunEvent } from "../../schemas/index.js";
import { alive, atomicJson, locked, safeId } from "./durable.js";
import { freezeSubmission } from "../isolation/public-fixture.js";

const supervisor = String.raw`
const fs = require('node:fs'); const cp = require('node:child_process'); const path = require('node:path');
const dir = process.argv[1]; const spec = JSON.parse(fs.readFileSync(path.join(dir,'launch.json'),'utf8'));
function save(name, value) { const p=path.join(dir,name); fs.writeFileSync(p+'.tmp',JSON.stringify(value)); fs.renameSync(p+'.tmp',p); }
const out=fs.openSync(path.join(dir,'stdout.jsonl'),'a'), err=fs.openSync(path.join(dir,'stderr.log'),'a');
const child=cp.spawn(spec.command,spec.args,{cwd:spec.cwd,detached:true,stdio:['ignore',out,err],env:{PATH:process.env.PATH,HOME:spec.home}});
save('pid.json',{pid:child.pid,supervisor:process.pid});
child.on('error', e => save('exit.json',{code:127,error:e.message}));
child.on('exit',(code,signal)=>{try{process.kill(-child.pid,'SIGKILL')}catch{};save('exit.json',{code,signal});});
`;
export class ProcessFakeAdapter implements ExecutionAdapter {
  readonly id = "process-fake"; readonly version = "1";
  constructor(readonly stateRoot: string) {}
  async preflight() { return { schemaVersion: 1 as const, adapterId: this.id, adapterVersion: this.version, supported: true, capabilities: { filesystem: true, recovery: true, controlled_isolation: false }, limitations: ["credential-free process harness; local development is ineligible for controlled measurement"], evidence: [process.execPath] }; }
  private directory(handle: RunHandle) { if (handle.adapterId !== this.id) throw new Error("adapter mismatch"); return join(this.stateRoot, safeId(handle.runId)); }
  async start(run: ParticipantRunSpec): Promise<RunHandle> {
    const dir = join(this.stateRoot, safeId(run.runId)); await mkdir(dir, { recursive: true });
    return locked(join(dir, "admission"), async () => {
      try { return JSON.parse(await readFile(join(dir, "handle.json"), "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      const handle: RunHandle = { schemaVersion: 1, adapterId: this.id, handleId: run.idempotencyKey, runId: run.runId, createdAt: new Date().toISOString() };
      const command = run.configuration.command;
      if (!Array.isArray(command) || !command.length || !command.every(x => typeof x === "string")) throw new Error("process-fake requires an explicit executable command");
      const execution = run.configuration.execution as {kind?:string;containerName?:string;workdir?:string} | undefined;
      const launch = execution?.kind === "docker" ? {command:"docker",args:["exec","--workdir",execution.workdir!,execution.containerName!,...command]} : {command:command[0],args:command.slice(1)};
      await atomicJson(join(dir, "launch.json"), { ...launch, cwd: run.workspace.mountPath, home: join(dir, "home") });
      // A persisted intent fences uncertain launch: subsequent starts only return the same handle.
      await atomicJson(join(dir, "handle.json"), handle);
      const child = spawn(process.execPath, ["-e", supervisor, dir], { detached: true, stdio: "ignore" }); child.unref();
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      await atomicJson(join(dir, "supervisor.json"), { pid: child.pid });
      return handle;
    });
  }
  async *observe(handle: RunHandle, afterSequence = -1): AsyncIterable<RunEvent> {
    let cursor = afterSequence;
    while (true) {
    const terminal = (await this.inspect(handle)).state === "terminal";
    const text = await readFile(join(this.directory(handle), "stdout.jsonl"), "utf8").catch(() => "");
    const lines = text.split("\n"); lines.pop();
    for (let sequence = 0; sequence < lines.length; sequence++) { if (sequence <= cursor) continue; cursor = sequence; let payload: Record<string, unknown>; try { payload = JSON.parse(lines[sequence]!); } catch { payload = { error: "malformed participant output" }; }
      yield { schemaVersion: 1, eventId: handle.runId + ":output:" + sequence, experimentId: "process-fake", runId: handle.runId, sequence, observedAt: new Date().toISOString(), providerTimestamp: null, adapterId: this.id, participantId: handle.runId, sessionId: handle.handleId, turnId: null, type: payload.type === "usage" ? "usage" : "error", payload };
    }
    if (terminal) return;
    await delay(20);
    }
  }
  async inspect(handle: RunHandle) {
    const dir = this.directory(handle); const exit = await readFile(join(dir, "exit.json"), "utf8").then(JSON.parse).catch(() => null);
    const pid = await readFile(join(dir, "supervisor.json"), "utf8").then(JSON.parse).catch(() => null);
    const stop = await readFile(join(dir, "stop.json"), "utf8").then(JSON.parse).catch(() => null);
    const terminal = !!exit || (!!pid && !alive(pid.pid));
    const outcome = stop?.reason ?? (exit ? exit.code === 0 ? "completed" : "failed" : "interrupted");
    return { schemaVersion: 1 as const, handle, state: terminal ? "terminal" as const : pid ? "running" as const : "unknown" as const, terminalOutcome: terminal ? outcome : null, participants: [], observedAt: new Date().toISOString() };
  }
  async stop(handle: RunHandle, reason: StopReason) {
    const dir = this.directory(handle); await atomicJson(join(dir, "stop.json"), { reason });
    const pid = await readFile(join(dir, "pid.json"), "utf8").then(JSON.parse).catch(() => null);
    if (pid?.pid) { try { process.kill(-pid.pid, "SIGTERM"); } catch {} await delay(50); try { process.kill(-pid.pid, "SIGKILL"); } catch {} }
    return { schemaVersion: 1 as const, handle, reason, accepted: true, stoppedAt: new Date().toISOString(), descendantsAccountedFor: !!pid };
  }
  async collect(handle: RunHandle) {
    const launch = JSON.parse(await readFile(join(this.directory(handle), "launch.json"), "utf8"));
    const files = await freezeSubmission(launch.cwd, 16 * 1024 * 1024);
    return { schemaVersion: 1 as const, handle, artifacts: files.files, provenance: { harness: "process-fake", controlledIsolation: false }, usageCoverage: "complete" as const, logTruncated: false };
  }
}
