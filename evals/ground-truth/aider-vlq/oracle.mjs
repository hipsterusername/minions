import {readFile} from 'node:fs/promises';
export const schemaVersion = 1;
export const taskId = "aider-vlq";
export const revision = 'r1';
export const testCount = 26;
export async function gradeFiles({execute}) {
  const source = await readFile(new URL('./tests.mjs', import.meta.url), 'utf8');
  let pass = false, observed;
  try {
    // Trusted test source travels over stdin; imports resolve in the candidate cwd.
    // Each grade gets a fresh Node process through the evaluator executor.
    const result = await execute({command:'node', args:['--test-reporter=tap','--input-type=module','-'], stdin:source, timeoutMs:50000});
    const metric = name => {const matches = [...result.stdout.matchAll(new RegExp('^# '+name+' (\\d+)$','gm'))]; return matches.length === 1 ? Number(matches[0][1]) : -1;};
    pass = result.code === 0 && metric('tests') === testCount && metric('pass') === testCount && metric('fail') === 0 && metric('skipped') === 0 && metric('cancelled') === 0;
    observed = `${metric('pass')}/${testCount} tests passed; exit=${result.code}; skipped=${metric('skipped')}; failed=${metric('fail')}`;
  } catch (error) {
    if (error?.kind !== 'candidate' || !['CANDIDATE_TIMEOUT','CANDIDATE_OUTPUT_LIMIT'].includes(error.code)) throw error;
    observed = error.code;
  }
  return [{criterionId:taskId+'.upstream', pass, observed}];
}
