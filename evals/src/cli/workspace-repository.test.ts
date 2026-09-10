import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { prepareWorkspaceRepository } from './workspace-repository.js';
import { processExecutor } from '../graders/executor.js';

it('creates a usable fixture-local Git baseline even below an empty ancestor .git', async () => {
  const root=await mkdtemp(join(tmpdir(),'eval-repository-'));
  try {
    await mkdir(join(root,'.git'));
    const workspace=join(root,'workspace');await mkdir(workspace);
    await writeFile(join(workspace,'answer.mjs'),'export const answer = 0;\n');
    await prepareWorkspaceRepository(workspace);
    const execute=processExecutor(workspace,10000);
    expect((await execute({command:'git',args:['rev-parse','--show-toplevel']})).stdout.trim()).toBe(workspace);
    expect((await execute({command:'git',args:['show','HEAD:answer.mjs']})).stdout).toContain('answer = 0');
    expect((await execute({command:'git',args:['status','--porcelain']})).stdout).toBe('');
  } finally {await rm(root,{recursive:true,force:true});}
});
