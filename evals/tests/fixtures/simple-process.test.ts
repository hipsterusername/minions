import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskDefinitionSchema } from '../../schemas/index.js';
import { CandidateLimitError, processExecutor } from '../../src/graders/executor.js';

const root = resolve(import.meta.dirname, '../..');
const ids = ['pagination-simple', 'status-filter-simple', 'orders-report-simple'] as const;
type TaskId = typeof ids[number];
type Request = { command: string; args: string[]; stdin?: string; timeoutMs?: number };
type Verdict = { criterionId: string; pass: boolean; observed: string };

// Real OS process boundary. No candidate imports in the test/controller process.
function executor(cwd: string, calls: Request[]) {
  return async (request: Request): Promise<{code: number; stdout: string; stderr: string}> => {
    calls.push(request);
    // Regular-file stdio also works on restricted hosts where Node child pipes fail.
    const capture = await mkdtemp(join(tmpdir(), 'simple-capture-'));
    await writeFile(join(capture, 'stdin'), request.stdin ?? '');
    const fds = [openSync(join(capture, 'stdin'), 'r'), openSync(join(capture, 'stdout'), 'w'), openSync(join(capture, 'stderr'), 'w')];
    try {
      const code = await new Promise<number>((accept, reject) => {
        const child = spawn(request.command === 'node' ? process.execPath : request.command, request.args, {
          cwd, stdio: fds, detached: true, env: { PATH: process.env.PATH, LANG: 'C', TZ: 'Pacific/Honolulu' },
        });
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }
        }, request.timeoutMs ?? 5000);
        child.on('error', error => { clearTimeout(timeout); reject(error); });
        child.on('close', code => {
          clearTimeout(timeout);
          if (timedOut) reject(new CandidateLimitError('CANDIDATE_TIMEOUT','grader subprocess timed out'));
          else accept(code ?? -1);
        });
      });
      const stdout = await readFile(join(capture, 'stdout'), 'utf8');
      const stderr = await readFile(join(capture, 'stderr'), 'utf8');
      if (stdout.length > 1_000_000 || stderr.length > 1_000_000) throw new CandidateLimitError('CANDIDATE_OUTPUT_LIMIT','output limit');
      return { code, stdout, stderr };
    } finally {
      for (const fd of fds) closeSync(fd);
      await rm(capture, { recursive: true, force: true });
    }
  };
}
async function load(id: TaskId) {
  return {
    fixture: await import(`../../tasks/${id}/fixture.mjs`),
    oracle: await import(`../../ground-truth/${id}/oracle.mjs`),
    reference: await readFile(join(root, 'ground-truth', id, 'reference/src/index.mjs'), 'utf8'),
  };
}
async function gradeSource(id: TaskId, source: string, seed = 'withheld-17') {
  const { fixture, oracle } = await load(id);
  const directory = await mkdtemp(join(tmpdir(), 'simple-eval-'));
  const calls: Request[] = [];
  try {
    await fixture.materialize({ destination: directory, seed: 'public-seed' });
    await writeFile(join(directory, 'src/index.mjs'), source);
    const verdicts: Verdict[] = await oracle.gradeFiles({ execute: executor(directory, calls), seed });
    return { verdicts, calls };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

describe('simple task subprocess acceptance', () => {
  for (const id of ids) {
    it(`${id}: deterministic allowlisted public export, real starter and exact criterion mapping`, async () => {
      const { fixture, oracle } = await load(id);
      const built = await fixture.build('public-123');
      expect(await fixture.build('public-123')).toEqual(built);
      expect(await fixture.build('different-public-seed')).not.toEqual(built);
      expect(Object.keys(built.files).sort()).toEqual(['README.md', id === 'orders-report-simple' ? 'example.csv' : 'example.json', 'src/index.mjs']);
      expect(fixture.reference).toBeUndefined();
      expect(fixture.starter).toBeUndefined();
      expect(oracle.reference).toBeUndefined();
      expect(oracle.grade).toBeUndefined();
      expect(built.files['src/index.mjs']).toBe(await readFile(join(root, 'tasks', id, 'starter/src/index.mjs'), 'utf8'));
      expect(JSON.stringify(built.files)).not.toMatch(/ground-truth|oracle\.mjs|hiddenCases|\.git\//);
      const manifest = TaskDefinitionSchema.parse(JSON.parse(await readFile(join(root, 'tasks', id, 'manifest.json'), 'utf8')));
      expect(oracle.criterionIds).toEqual(manifest.criteria.map(criterion => criterion.id));
      expect(oracle.revision).toBe(manifest.grader.revision);
      const directory = await mkdtemp(join(tmpdir(), 'simple-export-'));
      try {
        await fixture.materialize({ destination: directory });
        expect((await readdir(directory)).sort()).toEqual(['README.md', id === 'orders-report-simple' ? 'example.csv' : 'example.json', 'src']);
        expect(await readdir(join(directory, 'src'))).toEqual(['index.mjs']);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });

    it(`${id}: uses the foundation processExecutor contract`, async () => {
      const {fixture, oracle, reference} = await load(id);
      const directory = await mkdtemp(join(tmpdir(), 'simple-foundation-'));
      try {
        await fixture.materialize({destination: directory});
        await writeFile(join(directory, 'src/index.mjs'), reference);
        const verdicts: Verdict[] = await oracle.gradeFiles({execute: processExecutor(directory, 5000), seed: 'foundation-seed'});
        expect(verdicts.every(check => check.pass), JSON.stringify(verdicts)).toBe(true);
      } finally { await rm(directory, {recursive: true, force: true}); }
    }, 10000);

    it(`${id}: reference passes two seeds, repeats exactly, and starter fails in real processes`, async () => {
      const { fixture, reference } = await load(id);
      const first = await gradeSource(id, reference);
      expect(first.verdicts.every(check => check.pass), JSON.stringify(first.verdicts)).toBe(true);
      expect(first.calls.length).toBeGreaterThan(0);
      expect(first.calls.every(call => call.command === 'node' && call.timeoutMs === 5000)).toBe(true);
      expect((await gradeSource(id, reference)).verdicts).toEqual(first.verdicts);
      const other = await gradeSource(id, reference, 'different-seed-982');
      expect(other.verdicts.every(check => check.pass), JSON.stringify(other.verdicts)).toBe(true);
      expect(other.calls.map(call => call.stdin)).not.toEqual(first.calls.map(call => call.stdin));
      const starter = (await fixture.build('public')).files['src/index.mjs'];
      expect((await gradeSource(id, starter)).verdicts.some(check => !check.pass)).toBe(true);
    }, 20000);
  }

  for (const id of ['pagination-simple', 'status-filter-simple'] as const) it(`${id}: equivalent record key ordering passes`, async () => {
    const {reference} = await load(id);
    const name = id === 'pagination-simple' ? 'paginate' : 'list';
    const source = reference.replace(`export function ${name}`, 'function original') +
      `\nexport function ${name}(...args) { return original(...args).map(row => Object.fromEntries(Object.entries(row).reverse())); }\n`;
    const {verdicts} = await gradeSource(id, source);
    expect(verdicts.every(check => check.pass), JSON.stringify(verdicts)).toBe(true);
  });

  it('a real nonterminating submission is killed and fails every criterion', async () => {
    const id = 'pagination-simple';
    const {fixture, oracle} = await load(id);
    const directory = await mkdtemp(join(tmpdir(), 'simple-timeout-'));
    const calls: Request[] = [];
    try {
      await fixture.materialize({destination: directory});
      await writeFile(join(directory, 'src/index.mjs'), 'export function paginate() { while (true) {} }');
      const run = executor(directory, calls);
      const verdicts: Verdict[] = await oracle.gradeFiles({execute: (request: Request) => run({...request, timeoutMs: 100}), seed: 'timeout'});
      expect(verdicts.every(check => !check.pass)).toBe(true);
      expect(verdicts.every(check => check.observed.includes('timed out'))).toBe(true);
      expect(calls).toHaveLength(1);
    } finally { await rm(directory, {recursive: true, force: true}); }
  });

  const defects: {id: TaskId; name: string; from: string; to: string; criterion: string}[] = [
    { id:'pagination-simple', name:'off-by-one', from:'page * pageSize,', to:'page * pageSize + 1,', criterion:'pagination.boundaries' },
    { id:'pagination-simple', name:'fractional-validation', from:'!Number.isSafeInteger(pageSize)', to:'!Number.isFinite(pageSize)', criterion:'pagination.validation' },
    { id:'pagination-simple', name:'mutating-order', from:'return items.slice', to:'items.reverse(); return items.slice', criterion:'pagination.order' },
    { id:'pagination-simple', name:'return-input', from:'return items.slice(page * pageSize, (page + 1) * pageSize);', to:'return page === 0 && pageSize >= items.length ? items : items.slice(page * pageSize, (page + 1) * pageSize);', criterion:'pagination.order' },
    { id:'status-filter-simple', name:'null-status', from:'status !== undefined &&', to:'status != null &&', criterion:'status-filter.values' },
    { id:'status-filter-simple', name:'baseline-default', from:'pageSize = 20', to:'pageSize = 10', criterion:'status-filter.baseline' },
    { id:'status-filter-simple', name:'paginate-before-filter', from:"return records.filter(record => status === undefined || record.status === status)\n    .slice(page * pageSize, (page + 1) * pageSize);", to:"return records.slice(page * pageSize, (page + 1) * pageSize).filter(record => status === undefined || record.status === status);", criterion:'status-filter.pagination' },
    { id:'status-filter-simple', name:'deduplicate-records', from:'return records.filter', to:'return records.filter((r,i) => records.findIndex(x => x.id === r.id) === i).filter', criterion:'status-filter.baseline' },
    { id:'orders-report-simple', name:'first-winner', from:'if (month !== null)', to:'if (month !== null && !winners.has(id))', criterion:'orders.deduplicate' },
    { id:'orders-report-simple', name:'local-month', from:"date.toISOString().slice(0, 7)", to:'value.slice(0, 7)', criterion:'orders.totals' },
    { id:'orders-report-simple', name:'negative-subunit', from:'return negative ? -magnitude : magnitude;', to:'return negative && BigInt(whole) !== 0n ? -magnitude : magnitude;', criterion:'orders.totals' },
    { id:'orders-report-simple', name:'float-coercion', from:'BigInt(whole) * 100n', to:'BigInt(Number(whole)) * 100n', criterion:'orders.totals' },
    { id:'orders-report-simple', name:'accept-extra-columns', from:'fields.length !== 3', to:'fields.length < 3', criterion:'orders.parse' },
    { id:'orders-report-simple', name:'accept-invalid-date', from:'day > days[month - 1]', to:'day > 31', criterion:'orders.parse' },
    { id:'orders-report-simple', name:'wrong-exit', from:'process.exitCode = 2', to:'process.exitCode = 0', criterion:'orders.exit' },
  ];
  for (const defect of defects) it(`${defect.id} rejects ${defect.name}`, async () => {
    const {reference} = await load(defect.id);
    expect(reference).toContain(defect.from);
    const source = reference.replace(defect.from, defect.to);
    const {verdicts} = await gradeSource(defect.id, source);
    expect(verdicts.find(check => check.criterionId === defect.criterion)?.pass, JSON.stringify(verdicts)).toBe(false);
  }, 10000);

  for (const id of ids) it(`${id}: syntax errors and malformed output cannot pass`, async () => {
    for (const source of ['this is invalid JavaScript!', "process.stdout.write('not-json');"]) {
      expect((await gradeSource(id, source)).verdicts.every(check => !check.pass)).toBe(true);
    }
  }, 15000);
});
