import { atomicJson } from '../../src/core/durable.js';
import { contentHash } from '../../src/core/plan-lock.js';
import { spawn } from 'node:child_process';
import { cp, symlink, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
const roots: string[] = [];
afterEach(async () => { if(process.env.EVAL_OPERATIONAL_EVIDENCE_ROOT){const target=resolve(process.env.EVAL_OPERATIONAL_EVIDENCE_ROOT);for(const root of roots.splice(0)){await cp(root,join(target,root.split('/').at(-1)!),{recursive:true,filter:path=>!['package','node_modules'].includes(path.split('/').at(-1)!)});await rm(root,{recursive:true,force:true});}}else await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true}))); });
const cli = resolve('dist/src/cli/main.js');
async function root() { const p = await mkdtemp(join(tmpdir(),'eval-cli-test-')); roots.push(p); return p; }
async function launch(args: string[], cwd: string, executable = cli) {
  const out = await open(join(cwd,'command-'+Math.random()+'.log'),'w+');
  const child = spawn(process.execPath,[executable,...args],{cwd,stdio:['ignore',out.fd,out.fd]});
  const completion = new Promise<number|null>((resolve,reject) => {child.once('error',reject);child.once('close',async code=>{await out.close();resolve(code);});});
  return {child,completion};
}
async function run(args: string[], cwd: string) { return (await launch(args,cwd)).completion; }
async function readState(dir: string) {return JSON.parse(await readFile(join(dir,'state.json'),'utf8'));}
async function until<T>(action:()=>Promise<T|undefined>):Promise<T> {for(let i=0;i<300;i++){const result=await action().catch(()=>undefined);if(result!==undefined)return result;await delay(10);}throw new Error('observable state deadline');}
describe('built CLI real execution',()=>{
  it('executes successful and failing cells; resume preserves handles, regrade retains history and report works offline',async()=>{
    const cwd=await root(), dir=join(cwd,'experiment');
    expect(await run(['demo','--results-root',dir],cwd)).toBe(1);
    const first=await readState(dir), results=Object.values(first.results) as any[];
    expect(results.map(r=>r.gradeOutcome)).toEqual(['passed','failed']);
    expect(results.every(r=>r.executionOutcome==='completed'&&r.submission.files.length&&r.grade&&r.usage.totalTokens===3)).toBe(true);
    for(const r of results) {expect(await readFile(join(dir,'runs',r.runId,'submission','answer.mjs'),'utf8')).toMatch(/console.log/);expect(await readFile(join(dir,'runs',r.runId,'changes.patch'),'utf8')).toContain('diff --git');}
    expect(await run(['resume','--experiment',dir],cwd)).toBe(1);
    expect((await readState(dir)).runs).toEqual(first.runs);
    expect(await run(['grade','--experiment',dir],cwd)).toBe(1);
    for(const r of results)expect((await readdir(join(dir,'runs',r.runId,'grades'))).length).toBe(2);
    await rm(join(dir,'demo-fixture'),{recursive:true});await rm(join(dir,'demo-bad-fixture'),{recursive:true});
    expect(await run(['report','--experiment',dir],cwd)).toBe(0);
    const revisions = await readdir(join(dir,'analyses')); expect(revisions).toHaveLength(2);
    expect(await readFile(join(dir,'analyses',revisions[0]!,'report.html'),'utf8')).toContain('process-demo');
    expect(await readdir(join(dir,'isolation'))).toEqual([]);
  });
  it('runs from an independently copied package with results beside the package',async()=>{
    const cwd=await root(),portable=join(cwd,'package');
    await cp(resolve('.'),portable,{recursive:true,filter:path=>!['node_modules','.git','coverage'].includes(path.split('/').at(-1)!)});
    await symlink(resolve('node_modules'),join(portable,'node_modules'),'dir');
    expect(await (await launch(['demo','--results-root',join(cwd,'results')],cwd,join(portable,'dist/src/cli/main.js'))).completion).toBe(1);
    expect(Object.values((await readState(join(cwd,'results'))).results)).toHaveLength(2);
  });
  it.each(['observed','handle-persisted'] as const)('recovers a killed controller at %s without resetting its handle/deadline or relaunching',async(checkpoint)=>{
    const cwd=await root(),dir=join(cwd,'experiment'); const running=await launch(['demo','--results-root',dir,'--delay-ms','700'],cwd);
    const before:any=await until(async()=>{const state=await readState(dir);return Object.values(state.runs).find((r:any)=>r.handle);});
    running.child.kill('SIGKILL'); await running.completion;
    if(checkpoint==='handle-persisted'){
      // Reconstruct the exact durable checkpoint between handle save and running transition.
      const state=await readState(dir);state.runs[before.runId].status='ready';await atomicJson(join(dir,'state.json'),state);
    }
    await atomicJson(join(cwd,'recovery-checkpoint.json'),{checkpoint,before,state:await readState(dir)});
    expect(await run(['resume','--experiment',dir],cwd)).toBe(1);
    const after=(await readState(dir)).runs[before.runId];expect(after.handle).toEqual(before.handle);expect(after.deadline).toBe(before.deadline);
    expect(await readdir(join(dir,'process-handles'))).toHaveLength(2);
  });
  it('cancels persistent processes and does not admit further cells on resume',async()=>{
    const cwd=await root(),dir=join(cwd,'experiment');const running=await launch(['demo','--results-root',dir,'--delay-ms','4000'],cwd);
    await until(async()=>{const state=await readState(dir);return Object.values(state.runs).find((r:any)=>r.handle);});
    expect(await run(['cancel','--experiment',dir],cwd)).toBe(130);expect(await running.completion).toBe(130);
    const state=await readState(dir);expect(Object.values(state.results).map((r:any)=>r.executionOutcome)).toEqual(['cancelled']);
    expect(await run(['resume','--experiment',dir],cwd)).toBe(130);expect(await readdir(join(dir,'process-handles'))).toHaveLength(1);
  });
  it('watchdog stops a silent executable and persists timeout outcomes',async()=>{
    const cwd=await root(),dir=join(cwd,'experiment');expect(await run(['demo','--results-root',dir,'--delay-ms','4000','--timeout-ms','100'],cwd)).toBe(1);
    const state=await readState(dir);expect(Object.values(state.results).map((r:any)=>r.executionOutcome)).toEqual(['timeout','timeout']);expect(Object.values(state.results).every((r:any)=>r.grade && r.submission)).toBe(true);
  });

  it('validates, locks and runs a public task from an external working directory; rejects lock drift',async()=>{
    const cwd=await root(),suite=join(cwd,'suite.json'),planDir=join(cwd,'plan');
    await writeFile(suite,JSON.stringify({id:'harness-suite',profiles:{harness:{taskIds:['pagination-simple'],modes:['process-fake'],repetitions:1,settings:{profile:'local-development',command:[process.execPath,'-e','console.log("fixture process launched")']}}}}));
    expect(await run(['validate','--suite',suite],cwd)).toBe(0);
    expect(await run(['plan','--suite',suite,'--profile','harness','--output',planDir],cwd)).toBe(0);
    const path=join(planDir,'experiment.lock.json'),lock=JSON.parse(await readFile(path,'utf8'));
    expect(await run(['run','--plan',path,'--results-root',join(cwd,'results')],cwd)).toBe(1);
    const state=await readState(join(cwd,'results',lock.experimentId));expect(Object.values(state.results).every((r:any)=>r.grade && r.executionOutcome==='completed')).toBe(true);
    lock.repetitions=2;await writeFile(path,JSON.stringify(lock));expect(await run(['run','--plan',path,'--results-root',join(cwd,'drift-results')],cwd)).toBe(2);
    lock.experimentId='../escaped';delete lock.lockDigest;lock.lockDigest=contentHash(lock);await writeFile(path,JSON.stringify(lock));
    expect(await run(['run','--plan',path,'--results-root',join(cwd,'unsafe-results')],cwd)).toBe(2);
    await expect(readdir(join(cwd,'unsafe-results'))).rejects.toMatchObject({code:'ENOENT'});
  });

});
