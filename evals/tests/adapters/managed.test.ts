import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { ManagedMinionsAdapter } from '../../src/adapters/managed-minions.js';
import type { AdapterConfig, ParticipantRunSpec } from '../../schemas/index.js';
it('owns real server startup, durable reconnection, protocol execution and shutdown',async()=>{
  const root=await mkdtemp(join(tmpdir(),'eval-managed-'));
  const app=join(root,'app'),workspace=join(root,'workspace'),state=join(root,'state');
  await mkdir(join(app,'server'),{recursive:true});await mkdir(workspace);await mkdir(state);await mkdir(join(app,'shared'));await writeFile(join(app,'pnpm-lock.yaml'),'fixture');
  await writeFile(join(app,'package.json'),'{"type":"module"}');
  await symlink(resolve('node_modules'),join(app,'node_modules'),'dir');
  await writeFile(join(app,'server/index.ts'),await readFile(resolve('tests/adapters/managed-fixture.mjs'),'utf8'));
  const executable=join(root,'fake-codex');await writeFile(executable,'#!/bin/sh\nprintf "multi_agent stable false\\nmulti_agent_v2 stable false\\n"\n',{mode:0o700});
  const config:AdapterConfig={schemaVersion:1,adapterId:'minion-single',settings:{appRoot:app,codexExecutable:executable,stateRoot:state,profile:'local-development'},requiredCapabilities:[]};
  const adapter=new ManagedMinionsAdapter(config);
  const run:ParticipantRunSpec={schemaVersion:1,runId:'owned',idempotencyKey:'owned',taskId:'fixture',prompt:'fixture only',workspace:{id:'fixture',mountPath:workspace},limits:{maxTotalTokens:100,executionTimeoutMs:10000,preparationTimeoutMs:1000,gradingTimeoutMs:1000},configuration:{model:'fixture',execution:{kind:'local',workdir:workspace,stateRoot:state}},visibleAssets:[]};
  try {
    // The CLI binds controller state to the adapter, while the immutable plan
    // passed to per-cell preflight deliberately contains no runtime state path.
    const {stateRoot: _stateRoot, ...planSettings}=config.settings;
    expect((await adapter.preflight({...config,settings:planSettings})).supported).toBe(true);
    const handle=await adapter.start(run), events=[];
    expect((await adapter.inspect(handle)).terminalOutcome,await readFile(join(state,'instances/owned/startup-error.json'),'utf8').catch(()=>'' )).toBe('completed');
    for await(const event of adapter.observe(handle))events.push(event);
    expect(events.some(e=>e.type==='usage')).toBe(true);
    const recovered=new ManagedMinionsAdapter(config);expect(await recovered.start(run)).toEqual(handle);
    expect(await readFile(join(state,'instances/owned/state/minions-home/launches'),'utf8')).toBe('1');
    expect((await recovered.collect(handle)).provenance.protocolAdherence).toBe('valid');
    expect(await readFile(join(workspace,'answer.mjs'),'utf8')).toContain('42');
    await recovered.shutdown(run.runId);
    expect((await recovered.inspect(handle)).state).toBe('terminal');
  } finally {await adapter.shutdown(run.runId);await rm(root,{recursive:true,force:true});}
},30000);
