import { cases } from './cases.mjs';
export const schemaVersion = 1;
export const taskId = 'reconciliation-complex';
export const revision = 'r2';
export const criterionIds = ['reconciliation.joins','reconciliation.deduplication','reconciliation.rates','reconciliation.rounding','reconciliation.refunds','reconciliation.io'];
// This subprocess only receives inputs. Expected values remain in this controller.
// Inherit regular-file stdio to support restricted hosts as well as docker exec.
const driver = `
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const data=JSON.parse(readFileSync(0,'utf8'));
const dir=mkdtempSync(join(tmpdir(),'reconciliation-input-'));
try {
  const names=['orders','payments','refunds','rates'];
  const contents=names.map(n=>data.raw?.[n] ?? JSON.stringify(data.input[n]));
  const paths=names.map((n,i)=>{const p=join(dir,n+' input.json');writeFileSync(p,contents[i]);return p;});
  const args=[...paths];
  if(data.omitArgument) args.pop();
  if(data.extraArgument) args.push('extra');
  if(data.missingFile) args[0]=join(dir,'missing.json');
  const result=spawnSync(process.execPath,[resolve('src/index.mjs'),...args],{stdio:['ignore',1,2],timeout:4000});
  const unchanged=paths.every((p,i)=>readFileSync(p,'utf8')===contents[i]);
  process.exitCode=unchanged ? (result.status ?? 99) : 99;
} finally {rmSync(dir,{recursive:true,force:true});}
`;
export async function gradeFiles({execute,seed='hidden-default'}) {
  const checks=[];
  for (const test of cases(String(seed))) {
    let pass=false;
    try {
      const {input,raw,omitArgument,extraArgument,missingFile}=test;
      const result=await candidateExecute(execute, {command:'node',args:['--input-type=module','-e',driver],
        stdin:JSON.stringify({input,raw,omitArgument,extraArgument,missingFile}),timeoutMs:5000});
      pass=result.code===test.code && result.stdout===test.expected &&
        (test.code===0 ? result.stderr==='' : result.stderr.length>0);
    } catch (error) {
      if (error?.kind === 'grader-infrastructure') throw error;
      // Candidate command limits are task failures.
      return criterionIds.map(criterionId=>({criterionId,pass:false,observed:`subprocess unavailable: ${String(error.message).slice(0,200)}`}));
    }
    checks.push({criterion:test.criterion,name:test.name,pass});
  }
  return criterionIds.map(criterionId=>{
    const relevant=checks.filter(c=>c.criterion==='all' || criterionId===`reconciliation.${c.criterion}`);
    const failed=relevant.filter(c=>!c.pass);
    return {criterionId,pass:failed.length===0,observed:`${relevant.length-failed.length}/${relevant.length} exact subprocess cases passed; failures: ${failed.map(c=>c.name).join(', ')}`};
  });
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
