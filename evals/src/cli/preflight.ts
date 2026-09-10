import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExternalAdapter } from '../adapters/factory.js';
import { fakeAdapter } from './operations.js';
import { DockerIsolationBackend } from '../isolation/docker.js';
import type { AdapterConfig, CapabilityReport, TaskDefinition } from '../../schemas/index.js';

/** Only non-generative executable/environment probes. Temporary owned state is removed. */
export async function preflight(configs:AdapterConfig[],tasks:TaskDefinition[]):Promise<CapabilityReport[]> {
  const stateRoot=await mkdtemp(join(tmpdir(),'agent-evals-preflight-'));
  try {
    const reports:CapabilityReport[]=[];
    for (const config of configs) {
      const adapter=config.adapterId==='process-fake'?fakeAdapter(stateRoot):createExternalAdapter({...config,settings:{...config.settings,stateRoot}});
      const result=await adapter.preflight(config.adapterId.startsWith('minion-')?{...config,settings:{...config.settings,stateRoot}}:config);
      reports.push(result); if (!result.supported) throw new Error(result.limitations.join('; '));
      if (config.adapterId!=='process-fake' && config.settings.isolation!=='docker' && config.settings.profile!=='local-development') throw new Error('select Docker isolation or explicit local-development profile');
      if (config.settings.isolation==='docker') for (const task of tasks) {
        const backend=new DockerIsolationBackend({stateRoot});
        const probe=await backend.preflight({schemaVersion:1,backendId:'docker',runId:'preflight',participantRoot:stateRoot,networkPolicy:config.settings.networkPolicy==='declared_only'?'declared_only':'none',cpuLimit:1,memoryBytes:536870912,storageBytes:task.submission.maxBytes,imageDigest:task.fixture.imageDigest});
        reports.push(probe);if(!probe.supported)throw new Error(probe.limitations.join('; '));
      }
    }
    return reports;
  } finally { await rm(stateRoot,{recursive:true,force:true}); }
}
