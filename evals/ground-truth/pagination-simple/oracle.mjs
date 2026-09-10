import { isDeepStrictEqual } from 'node:util';
export const schemaVersion = 1;
export const taskId = 'pagination-simple';
export const revision = 'r2';
export const criterionIds = ['pagination.validation', 'pagination.boundaries', 'pagination.order'];

function buildCases(seed) {
  const cases = [];
  const add = (criterionId, name, args, value, error) => cases.push({ criterionId, name, args, expected: error ? { error, unchanged: true } : { value, unchanged: true, fresh: true } });
  const invalid = [-1, 0.5, null, '1', { $number: 'NaN' }, { $number: 'Infinity' }, { $number: 'undefined' }, 9007199254740992];
  for (const bad of invalid) {
    add(criterionIds[0], `bad-page-${JSON.stringify(bad)}`, [[], bad, 2], null, 'RangeError');
    add(criterionIds[0], `bad-size-${JSON.stringify(bad)}`, [[1,2], 0, bad], null, 'RangeError');
  }
  add(criterionIds[0], 'zero-size', [[],0,0], null, 'RangeError');
  let state = [...seed].reduce((x,c) => (Math.imul(x,31) + c.charCodeAt(0)) >>> 0, 17);
  const random = n => { state = (Math.imul(state,1664525) + 1013904223) >>> 0; return state % n; };
  for (const length of [0,1,2,6,20,21,31 + random(19)]) {
    const items = Array.from({length}, (_,i) => ({ id: random(9), position: i, nested: { active: i % 2 === 0 } }));
    for (const size of [1,2,3,7,20,9007199254740991]) {
      for (const page of [0,1,2,Math.ceil(length / size),9007199254740991]) {
        // Independent index-selection specification, no submitted/reference helper.
        const expected = [];
        for (let index = 0; index < length; index++) if (Math.floor(index / size) === page) expected.push(items[index]);
        add(criterionIds[1], `length-${length}-size-${size}-page-${page}`, [items,page,size], expected);
      }
    }
    add(criterionIds[2], `ordered-duplicates-${length}`, [items,0,Math.max(1,length)], items);
    add(criterionIds[2], `beyond-${length}`, [items,999,3], []);
  }
  return cases;
}
// Runs only the public interface inside the submission. Expectations never enter it.
const driver = `import { readFileSync } from 'node:fs';
import { paginate as candidate } from './src/index.mjs';
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
