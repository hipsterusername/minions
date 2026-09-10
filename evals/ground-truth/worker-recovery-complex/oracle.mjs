import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
export const revision = 'r2';
export const criterionIds = ['worker.claim-lease', 'worker.restart', 'worker.idempotency'];

// This trusted subprocess only transports inputs and reads bytes. It never
// imports participant code or computes expected results. File stdio works on
// restricted hosts as well as through the foundation Docker executor.
const driver = `
import {readFileSync,writeFileSync,mkdirSync,rmSync,openSync,closeSync,statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
const input=JSON.parse(readFileSync(0,'utf8'));
const {directory,action}=input;
if(action==='init') { mkdirSync(directory); writeFileSync(join(directory,'state.json'),JSON.stringify(input.state)); }
if(action==='remove') { rmSync(directory,{recursive:true,force:true}); console.log('{}'); }
else {
 let worker=null;
 if(action==='run') {
  writeFileSync(join(directory,'input'),JSON.stringify(input.request));
  const fds=[openSync(join(directory,'input'),'r'),openSync(join(directory,'out'),'w'),openSync(join(directory,'err'),'w')];
  let result;
  try { result=spawnSync(process.execPath,['src/index.mjs'],{stdio:fds,timeout:3000,killSignal:'SIGKILL'}); }
  finally {fds.forEach(closeSync);}
  if(result.error) throw result.error;
  if(statSync(join(directory,'out')).size>65536 || statSync(join(directory,'err')).size>65536) throw Error('worker output limit');
  worker={code:result.status,signal:result.signal,pid:result.pid,stdout:readFileSync(join(directory,'out'),'utf8')};
 }
 console.log(JSON.stringify({worker,state:JSON.parse(readFileSync(join(directory,'state.json'),'utf8'))}));
}
`;

function seeded(seed) {
  let n = [...String(seed)].reduce((x,c) => (Math.imul(x,31) + c.charCodeAt(0)) >>> 0, 17);
  return () => { n = (Math.imul(n,1664525) + 1013904223) >>> 0; return n; };
}
function initial(random, failures = 0) {
  return { jobs: Array.from({length: 3 + random() % 3}, (_, i) => ({
    id: `work-${random().toString(16)}-${i}`, value: random() % 2001 - 1000,
    failures: i === 0 ? failures : 0, status: 'ready', attempts: 0,
    availableAt: 0, leaseUntil: null,
  })), effects: [] };
}
// Controller-owned state-machine specification, independent of submitted files.
// Each transition describes a persisted boundary. No participant helpers run here.
function transition(before, request) {
  const state = structuredClone(before);
  const {now,leaseMs,retryMs,crashAt} = request;
  let killed = false;
  for (let i = 0; i < state.jobs.length; i++) {
    const old = state.jobs[i];
    const eligible = old.status === 'ready' ? old.availableAt <= now
      : old.status === 'claimed' && old.leaseUntil <= now;
    if (!eligible) continue;
    const claimed = {...old, attempts: old.attempts + 1, status: 'claimed', leaseUntil: now + leaseMs};
    state.jobs[i] = claimed;
    if (crashAt === 'after-claim') { killed = true; break; }
    if (claimed.attempts <= old.failures) {
      state.jobs[i] = {...claimed, status: 'ready', leaseUntil: null, availableAt: now + retryMs};
      continue;
    }
    if (crashAt === 'before-effect') { killed = true; break; }
    const keys = new Set(state.effects.map(entry => entry.jobId));
    if (!keys.has(old.id)) state.effects = [...state.effects, {jobId: old.id, value: old.value}];
    if (crashAt === 'after-effect') { killed = true; break; }
    state.jobs[i] = {...claimed, status: 'done', leaseUntil: null};
  }
  return {state,killed};
}

export async function gradeFiles({execute, seed = 'hidden-worker-default'}) {
  const failures = Object.fromEntries(criterionIds.map(id => [id, []]));
  const record = (id, pass, label) => { if (!pass) failures[id].push(label); };
  const random = seeded(seed);
  let launches = 0;
  const directories = [];
  async function invoke(input) {
    const result = await candidateExecute(execute, {command:'node', args:['--input-type=module','-e',driver], stdin:JSON.stringify(input), timeoutMs:5000});
    if (result.code !== 0) throw new Error(`transport exit ${result.code}: ${result.stderr.slice(0,200)}`);
    return JSON.parse(result.stdout);
  }
  try {
    const leaseMs = 11 + random() % 17, retryMs = 7 + random() % 11;
    const cases = ['after-claim','before-effect','after-effect','retry','empty'];
    for (const name of cases) {
      const directory = `.worker-grade-${randomUUID()}`;
      directories.push(directory);
      let expected = name === 'empty' ? {jobs:[],effects:[]} : initial(random, name === 'retry' ? 2 : 0);
      await invoke({action:'init', directory, state:expected});
      const steps = name === 'empty' ? [{now:0},{now:100}]
        : name === 'retry' ? [{now:0},{now:retryMs-1},{now:retryMs},{now:2*retryMs-1},{now:2*retryMs},{now:1000}]
        : [{now:0,crashAt:name},{now:leaseMs-1},{now:leaseMs,crashAt:name},
          {now:2*leaseMs-1},{now:2*leaseMs},{now:1000}];
      for (const step of steps) {
        const request = {directory,leaseMs,retryMs,...step};
        const predicted = transition(expected, request);
        const result = await invoke({action:'run',directory,request});
        launches++;
        const {worker,state} = result;
        const label = `${name}@${step.now}${step.crashAt ? ':crash' : ''}`;
        const validExit = predicted.killed ? worker.signal === 'SIGKILL' && worker.code === null
          : worker.code === 0 && worker.signal === null && JSON.parse(worker.stdout).pid === worker.pid;
        record('worker.restart', validExit, `${label}: process termination/exit`);
        // Exact persisted claim counters, readiness times and done states expose
        // early reclaims, omitted retries, loss and premature acknowledgements.
        record('worker.claim-lease', isDeepStrictEqual(state.jobs, predicted.state.jobs), `${label}: claim/retry state`);
        record('worker.restart', Array.isArray(state.jobs) && state.jobs.length === expected.jobs.length &&
          state.jobs.every((job,i) => job.id === predicted.state.jobs[i].id && job.status === predicted.state.jobs[i].status), `${label}: job recovery`);
        record('worker.idempotency', isDeepStrictEqual(state.effects, predicted.state.effects), `${label}: committed journal`);
        expected = predicted.state;
      }
    }
  } catch (error) {
    if (error?.kind === 'grader-infrastructure') throw error;
    for (const id of criterionIds) failures[id].push(`execution failure: ${String(error).slice(0,300)}`);
  } finally {
    for (const directory of directories) {
      try { await invoke({action:'remove',directory}); }
      catch (error) { if (error?.kind === 'grader-infrastructure') throw error; for (const id of criterionIds) failures[id].push('cleanup failed'); }
    }
  }
  return criterionIds.map(criterionId => ({criterionId,pass:failures[criterionId].length === 0,
    observed: failures[criterionId].length ? failures[criterionId].join('; ') : `${launches} real worker launches: crash boundaries, lease equality, retries, empty queue and stable completion passed`}));
}

// Only these executor errors describe candidate limits. Unknown faults must escape
// scoring. Stable fields work in native .mjs without importing evaluator TS.
async function candidateExecute(execute, request) {
  try { return await execute(request); }
  catch (error) {
    if (error?.kind === 'candidate' && ['CANDIDATE_TIMEOUT','CANDIDATE_OUTPUT_LIMIT'].includes(error.code)) throw error;
    if (error?.kind === 'grader-infrastructure') throw error;
    throw Object.assign(new Error(String(error?.message ?? error), {cause:error}), {kind:'grader-infrastructure',code:'GRADER_EXECUTOR'});
  }
}
