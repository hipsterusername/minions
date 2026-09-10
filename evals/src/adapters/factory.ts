import { ManagedMinionsAdapter } from './managed-minions.js';
import { ExtensionRegistry } from '../core/registry.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { AdapterConfig } from '../../schemas/index.js';
import { CodexRawAdapter } from './codex.js';
import { LocalCodexProcessLauncher } from './codex-process.js';
import { MinionGraphAdapter, MinionSingleAdapter } from './minions.js';
import { WebSocketMinionsProtocolClient, type MinionsClientConfiguration } from './minions-client.js';
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
/** Prepare only; controller starts this dedicated process inside its isolation boundary. */
export async function dedicatedInstanceRecipe(input:{stateRoot:string;appRoot:string;codexExecutable:string;port:number}) {
  if(![input.stateRoot,input.appRoot,input.codexExecutable].every(isAbsolute)||!Number.isInteger(input.port)||input.port<1||input.port>65535)throw new Error('absolute paths and valid port required');
  await mkdir(input.stateRoot,{recursive:true});
  await mkdir(join(input.stateRoot,'codex-home'),{recursive:true});
  await mkdir(join(input.stateRoot,'minions-home'),{recursive:true});
  const wrapper=join(input.stateRoot,'codex-no-delegation');
  await writeFile(wrapper,`#!/bin/sh\nexec ${quote(input.codexExecutable)} --disable multi_agent --disable multi_agent_v2 "$@"\n`,{mode:0o700});
  const environment={MINIONS_HOME:join(input.stateRoot,'minions-home'),DB_PATH:join(input.stateRoot,'canvas.db'),CODEX_HOME:join(input.stateRoot,'codex-home'),CODEX_PATH:wrapper,PORT:String(input.port)};
  return {executable:'node',args:['--import','tsx','server/index.ts'],cwd:input.appRoot,environment,
    client:{endpoint:`ws://127.0.0.1:${input.port}`,stateRoot:input.stateRoot,codexExecutable:wrapper} satisfies MinionsClientConfiguration};
}
interface AdapterFactory { id:string;version:string;create(config:AdapterConfig):import('../core/contracts.js').ExecutionAdapter; }
export const adapterFactories=new ExtensionRegistry<AdapterFactory>();
adapterFactories.register({id:'codex-raw',version:'1.0.0',create:config=>new CodexRawAdapter(new LocalCodexProcessLauncher(String(config.settings.executable??'codex'),config.settings.stateRoot as string|undefined))});
for(const id of ['minion-single','minion-graph']) adapterFactories.register({id,version:'1.0.0',create:config=>new ManagedMinionsAdapter(config)});
export function createExternalAdapter(config:AdapterConfig) {return adapterFactories.get(config.adapterId,'1.0.0').create(config);}
