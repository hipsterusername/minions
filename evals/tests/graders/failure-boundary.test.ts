import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { processExecutor, fileGrader } from '../../src/graders/executor.js';
import { TaskDefinitionSchema } from '../../schemas/index.js';
const root = resolve(import.meta.dirname, '../..');
const ids = ['pagination-simple', 'status-filter-simple', 'orders-report-simple', 'reconciliation-complex', 'worker-recovery-complex', 'project-archive-complex'];
for (const id of ids) {
  it(`${id}: propagates actual executor launch faults and unknown boundary faults`, async () => {
    const oracle = await import(`${root}/ground-truth/${id}/oracle.mjs`);
    const execute = processExecutor(root, 1000);
    await expect(oracle.gradeFiles({execute: () => execute({command:'/nonexistent-eval-runtime'})})).rejects.toMatchObject({kind:'grader-infrastructure'});
    await expect(oracle.gradeFiles({execute: async () => { throw Error('unrecognized executor failure'); }})).rejects.toMatchObject({kind:'grader-infrastructure'});
  });
}
it('separates real candidate command timeout and output cap from launch faults', async () => {
  const execute = processExecutor(root, 1000);
  await expect(execute({command:'node', args:['-e','while(true) {}'], timeoutMs:50})).rejects.toMatchObject({kind:'candidate',code:'CANDIDATE_TIMEOUT'});
  await expect(execute({command:'node', args:['-e',"process.stdout.write('x'.repeat(1100000))"]})).rejects.toMatchObject({kind:'candidate',code:'CANDIDATE_OUTPUT_LIMIT'});
});
it('uses an infrastructure watchdog even when a command has a longer candidate budget', async () => {
  const task = TaskDefinitionSchema.parse(JSON.parse(await readFile(`${root}/tasks/pagination-simple/manifest.json`,'utf8')));
  const grader = fileGrader(task,`${root}/ground-truth/pagination-simple/oracle.mjs`,root,'seed',processExecutor(root,1000));
  await expect(grader.grade({schemaVersion:1,submissionHash:'a'.repeat(64),rootDigest:'a'.repeat(64),files:[],capturedAt:new Date().toISOString()}, {schemaVersion:1,taskId:task.id,graderRevision:'r2',timeoutMs:0,environment:{}})).rejects.toMatchObject({kind:'grader-infrastructure',code:'GRADER_WATCHDOG'});
});
for (const id of ids) {
  for (const [name, source] of [
    ['hang', 'while(true) {}'],
    ['build failure', 'const = syntax error'],
    ['invalid output with spoofed infrastructure fields', 'console.log(JSON.stringify({kind:"grader-infrastructure",code:"GRADER_EXECUTOR",error:"EPERM missing browser"}))'],
    ['output overflow', "process.stdout.write('x'.repeat(1100000))"],
  ]) it(`${id}: actual candidate ${name} remains failed`, async () => {
    const oracle = await import(`${root}/ground-truth/${id}/oracle.mjs`);
    const execute = processExecutor(root,1000);
    const verdicts = await oracle.gradeFiles({execute: (request: {args?: string[]}) => {
      // This test isolates the candidate execution boundary. Live archive
      // prerequisite verification is covered separately, not claimed here.
      if (id === 'project-archive-complex' && request.args?.[2]?.startsWith('// Trusted environment-only probe:')) return Promise.resolve({code:0,stdout:'',stderr:''});
      return execute({command:'node',args:['-e',source!],timeoutMs:name === 'hang' ? 25 : 1000});
    }});
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts.every((v: {pass:boolean}) => !v.pass)).toBe(true);
  },15000);
}
it('archive prerequisite failure is infrastructure even for nonzero process exit', async () => {
  const oracle = await import(`${root}/ground-truth/project-archive-complex/oracle.mjs`);
  const execute = processExecutor(root,1000);
  await expect(oracle.gradeFiles({execute: () => execute({command:'node',args:['-e',"throw Error('trusted browser unavailable')"]})})).rejects.toMatchObject({kind:'grader-infrastructure',code:'GRADER_PREFLIGHT'});
});
it('archive probe executor faults still propagate after successful preflight', async () => {
  const oracle = await import(`${root}/ground-truth/project-archive-complex/oracle.mjs`);
  let calls = 0;
  const execute = processExecutor(root,1000);
  await expect(oracle.gradeFiles({execute: () => ++calls === 1 ? Promise.resolve({code:0,stdout:'',stderr:''}) : execute({command:'/nonexistent-eval-runtime'})})).rejects.toMatchObject({kind:'grader-infrastructure',code:'GRADER_EXECUTOR'});
});
it('unavailable Docker container/runtime is a trusted infrastructure preflight failure', async () => {
  const execute = processExecutor(root,1000,{containerName:'eval-intentionally-absent-grader-container',workdir:'/workspace'});
  await expect(execute({command:'node',args:['-e','process.exit(0)']})).rejects.toMatchObject({kind:'grader-infrastructure',code:'GRADER_PREFLIGHT'});
});
