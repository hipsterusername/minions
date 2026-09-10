import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { processExecutor, type ExecuteRequest } from '../../src/graders/executor.js';
import { TaskDefinitionSchema } from '../../schemas/index.js';

const root = resolve(import.meta.dirname, '../..');
const task = join(root, 'tasks/reconciliation-complex');
const truth = join(root, 'ground-truth/reconciliation-complex');
// Only controller fixture/oracle modules are imported, never candidate files.
const load = async () => ({
  fixture: await import('../../tasks/reconciliation-complex/fixture.mjs'),
  oracle: await import('../../ground-truth/reconciliation-complex/oracle.mjs'),
  reference: await readFile(join(truth, 'reference/src/index.mjs'), 'utf8'),
});
type Verdict = {criterionId:string;pass:boolean;observed:string};
async function grade(source:string, seed='withheld-173') {
  const {fixture,oracle} = await load();
  const directory = await mkdtemp(join(tmpdir(),'reconciliation-submission-'));
  const calls: ExecuteRequest[] = [];
  try {
    await fixture.materialize({destination:directory});
    await writeFile(join(directory,'src/index.mjs'),source);
    const run = processExecutor(directory,5000);
    const verdicts: Verdict[] = await oracle.gradeFiles({seed,execute:async (request:ExecuteRequest) => {
      calls.push(request); return run(request);
    }});
    return {verdicts,calls};
  } finally { await rm(directory,{recursive:true,force:true}); }
}
describe('reconciliation multi-file process acceptance', () => {
  it('exports only deterministic public starter/files and maps every manifest criterion', async () => {
    const {fixture,oracle} = await load();
    const built = await fixture.build('public-17');
    expect(await fixture.build('public-17')).toEqual(built);
    expect(await fixture.build('public-18')).not.toEqual(built);
    expect(Object.keys(built.files).sort()).toEqual(['README.md','orders.json','payments.json','rates.json','refunds.json','src/index.mjs']);
    expect(built.files['src/index.mjs']).toBe(await readFile(join(task,'starter/src/index.mjs'),'utf8'));
    expect(JSON.stringify(built.files)).not.toMatch(/ground-truth|oracle\.mjs|hiddenCases|\.git\//);
    expect(fixture.reference).toBeUndefined(); expect(fixture.starter).toBeUndefined();
    expect(oracle.reference).toBeUndefined(); expect(oracle.grade).toBeUndefined();
    const manifest = TaskDefinitionSchema.parse(JSON.parse(await readFile(join(task,'manifest.json'),'utf8')));
    expect(oracle.criterionIds).toEqual(manifest.criteria.map(c => c.id));
    expect(oracle.revision).toBe(manifest.grader.revision);
    const directory = await mkdtemp(join(tmpdir(),'reconciliation-export-'));
    try {
      await fixture.materialize({destination:directory});
      expect((await readdir(directory)).sort()).toEqual(['README.md','orders.json','payments.json','rates.json','refunds.json','src']);
      expect(await readdir(join(directory,'src'))).toEqual(['index.mjs']);
    } finally { await rm(directory,{recursive:true,force:true}); }
  });
  it('reference passes two seeds and repeated grading with actual foundation subprocess execution', async () => {
    const {reference} = await load();
    const first = await grade(reference);
    expect(first.verdicts.every(v=>v.pass),JSON.stringify(first.verdicts)).toBe(true);
    expect(first.calls.length).toBeGreaterThan(40);
    expect(first.calls.every(c=>c.command==='node' && c.timeoutMs===5000)).toBe(true);
    expect(first.calls.every(c=>!c.stdin?.includes('expected'))).toBe(true);
    expect((await grade(reference)).verdicts).toEqual(first.verdicts);
    const second = await grade(reference,'different-721');
    expect(second.verdicts.every(v=>v.pass),JSON.stringify(second.verdicts)).toBe(true);
    expect(second.calls.map(c=>c.stdin)).not.toEqual(first.calls.map(c=>c.stdin));
  },30000);
  it('starter fails every functional criterion', async () => {
    const source = await readFile(join(task,'starter/src/index.mjs'),'utf8');
    const {verdicts} = await grade(source);
    expect(verdicts.every(v=>!v.pass),JSON.stringify(verdicts)).toBe(true);
  },15000);
  const defects = [
    {name:'unknown-order-dropped',from:"if (!order) code = 'UNKNOWN_ORDER';",to:'if (!order) return;',criterion:'joins'},
    {name:'duplicate-first-wins',from:'row.time >= winners.get(row.id).time',to:'false',criterion:'deduplication'},
    {name:'duplicate-tie-first',from:'row.time >= winners.get(row.id).time',to:'row.time > winners.get(row.id).time',criterion:'deduplication'},
    {name:'text-date-order',from:'return result;',to:'return value;',criterion:'rates'},
    {name:'exclusive-rate-boundary',from:'r.time <= row.time',to:'r.time < row.time',criterion:'rates'},
    {name:'rate-tie-first',from:'r.time >= selected.time',to:'r.time > selected.time',criterion:'rates'},
    {name:'accept-future-rate',from:'r.time <= row.time',to:'true',criterion:'rates'},
    {name:'skip-refund-limit',from:'refund && converted > order.total',to:'false',criterion:'refunds'},
    {name:'refund-input-order',from:'.sort((a,b) => a.time - b.time || ascii(a.id,b.id))',to:'',criterion:'refunds'},
    {name:'reject-equal-refund',from:'converted > order.total',to:'converted >= order.total',criterion:'refunds'},
    {name:'round-each-event',from:'const converted = row.amount * rate;',to:'const converted = ((row.amount * rate + 5000000000n) / 10000000000n) * 10000000000n;',criterion:'rounding'},
    {name:'truncate-final',from:'order.total + 5000000000n',to:'order.total',criterion:'rounding'},
    {name:'float-money',from:'BigInt(whole) * SCALE',to:'BigInt(Number(whole)) * SCALE',criterion:'rounding'},
    {name:'calendar-rollover',from:'day > new Date(Date.UTC(year,month,0)).getUTCDate()',to:'day > 31',criterion:'io'},
    {name:'invalid-exit',from:'process.exitCode = 2',to:'process.exitCode = 0',criterion:'io'},
  ];
  for (const defect of defects) it(`rejects submitted ${defect.name}`,async () => {
    const {reference} = await load();
    expect(reference).toContain(defect.from);
    const {verdicts} = await grade(reference.replace(defect.from,defect.to));
    expect(verdicts.find(v=>v.criterionId===`reconciliation.${defect.criterion}`)?.pass,JSON.stringify(verdicts)).toBe(false);
  },15000);
  it('rejects input mutation despite otherwise correct output',async () => {
    const {reference} = await load();
    const source = reference + "\nimport {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2], '[]');\n";
    expect((await grade(source)).verdicts.every(v=>!v.pass)).toBe(true);
  },15000);
  for (const source of ['not valid JavaScript!', "process.stdout.write('not-json');"]) it(`rejects malformed submission ${source}`,async () => {
    expect((await grade(source)).verdicts.every(v=>!v.pass)).toBe(true);
  },15000);
  it('kills a nonterminating real submission and records failure',async () => {
    const {fixture,oracle} = await load();
    const directory = await mkdtemp(join(tmpdir(),'reconciliation-timeout-'));
    try {
      await fixture.materialize({destination:directory});
      await writeFile(join(directory,'src/index.mjs'),'while (true) {}');
      const run = processExecutor(directory,100);
      const verdicts: Verdict[] = await oracle.gradeFiles({execute:run,seed:'timeout'});
      expect(verdicts.every(v=>!v.pass)).toBe(true);
      expect(verdicts.every(v=>v.observed.includes('timeout'))).toBe(true);
    } finally { await rm(directory,{recursive:true,force:true}); }
  });
});
