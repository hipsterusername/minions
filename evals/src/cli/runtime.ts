import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { AdapterConfig, TaskDefinition } from '../../schemas/index.js';
import type { DockerIsolationBackend } from '../isolation/docker.js';
const require=createRequire(import.meta.url);
export async function prepareRuntime(config:AdapterConfig,task:TaskDefinition,docker?:{backend:DockerIsolationBackend;workspaceId:string}) {
  if (!docker) {
    if (task.requiredCapabilities.includes('browser')) {
      const {chromium}=require('playwright');await access(chromium.executablePath());
    }
    return;
  }
  if (task.requiredCapabilities.includes('browser')) {
    const result=await docker.backend.execute(docker.workspaceId,['node','-e',"const fs=require('fs');require('node:sqlite');const {chromium}=require('/opt/evals-runtime/node_modules/playwright');fs.accessSync(chromium.executablePath());"]);
    if (result.code) throw new Error('prepared image lacks SQLite/Playwright/Chromium: '+result.stderr);
  }
  if (config.adapterId!=='process-fake') {
    const executable=String(config.settings.codexExecutable ?? config.settings.executable ?? 'codex');
    const result=await docker.backend.execute(docker.workspaceId,[executable,'--disable','multi_agent','--disable','multi_agent_v2','features','list']);
    if (result.code || !['multi_agent','multi_agent_v2'].every(name=>new RegExp(`^${name}\\s+.*\\sfalse$`,'m').test(result.stdout))) throw new Error('prepared image Codex delegation preflight failed: '+result.stderr);
  }
}
