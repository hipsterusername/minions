import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { implementationContent, taskContent } from '../../src/core/plan-lock.js';
import { preparePublicFixture } from '../../src/isolation/public-fixture.js';
import { DockerIsolationBackend } from '../../src/isolation/docker.js';
import { TaskDefinitionSchema } from '../../schemas/index.js';
const packageRoot=resolve(import.meta.dirname,'../..');
it('fingerprints implementation edits, dependency locks and sibling oracle modules',async()=>{
  const root=await mkdtemp(join(tmpdir(),'eval-provenance-'));
  try {
    for(const path of ['src','schemas','task','truth'])await mkdir(join(root,path));
    for(const file of ['package.json','pnpm-lock.yaml','src/main.ts','schemas/index.ts','task/prompt.md','truth/oracle.mjs','truth/cases.mjs'])await writeFile(join(root,file),'initial');
    const first=await implementationContent(root);await writeFile(join(root,'src/main.ts'),'changed');expect(await implementationContent(root)).not.toBe(first);
    const second=await implementationContent(root);await writeFile(join(root,'pnpm-lock.yaml'),'changed');expect(await implementationContent(root)).not.toBe(second);
    const task=TaskDefinitionSchema.parse(JSON.parse(await readFile(join(packageRoot,'tasks/pagination-simple/manifest.json'),'utf8')));task.grader.configFile='../truth/oracle.mjs';
    const digest=await taskContent(task,join(root,'task'));await writeFile(join(root,'truth/cases.mjs'),'new hidden case');expect(await taskContent(task,join(root,'task'))).not.toBe(digest);
  }finally{await rm(root,{recursive:true,force:true});}
});
it('materializes public package and examples, and rejects a builder traversal before writing',async()=>{
  const root=await mkdtemp(join(tmpdir(),'eval-builder-'));
  try {
    const task=TaskDefinitionSchema.parse(JSON.parse(await readFile(join(packageRoot,'tasks/project-archive-complex/manifest.json'),'utf8')));
    await preparePublicFixture(task,join(packageRoot,'tasks',task.id),join(root,'public'),'seed');
    expect(JSON.parse(await readFile(join(root,'public/package.json'),'utf8')).devDependencies.playwright).toBe('1.62.1');
    await mkdir(join(root,'bad')); await writeFile(join(root,'bad/fixture.mjs'),`export async function build(){return {schemaVersion:1,taskId:${JSON.stringify(task.id)},files:{'../escaped':'no'}}}`);
    await expect(preparePublicFixture(task,join(root,'bad'),join(root,'output'),'seed')).rejects.toThrow();
  }finally{await rm(root,{recursive:true,force:true});}
});
it('rejects mutable image tags even when the Docker daemon responds',async()=>{
  const backend=new DockerIsolationBackend({stateRoot:'/tmp/unused',command:async()=>({code:0,stdout:'29.7.2',stderr:''})});
  const result=await backend.preflight({schemaVersion:1,backendId:'docker',runId:'probe',participantRoot:'/tmp/fixture',networkPolicy:'none',cpuLimit:1,memoryBytes:1024,storageBytes:1024,imageDigest:'node:22-alpine'});
  expect(result.supported).toBe(false);expect(result.limitations.join(' ')).toContain('pinned');
});
