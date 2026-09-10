import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TaskDefinitionSchema } from '../../schemas/index.js';
import { preparePublicFixture, snapshotSubmission } from '../../src/isolation/public-fixture.js';
import { processExecutor } from '../../src/graders/executor.js';
import { verifyOracle } from '../../src/cli/oracles.js';
const root = resolve(import.meta.dirname, '../..');
const load = (path: string) => import(pathToFileURL(path).href);
const cases = [
  {id:'aider-vlq', slug:'variable-length-quantity', count:26, assertions:26, from:'return val >>> 0;', to:'return val | 0;', tokens:500000, timeout:600000},
  {id:'aider-forth', slug:'forth', count:49, assertions:50, from:'[a + b]', to:'[a - b]', tokens:750000, timeout:900000},
];
describe('pinned Aider polyglot packages', () => {
  it('preserves hashed upstream bytes and MIT notices', async () => {
    const provenance = JSON.parse(await readFile(join(root,'benchmarks/aider-polyglot/provenance.json'),'utf8'));
    expect(provenance.commit).toBe('7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f');
    expect(provenance.sources).toHaveLength(10);
    for (const source of provenance.sources) {
      const bytes = await readFile(resolve(root,'..',source.path));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256);
      expect(source.url).toContain('/'+provenance.commit+'/');
    }
  });
  for (const c of cases) {
    it(`${c.id}: retains every test and assertion with only the documented transform`, async () => {
      const gt = join(root,'ground-truth',c.id);
      const upstream = await readFile(join(gt,'upstream',c.slug+'.spec.js'),'utf8');
      const adapted = await readFile(join(gt,'tests.mjs'),'utf8');
      const body = adapted.slice(adapted.indexOf(c.id === 'aider-vlq' ? 'import { encode' : 'import { Forth'));
      expect(body).toBe(upstream.replace(`'./${c.slug}'`,`'./${c.slug}.mjs'`).replaceAll('xtest(', 'test('));
      expect(body.match(/\btest\(/g)).toHaveLength(c.count);
      expect(body.match(/\bexpect\(/g)).toHaveLength(c.assertions);
      expect(body).not.toMatch(/xtest|\.skip\(/);
      expect(await readFile(join(gt,'reference',c.slug+'.mjs'),'utf8')).toBe(await readFile(join(gt,'upstream/.meta/proof.ci.js'),'utf8'));
    });
    it(`${c.id}: validates reference/starter and rejects a behavioral mutant in a frozen submission`, async () => {
      const taskRoot = join(root,'tasks',c.id);
      const manifest = TaskDefinitionSchema.parse(JSON.parse(await readFile(join(taskRoot,'manifest.json'),'utf8')));
      expect(manifest.limits).toMatchObject({maxTotalTokens:c.tokens,executionTimeoutMs:c.timeout,gradingTimeoutMs:60000});
      expect((await verifyOracle(manifest,root)).reference).toBe('passed');
      const base = await mkdtemp(join(tmpdir(),'aider-regression-'));
      try {
        const candidate = join(base,'candidate');
        await preparePublicFixture(manifest,taskRoot,candidate,'fixture-isolation');
        expect((await readdir(candidate)).sort()).toEqual(['LICENSE','README.md',c.slug+'.mjs'].sort());
        const fixture = await (await load(join(taskRoot,'fixture.mjs'))).build('fixture-isolation');
        expect(Object.values(fixture.files).join('\n')).not.toMatch(/ground-truth|proof\.ci|tests\.mjs|oracle\.mjs/);
        await cp(join(root,'ground-truth',c.id,'reference'),candidate,{recursive:true});
        const file = join(candidate,c.slug+'.mjs');
        const reference = await readFile(file,'utf8');
        expect(reference.split(c.from)).toHaveLength(2);
        await writeFile(file,reference.replace(c.from,c.to));
        const frozen = join(base,'frozen');
        await snapshotSubmission(candidate,frozen,manifest.submission.maxBytes,manifest.submission);
        const executor = processExecutor(frozen,manifest.limits.gradingTimeoutMs);
        let calls = 0;
        const verdicts = await (await load(join(root,'ground-truth',c.id,'oracle.mjs'))).gradeFiles({execute:async (request:Parameters<typeof executor>[0]) => {calls++; return executor(request);}});
        expect(calls).toBe(1);
        expect(verdicts).toHaveLength(1);
        expect(verdicts[0].pass).toBe(false);
        expect(verdicts[0].observed).toMatch(/failed=[1-9]/);
      } finally { await rm(base,{recursive:true,force:true}); }
    },60000);
  }
});
