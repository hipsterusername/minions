import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { CandidateLimitError, GraderInfrastructureError, infrastructureError, isCandidateLimit } from "./errors.js";
export { CandidateLimitError, GraderInfrastructureError } from "./errors.js";
import type { Grader } from "../core/contracts.js";
import type { TaskDefinition } from "../../schemas/index.js";
export interface ExecuteRequest { command: string; args?: readonly string[]; cwd?: string; stdin?: string; timeoutMs?: number; signal?: AbortSignal; }
export interface ExecuteResult { code: number; stdout: string; stderr: string; }
export type GraderExecutor = (request: ExecuteRequest) => Promise<ExecuteResult>;
export function processExecutor(defaultCwd: string, timeoutMs: number, docker?: { containerName: string; workdir: string }): GraderExecutor {
  async function run(request: ExecuteRequest, inContainer = !!docker): Promise<ExecuteResult> {
    const temporary = await mkdtemp(join(tmpdir(), "eval-grader-"));
    const handles: Awaited<ReturnType<typeof open>>[] = [];
    const file = async (name: string, flags: string) => { const handle = await open(join(temporary,name),flags); handles.push(handle); return handle; };
    try {
      const stdin = await file('stdin','w+'), out = await file('stdout','w+'), err = await file('stderr','w+');
      await stdin.writeFile(request.stdin ?? '');
      // Reopen at offset zero for the child's regular-file stdin.
      const input = await file('stdin','r');
      return await new Promise<ExecuteResult>((resolve,reject) => {
        const args = inContainer ? ["exec", "-i", "--workdir", docker!.workdir, docker!.containerName, request.command, ...(request.args ?? [])] : [...(request.args ?? [])];
        const child = spawn(inContainer ? "docker" : request.command,args,{cwd:inContainer ? undefined : request.cwd ?? defaultCwd,detached:true,env:{PATH:process.env.PATH,LANG:'C.UTF-8'},stdio:[input.fd,out.fd,err.fd]});
        let failure: Error | undefined;
        const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} };
        const abort = () => { failure = new GraderInfrastructureError('GRADER_WATCHDOG','overall grading watchdog expired'); kill(); };
        const timer = setTimeout(() => { failure ??= new CandidateLimitError('CANDIDATE_TIMEOUT','candidate command timeout'); kill(); },Math.min(timeoutMs,request.timeoutMs ?? timeoutMs));
        const sizeCheck = setInterval(() => { void Promise.all([out.stat(),err.stat()]).then(([a,b]) => {
          if (a.size+b.size > 1024*1024) { failure ??= new CandidateLimitError('CANDIDATE_OUTPUT_LIMIT','candidate output limit'); kill(); }
        }).catch(error => { failure = infrastructureError(error); kill(); }); },10);
        request.signal?.addEventListener('abort',abort,{once:true});
        if (request.signal?.aborted) abort();
        const clear = () => { clearTimeout(timer); clearInterval(sizeCheck); request.signal?.removeEventListener('abort',abort); };
        child.once('error',error => { clear(); reject(infrastructureError(error)); });
        child.once('close',code => {
          clear(); kill();
          void (async () => {
            if (failure) throw failure;
            const sizes = await Promise.all([out.stat(),err.stat()]);
            if (sizes[0].size+sizes[1].size > 1024*1024) throw new CandidateLimitError('CANDIDATE_OUTPUT_LIMIT','candidate output limit');
            const [stdout,stderr] = await Promise.all(['stdout','stderr'].map(name => readFile(join(temporary,name),'utf8')));
            return {code:code ?? 1,stdout:stdout!,stderr:stderr!};
          })().then(resolve,reject);
        });
      });
    } finally {
      await Promise.all(handles.map(handle => handle.close()));
      await rm(temporary,{recursive:true,force:true});
    }
  }
  // Docker's own failures share candidate exit codes. Probe trusted availability
  // before execution and after nonzero exits; never classify candidate log text.
  async function preflight(request: ExecuteRequest) {
    try {
      const result = await run({command:'sh',args:['-c','command -v "$1" >/dev/null','grader-preflight',request.command],timeoutMs:5000,signal:request.signal});
      if (result.code !== 0) throw new Error('container or command unavailable: '+result.stderr.slice(0,500));
    } catch(error) { if ((error as GraderInfrastructureError)?.code === 'GRADER_WATCHDOG') throw error; throw new GraderInfrastructureError('GRADER_PREFLIGHT','executor environment preflight failed: '+String(error),{cause:error}); }
  }
  return async request => {
    try {
      if (docker) await preflight(request);
      const result = await run(request);
      if (docker && result.code !== 0) await preflight(request);
      return result;
    } catch(error) { if (isCandidateLimit(error)) { if (docker) await preflight(request); throw error; } throw infrastructureError(error); }
  };
}
/** Only trusted oracle modules load here; candidate code runs solely through the executor. */
export function fileGrader(task: TaskDefinition, oraclePath: string, submissionRoot: string, seed: string, execute: GraderExecutor): Grader {
  return { id: task.grader.id, version: "1", async grade(input, context) {
    const oracle = await import(pathToFileURL(oraclePath).href);
    if (typeof oracle.gradeFiles !== "function") throw new Error("oracle must export executor-backed gradeFiles");
    let calls = 0; const deadline = Date.now() + context.timeoutMs; const controller = new AbortController();
    const guardedExecute: GraderExecutor = async request => {
      if (Date.now() >= deadline || controller.signal.aborted) throw new GraderInfrastructureError('GRADER_WATCHDOG','overall grading watchdog expired');
      calls++;
      try { return await execute({...request,signal:controller.signal}); }
      catch(error) { if (isCandidateLimit(error)) throw error; throw infrastructureError(error); }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let verdicts;
    try { verdicts = await Promise.race([oracle.gradeFiles({ submissionRoot, seed, execute: guardedExecute }), new Promise((_,reject) => { timer = setTimeout(() => { controller.abort(); reject(new GraderInfrastructureError("GRADER_WATCHDOG","overall grading watchdog expired")); }, context.timeoutMs); })]); }
    finally { if (timer) clearTimeout(timer); controller.abort(); }
    if (!calls) throw new Error("gradeFiles did not execute a submission process");
    if (!Array.isArray(verdicts)) throw new Error("malformed gradeFiles verdicts");
    const criteria = task.criteria.map(criterion => { const verdict = verdicts.find(v => v.criterionId === criterion.id); return { criterionId: criterion.id, verdict: verdict?.pass === true ? "pass" as const : "fail" as const, expectedEvidence: null, observedEvidence: String(verdict?.observed ?? "missing criterion"), logReferences: [] }; });
    const passed = criteria.every(c => c.verdict === "pass");
    return { schemaVersion: 1, gradeId: randomUUID(), graderId: task.grader.id, graderVersion: "1", graderRevision: task.grader.revision, submissionHash: input.submissionHash, outcome: passed ? "passed" : "failed", criteria, regressionPassed: passed, metrics: [], logReferences: [] };
  } };
}
