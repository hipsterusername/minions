import { isDeepStrictEqual } from 'node:util';
export const schemaVersion = 1;
export const taskId = 'status-filter-simple';
export const revision = 'r2';
export const criterionIds = ['status-filter.values', 'status-filter.baseline', 'status-filter.pagination'];

function buildCases(seed) {
  const cases = [];
  const add = (criterionId, name, args, value, error) => cases.push({ criterionId, name, args, expected: error ? { error, unchanged: true } : { value, unchanged: true, fresh: true } });
  let state = [...seed].reduce((x,c) => (Math.imul(x,31) + c.charCodeAt(0)) >>> 0, 91);
  const random = n => { state = (Math.imul(state,1664525) + 1013904223) >>> 0; return state % n; };
  const rows = Array.from({length: 47}, (_,i) => ({id: `duplicate-${random(7)}`, status: ['open','closed','pending'][random(3)], position:i, extra:{keep:true}}));
  for (const status of ['deleted','OPEN','',null,0,false,[],{}]) add(criterionIds[0], `invalid-status-${JSON.stringify(status)}`, [[], {status}], null, 'RangeError');
  for (const key of ['page','pageSize']) {
    for (const bad of [-1,0.25,null,'2',{$number:'NaN'},{$number:'Infinity'},9007199254740992, ...(key === 'pageSize' ? [0] : [])]) {
      add(criterionIds[0], `invalid-${key}-${JSON.stringify(bad)}`, [rows,{[key]:bad}], null,'RangeError');
    }
  }
  const selected = (records,status,page,size) => {
    const result = []; let rank = 0;
    for (const row of records) if (status === undefined || row.status === status) {
      if (Math.floor(rank / size) === page) result.push(row);
      rank++;
    }
    return result;
  };
  add(criterionIds[1], 'omitted-options', [rows], selected(rows,undefined,0,20));
  add(criterionIds[1], 'explicit-undefined-defaults', [rows,{status:{$number:'undefined'},page:{$number:'undefined'},pageSize:{$number:'undefined'}}], selected(rows,undefined,0,20));
  for (const records of [[],rows]) for (const page of [0,1,2,99,9007199254740991]) for (const pageSize of [1,3,20,9007199254740991]) {
    add(criterionIds[1], `baseline-${records.length}-${page}-${pageSize}`, [records,{page,pageSize,unknown:'ignored'}], selected(records,undefined,page,pageSize));
    for (const status of ['open','closed','pending']) add(criterionIds[2], `${status}-${records.length}-${page}-${pageSize}`, [records,{status,page,pageSize}], selected(records,status,page,pageSize));
  }
  return cases;
}
// Runs only the public interface inside the submission. Expectations never enter it.
const driver = `import { readFileSync } from 'node:fs';
import { list as candidate } from './src/index.mjs';
const cases = JSON.parse(readFileSync(0,'utf8'), (_,v) => v && typeof v === 'object' && '$number' in v ? ({NaN:NaN,Infinity:Infinity,undefined:undefined})[v.$number] : v);
const results = cases.map(args => {
  const before = JSON.stringify(args);
  try { const value = candidate(...args); return { value, unchanged: before === JSON.stringify(args), fresh: value !== args[0] }; }
  catch (error) { return { error: error.name, unchanged: before === JSON.stringify(args) }; }
});
process.stdout.write(JSON.stringify(results));`;

export async function gradeFiles({ execute, seed = 'hidden-default' }) {
  const cases = buildCases(String(seed));
  let actual = [], failure = '';
  try {
    const result = await candidateExecute(execute, { command: 'node', args: ['--input-type=module', '-e', driver], stdin: JSON.stringify(cases.map(c => c.args)), timeoutMs: 5000 });
    if (result.code !== 0 || result.stderr !== '') throw new Error('nonzero exit or unexpected stderr');
    actual = JSON.parse(result.stdout);
    if (!Array.isArray(actual) || actual.length !== cases.length) throw new Error('invalid response count');
  } catch (error) { if (error?.kind === 'grader-infrastructure') throw error; failure = String(error.message ?? error); }
  return criterionIds.map(criterionId => {
    const checks = cases.map((c,i) => ({c,i})).filter(({c}) => c.criterionId === criterionId);
    const failed = checks.filter(({c,i}) => failure || !isDeepStrictEqual(actual[i], c.expected));
    return { criterionId, pass: failed.length === 0, observed: failure || `${checks.length - failed.length}/${checks.length} subprocess cases passed; failures: ${failed.map(({c}) => c.name).join(', ')}` };
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
