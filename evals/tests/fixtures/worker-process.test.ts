import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskDefinitionSchema } from '../../schemas/index.js';
import { processExecutor, type ExecuteRequest } from '../../src/graders/executor.js';

const root = resolve(import.meta.dirname, '../..');
const id = 'worker-recovery-complex';
type Verdict = {criterionId: string; pass: boolean; observed: string};
async function assets() {
  return {
    fixture: await import(`../../tasks/${id}/fixture.mjs`),
    oracle: await import(`../../ground-truth/${id}/oracle.mjs`),
    reference: await readFile(join(root,'ground-truth',id,'reference/src/index.mjs'),'utf8'),
  };
}
async function grade(source: string, seed = 'withheld-17') {
  const {fixture,oracle} = await assets();
  const directory = await mkdtemp(join(tmpdir(),'worker-fixture-'));
  const calls: ExecuteRequest[] = [];
  try {
    await fixture.materialize({destination:directory});
    await writeFile(join(directory,'src/index.mjs'),source);
    const run = processExecutor(directory,5000);
    const verdicts: Verdict[] = await oracle.gradeFiles({seed,execute:async (request: ExecuteRequest) => {
      calls.push(request);
      return run(request);
    }});
    expect((await readdir(directory)).sort()).toEqual(['README.md','example.json','src']);
    return {verdicts,calls};
  } finally { await rm(directory,{recursive:true,force:true}); }
}

describe('persistent worker subprocess acceptance', () => {
  it('exports only deterministic public files and maps every manifest criterion', async () => {
    const {fixture,oracle} = await assets();
    const built = await fixture.build('one');
    expect(await fixture.build('one')).toEqual(built);
    expect(await fixture.build('two')).not.toEqual(built);
    expect(Object.keys(built.files).sort()).toEqual(['README.md','example.json','src/index.mjs']);
    expect(built.files['src/index.mjs']).toBe(await readFile(join(root,'tasks',id,'starter/src/index.mjs'),'utf8'));
    expect(JSON.stringify(built.files)).not.toMatch(/ground-truth|oracle\.mjs|hiddenCases|\.git\//);
    expect(fixture.reference).toBeUndefined();
    expect(fixture.starter).toBeUndefined();
    expect(oracle.reference).toBeUndefined();
    expect(oracle.grade).toBeUndefined();
    const manifest = TaskDefinitionSchema.parse(JSON.parse(await readFile(join(root,'tasks',id,'manifest.json'),'utf8')));
    expect(oracle.criterionIds).toEqual(manifest.criteria.map(c => c.id));
    expect(oracle.revision).toBe(manifest.grader.revision);
  });

  it('reference survives real repeated SIGKILL/restarts with seed variation and repeatable grades', async () => {
    const {reference} = await assets();
    const first = await grade(reference);
    expect(first.verdicts.every(v => v.pass),JSON.stringify(first.verdicts)).toBe(true);
    expect(first.verdicts[0].observed).toContain('26 real worker launches');
    expect((await grade(reference)).verdicts).toEqual(first.verdicts);
    const other = await grade(reference,'different-seed-8');
    expect(other.verdicts.every(v => v.pass),JSON.stringify(other.verdicts)).toBe(true);
    const initial = (calls: ExecuteRequest[]) => calls.map(c => JSON.parse(c.stdin!)).filter(c => c.action === 'init').map(c => c.state);
    expect(initial(first.calls)).not.toEqual(initial(other.calls));
    expect(first.calls.every(c => c.command === 'node' && c.timeoutMs === 5000)).toBe(true);
  },30000);

  it('real starter fails duplicate committed effects specifically', async () => {
    const {fixture} = await assets();
    const {verdicts} = await grade((await fixture.build()).files['src/index.mjs']);
    expect(verdicts.find(v => v.criterionId === 'worker.idempotency')?.pass).toBe(false);
    expect(verdicts.find(v => v.criterionId === 'worker.restart')?.pass).toBe(true);
  },15000);

  const defects = [
    {name:'early reclaim',from:"job.leaseUntil > now",to:'false',criterion:'worker.claim-lease'},
    {name:'late reclaim at equality',from:'job.leaseUntil > now',to:'job.leaseUntil >= now',criterion:'worker.claim-lease'},
    {name:'never reclaim',from:'job.leaseUntil > now',to:'true',criterion:'worker.restart'},
    {name:'skip retry delay',from:'job.availableAt > now',to:'false',criterion:'worker.claim-lease'},
    {name:'skip transient failures',from:'job.attempts <= job.failures',to:'false',criterion:'worker.claim-lease'},
    {name:'lost effect',from:'state.effects.push({ jobId: job.id, value: job.value });',to:'/* lost commit */',criterion:'worker.idempotency'},
    {name:'corrupt effect value',from:'value: job.value',to:'value: job.value + 1',criterion:'worker.idempotency'},
    {name:'acknowledge before effect',from:"checkpoint('before-effect');",to:"job.status = 'done'; commit(); checkpoint('before-effect');",criterion:'worker.restart'},
    {name:'fake crash exit',from:"process.kill(process.pid, 'SIGKILL')",to:'process.exit(1)',criterion:'worker.restart'},
    {name:'uncommitted journal',from:"checkpoint('after-effect');",to:"state.effects = []; commit(); checkpoint('after-effect');",criterion:'worker.idempotency'},
  ];
  for (const defect of defects) it(`rejects ${defect.name} in persisted subprocess results`, async () => {
    const {reference} = await assets();
    expect(reference).toContain(defect.from);
    const {verdicts} = await grade(reference.replace(defect.from,defect.to));
    expect(verdicts.find(v => v.criterionId === defect.criterion)?.pass,JSON.stringify(verdicts)).toBe(false);
  },15000);

  it('syntax errors and output-only fabricated success fail every criterion', async () => {
    for (const source of ['this is invalid JavaScript!', 'console.log(JSON.stringify({pid:process.pid}));']) {
      const {verdicts} = await grade(source);
      expect(verdicts.every(v => !v.pass),JSON.stringify(verdicts)).toBe(true);
    }
  },15000);
});
