import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMAND_SCHEMAS } from '../../server/commands/schemas';
import { isValidThinkingConfig } from '../../server/session-host-config';
import { WebSocketMinionsProtocolClient } from '../../evals/src/adapters/minions-client';
const roots:string[]=[];
afterEach(async()=>{vi.unstubAllGlobals();await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
for(const mode of ['single','graph'] as const) it(`actual ${mode} commands and crash recovery satisfy app contracts`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'wire-contract-'));roots.push(root);await mkdir(join(root,'workspace'));
  const executable=join(root,'features');await writeFile(executable,'#!/bin/sh\nprintf "multi_agent stable false\\nmulti_agent_v2 stable false\\n"\n',{mode:0o700});
  const commands:any[]=[];let failStart=mode==='graph';let createId='';let startId='';
  class Socket extends EventTarget {
    constructor(_url:string){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
    close(){}
    send(data:string){const c=JSON.parse(data);commands.push(c);
      const schema=COMMAND_SCHEMAS[c.type as keyof typeof COMMAND_SCHEMAS];if(!schema.safeParse(c).success){queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({requestId:c.requestId,success:false,error:JSON.stringify(schema.safeParse(c))})})));return;}
      let result:any;
      if(c.type==='list_harnesses')result={harnesses:[{name:'codex'}]};
      if(c.type==='create_session')result={sessionKey:c.sessionKey};
      if(c.type==='create_work_item'){createId=c.requestId;result={workItem:{id:'work',lifecycle:{lifecycleRevision:0},currentRunKey:null}};}
      if(c.type==='start_work_item_run'){startId=c.requestId;if(failStart){failStart=false;queueMicrotask(()=>this.dispatchEvent(new Event('error')));return;}result={currentRun:{runKey:'leader'}};}
      if(c.type==='get_work_item_receipt')result=c.requestId===createId?{workItem:{id:'work'}}:{currentRun:{runKey:'leader'}};
      queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({requestId:c.requestId,result})})));
    }
  }
  vi.stubGlobal('WebSocket',Socket);
  const config={endpoint:'ws://fixture.invalid?token=fixture',stateRoot:root,codexExecutable:executable,workspaceId:'12345678-1234-4234-8234-123456789abc'};
  const run={schemaVersion:1 as const,runId:'r',idempotencyKey:'r',taskId:'fixture',prompt:'fixture only',workspace:{id:'w',mountPath:join(root,'workspace')},limits:{maxTotalTokens:10,executionTimeoutMs:1000,preparationTimeoutMs:1000,gradingTimeoutMs:1000},configuration:{model:'fixture-model',reasoningEffort:'high',execution:{kind:'local',workdir:join(root,'workspace'),stateRoot:root}},visibleAssets:[]};
  const launch=()=>new WebSocketMinionsProtocolClient(config).launch({mode,run,restrictions:{}});
  if(mode==='graph')await expect(launch()).rejects.toThrow('WS connection failed');
  const handle=await launch();expect(await launch()).toEqual(handle);
  const mutation=commands.find(c=>c.type===(mode==='graph'?'start_work_item_run':'create_session'));
  expect(mutation.thinkingConfig).toEqual({enabled:true,effort:'high',display:'summarized'});expect(isValidThinkingConfig(mutation.thinkingConfig)).toBe(true);
  const saved=JSON.parse(await readFile(join(root,'minions',handle.handleId,'handle.json'),'utf8'));
  expect(saved.resolvedTreatment.thinkingConfig).toEqual(mutation.thinkingConfig);
  expect(commands.filter(c=>c.type===mutation.type)).toHaveLength(1);
  if(mode==='graph'){expect(commands.filter(c=>c.type==='get_work_item_receipt').map(c=>c.requestId)).toEqual([createId,startId]);expect(saved.mutationIds).toEqual({create:createId,start:startId});}
});

it('rejects unsupported treatment before protocol or executable access',async()=>{
 const client=new WebSocketMinionsProtocolClient({endpoint:'ws://invalid',stateRoot:'/unused',codexExecutable:'/unused'});
 for(const configuration of [{reasoningEffort:'ultra'},{temperature:0.2},{thinkingConfig:{enabled:true}}]) await expect(client.launch({mode:'single',restrictions:{},run:{configuration} as any})).rejects.toThrow(/unsupported/);
});
