import { mkdtemp, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { processExecutor } from '../../src/graders/executor.js';
import { TaskDefinitionSchema } from '../../schemas/index.js';

const root = resolve(import.meta.dirname,'../..');
const taskPath = join(root,'tasks/project-archive-complex');
const truthPath = join(root,'ground-truth/project-archive-complex');
const fixture = await import('../../tasks/project-archive-complex/fixture.mjs');
const oracle = await import('../../ground-truth/project-archive-complex/oracle.mjs');
type Verdict = {criterionId:string;pass:boolean;observed:string};
async function grade(reference: boolean, seed = 'seed-17', mutate?: (files: Record<string,string>) => void) {
  const directory = await mkdtemp(join(tmpdir(),'archive-test-'));
  try {
    await fixture.materialize({destination:directory,seed:'public'});
    // Reuse already installed pinned browser tooling; no installs/network in tests.
    await symlink(resolve(root,'node_modules'),join(directory,'node_modules'),'dir');
    if (reference) {
      const files: Record<string,string> = {};
      for (const name of ['server.mjs','app.js','index.html']) files[name] = await readFile(join(truthPath,'reference/src',name),'utf8');
      mutate?.(files);
      for (const [name,content] of Object.entries(files)) await writeFile(join(directory,'src',name),content);
    }
    return await oracle.gradeFiles({execute:processExecutor(directory,30000),seed}) as Verdict[];
  } finally {await rm(directory,{recursive:true,force:true});}
}

describe('archive real SQLite/HTTP/browser fixture',() => {
  it('allowlists deterministic public starter assets and maps every criterion',async () => {
    const built = await fixture.build('public');
    expect(await fixture.build('public')).toEqual(built);
    expect(await fixture.build('other')).not.toEqual(built);
    expect(Object.keys(built.files).sort()).toEqual(['README.md','example.json','package.json','src/app.js','src/index.html','src/server.mjs']);
    expect(built.files['src/server.mjs']).toBe(await readFile(join(taskPath,'starter/src/server.mjs'),'utf8'));
    expect(JSON.stringify(built.files)).not.toMatch(/ground-truth|oracle\.mjs|hiddenCases|\.git\//);
    expect(fixture.reference).toBeUndefined(); expect(fixture.starter).toBeUndefined(); expect(oracle.reference).toBeUndefined(); expect(oracle.grade).toBeUndefined();
    const manifest = TaskDefinitionSchema.parse(JSON.parse(await readFile(join(taskPath,'manifest.json'),'utf8')));
    expect(oracle.criterionIds).toEqual(manifest.criteria.map(c => c.id));
    expect(oracle.revision).toBe(manifest.grader.revision);
    const destination = await mkdtemp(join(tmpdir(),'archive-export-'));
    try {await fixture.materialize({destination}); expect((await readdir(destination)).sort()).toEqual(['README.md','example.json','package.json','src']);}
    finally {await rm(destination,{recursive:true,force:true});}
  });
  it('reference passes two seeds and repeat grading with real crash/restart and Chromium interactions',async () => {
    const first = await grade(true);
    expect(first.every(v => v.pass),JSON.stringify(first)).toBe(true);
    expect(await grade(true)).toEqual(first);
    const second = await grade(true,'different-592');
    expect(second.every(v => v.pass),JSON.stringify(second)).toBe(true);
  },90000);
  it('starter fails through real HTTP and browser behavior',async () => {
    const verdicts = await grade(false);
    expect(verdicts.every(v => v.observed.includes('checks passed')), JSON.stringify(verdicts)).toBe(true);
    expect(verdicts.some(v => !v.pass)).toBe(true);
    expect(verdicts.find(v => v.criterionId === 'archive.ui')?.pass).toBe(false);
  },35000);
  const defects = [
    {name:'show archived in default list',file:'server.mjs',from:"${filter === 'true' ? 'NOT ' : ''}NULL",to:"${filter === 'true' ? 'NOT ' : ''}NULL OR 1=1",criterion:'archive.visibility'},
    {name:'allow archived edits',file:'server.mjs',from:"if (row.archivedAt !== null)",to:'if (false)',criterion:'archive.edits'},
    {name:'erase description on restore',file:'server.mjs',from:'SET archivedAt = NULL WHERE',to:"SET archivedAt = NULL, description = substr(description,1,0) WHERE",criterion:'archive.restore'},
    {name:'clear archive state on restart',file:'server.mjs',from:'const detail =',to:"db.exec('UPDATE projects SET archivedAt = NULL');\nconst detail =",criterion:'archive.restore'},
    {name:'migrate destructively',file:'server.mjs',from:'const detail =',to:"db.exec(\"DELETE FROM projects WHERE owner = 'bo'\");\nconst detail =",criterion:'archive.migration'},
    {name:'broken browser action',file:'app.js',from:"{method:'POST'}",to:"{method:'GET'}",criterion:'archive.ui'},
    {name:'render project name as HTML',file:'app.js',from:'name.textContent =',to:'name.innerHTML =',criterion:'archive.ui'},
  ];
  for (const defect of defects) it(`rejects ${defect.name}`,async () => {
    const verdicts = await grade(true,'defect',files => {
      expect(files[defect.file]).toContain(defect.from);
      files[defect.file] = files[defect.file]!.replace(defect.from,defect.to);
    });
    expect(verdicts.every(v => v.observed.includes('checks passed')), JSON.stringify(verdicts)).toBe(true);
    expect(verdicts.find(v => v.criterionId === defect.criterion)?.pass,JSON.stringify(verdicts)).toBe(false);
  },35000);
  it('non-starting submission fails explicitly',async () => {
    const verdicts = await grade(true,'broken',files => {files['server.mjs'] = "throw new Error('cannot start');";});
    expect(verdicts.every(v => !v.pass)).toBe(true);
    expect(verdicts[0]?.observed).toContain('server exited');
  },10000);
});
