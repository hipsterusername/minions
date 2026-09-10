import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from '../../src/adapters/execution.js';
import { expect, it } from 'vitest';
import { DockerIsolationBackend, snapshotSubmission } from '../../src/isolation/index.js';
import { processExecutor } from '../../src/graders/executor.js';
/** Opt in on the container-capable host; never pulls an image or calls a provider. */
it.skipIf(process.env.AGENT_EVALS_DOCKER_TEST !== '1')('real network-none containers isolate peers and hidden files, execute and freeze stopped output',async()=>{
  const root=await mkdtemp(join(tmpdir(),'eval-docker-live-'));const backend=new DockerIsolationBackend({stateRoot:root});
  const spec={schemaVersion:1 as const,backendId:'docker',runId:'first',participantRoot:root,networkPolicy:'none' as const,cpuLimit:1,memoryBytes:128*1024*1024,storageBytes:1024*1024,imageDigest:(await command('docker',['image','inspect',process.env.AGENT_EVALS_DOCKER_IMAGE ?? 'node:22-alpine','--format','{{.Id}}'])).trim()};
  expect((await backend.preflight(spec)).supported).toBe(true);
  const a=await backend.provision(spec),b=await backend.provision({...spec,runId:'second'});
  try{
    await writeFile(join(a.mountPath,'private'),'peer-secret');await writeFile(join(root,'oracle'),'hidden');
    const probe=await backend.execute(b.workspaceId,['node','-e','const fs=require("fs");if(fs.existsSync("/workspace/private")||fs.existsSync('+JSON.stringify(join(root,'oracle'))+'))process.exit(1);fs.writeFileSync("answer.mjs","console.log(42)");console.log("isolated")']);expect(probe.code).toBe(0);expect(probe.stdout).toContain('isolated');
    await backend.stopDescendants(b.workspaceId);await snapshotSubmission(b.mountPath,join(root,'frozen'),1000);
    const descriptor=await backend.descriptor(a.workspaceId);expect((await processExecutor(root,1000,descriptor)({command:'node',args:['-e','console.log(42)']})).stdout.trim()).toBe('42');
  }finally{await backend.teardown(a.workspaceId);await backend.teardown(b.workspaceId);await rm(root,{recursive:true,force:true});}
},20000);
