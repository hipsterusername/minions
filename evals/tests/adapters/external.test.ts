import { setTimeout as latency } from 'node:timers/promises';
import { LifecycleRunner } from '../../src/core/runner.js';
import { ResultStore } from '../../src/core/store.js';
import { EventStore } from '../../src/core/events.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRawAdapter, LocalCodexProcessLauncher, WebSocketMinionsProtocolClient, dedicatedInstanceRecipe, executionCommand } from '../../src/adapters/index.js';
import type { ParticipantRunSpec } from '../../schemas/index.js';
import { protocolServer } from './transport-fixture.js';
const cleanups:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function setup(body:string) {
  const root=await mkdtemp(join(tmpdir(),'eval-adapter-'));cleanups.push(()=>rm(root,{recursive:true,force:true}));
  const workspace=join(root,'workspace'),state=join(root,'state');await mkdir(workspace);await mkdir(state);await writeFile(join(workspace,'answer.txt'),'integrated');
  const executable=join(root,'fake-codex');
  await writeFile(executable,`#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);\nif(a.includes('--help')){console.log('--json --ephemeral');process.exit(0);}\nif(a.includes('--version')){console.log('fixture 1');process.exit(0);}\nif(a.includes('features')){console.log('multi_agent stable false\\nmulti_agent_v2 stable false');process.exit(0);}\n${body}`,{mode:0o700});
  const run:ParticipantRunSpec={schemaVersion:1,runId:'run',idempotencyKey:'key',taskId:'fixture',prompt:'fixture only',workspace:{id:'ws',mountPath:workspace},limits:{maxTotalTokens:1000,executionTimeoutMs:5000,preparationTimeoutMs:1000,gradingTimeoutMs:1000},configuration:{execution:{kind:'local',workdir:workspace,stateRoot:state}},visibleAssets:[]};
  return {root,workspace,state,executable,run};
}
describe('actual external subprocess launcher',()=>{
  it('probes both disabled features, launches once, replays after observer replacement and collects',async()=>{
    const fixture=await setup(`fs.appendFileSync('launches','1');console.log(JSON.stringify({type:'turn.started'}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:17,cached_input_tokens:4,output_tokens:5}}));`);
    const adapter=new CodexRawAdapter(new LocalCodexProcessLauncher(fixture.executable));
    const probe=await adapter.preflight({schemaVersion:1,adapterId:'codex-raw',settings:{},requiredCapabilities:[]});expect(probe,JSON.stringify(probe)).toMatchObject({supported:true});
    const handle=await adapter.start(fixture.run);const events=[];for await(const event of adapter.observe(handle))events.push(event);
    expect(events.at(-1)?.payload.usage).toEqual({input_tokens:17,cached_input_tokens:4,output_tokens:5});
    expect(events.at(-1)?.payload.normalizedUsage).toMatchObject({totalTokens:22,inputTokensUncached:13});
    const restarted=new CodexRawAdapter(new LocalCodexProcessLauncher(fixture.executable));
    const replay=[];for await(const event of restarted.observe(handle,1))replay.push(event);
    expect(replay).toHaveLength(1);expect(replay[0].sequence).toBe(2);
    expect((await restarted.inspect(handle)).terminalOutcome).toBe('completed');
    await restarted.start(fixture.run);expect(await readFile(join(fixture.workspace,'launches'),'utf8')).toBe('1');
    expect((await restarted.collect(handle)).artifacts.map(x=>x.path)).toContain('answer.txt');
    const launch=JSON.parse(await readFile(join(handle.handleId,'launch.json'),'utf8'));
    expect(launch.args).toEqual(expect.arrayContaining(['--disable','multi_agent','multi_agent_v2']));
  });
  it('retains original usage after cleanup and replays duplicates and corrected turns without double counting',async()=>{
    const original={input_tokens:17,cached_input_tokens:4,output_tokens:5,provider_detail:{billing:'unchanged'}};
    const records=[{type:'turn.started',turn_id:'one'},...[
      {turn_id:'one',revision:1,usage:original},{turn_id:'one',revision:1,usage:original},
      {turn_id:'one',revision:2,usage:{...original,input_tokens:20}},
      {turn_id:'one',revision:1,usage:original},
      {turn_id:'two',revision:1,usage:{input_tokens:6,output_tokens:2}},
    ].map(record=>({type:'turn.completed',...record}))];
    const f=await setup(`for(const record of ${JSON.stringify(records)})console.log(JSON.stringify(record));`);
    const first=new CodexRawAdapter(new LocalCodexProcessLauncher(f.executable));const handle=await first.start(f.run);
    const observed=[];for await(const e of first.observe(handle))observed.push(e);
    const adapter=new CodexRawAdapter(new LocalCodexProcessLauncher(f.executable));
    const replay=[];for await(const e of adapter.observe(handle,3))replay.push(e);
    expect(replay.at(-1)?.payload.normalizedUsage).toMatchObject({totalTokens:33});
    const options={experimentId:'fixture',aggregateTokenCap:1000,store:new ResultStore(join(f.root,'results','state.json')),events:new EventStore(join(f.root,'results','events.jsonl')),stopWriters:()=>rm(f.state,{recursive:true,force:true})};
    const slowTelemetry={id:adapter.id,version:adapter.version,preflight:adapter.preflight.bind(adapter),start:adapter.start.bind(adapter),inspect:adapter.inspect.bind(adapter),stop:adapter.stop.bind(adapter),collect:adapter.collect.bind(adapter),async *observe(h:typeof handle,after?:number){
      // Inject transport latency beyond the former one-second drain cutoff.
      await latency(1100);yield* adapter.observe(h,after);
    }};
    const runner=new LifecycleRunner(options,slowTelemetry);
    await runner.start({cell:{schemaVersion:1,cellId:'cell',experimentId:'fixture',taskId:'fixture',adapterId:'codex-raw',repetition:0,fixtureSeed:'seed',status:'planned'},spec:f.run});
    await runner.reconcile();
    const raw=await new EventStore(join(f.root,'results','usage.raw.jsonl')).read();
    expect(raw.map(e=>e.payload.usage)).toEqual(records.slice(1).map((e:any)=>e.usage));
    expect(raw[0].payload.usage).toEqual(original);
    expect((await options.store.getResult('run'))?.usage).toMatchObject({totalTokens:33});
    await expect(readFile(join(handle.handleId,'stdout.jsonl'))).rejects.toMatchObject({code:'ENOENT'});
    expect((await new EventStore(join(f.root,'results','usage.normalized.jsonl')).read()).at(-1)?.payload.usage).toMatchObject({totalTokens:33});
  });
  it('cancels an actual stubborn executable and its process group through persisted stop control',async()=>{
    const fixture=await setup(`process.on('SIGTERM',()=>{});const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(JSON.stringify({type:'child',pid:child.pid}));setInterval(()=>{},1000);`);
    const adapter=new CodexRawAdapter(new LocalCodexProcessLauncher(fixture.executable));const handle=await adapter.start(fixture.run);
    const observer=adapter.observe(handle);const first=await observer.next();const pid=first.value!.payload.pid as number;
    const restarted=new CodexRawAdapter(new LocalCodexProcessLauncher(fixture.executable));
    expect((await restarted.stop(handle,'cancelled')).descendantsAccountedFor).toBe(true);
    expect((await restarted.inspect(handle)).terminalOutcome).toBe('cancelled');
    // Linux may briefly retain a reparented zombie; it must not be executing.
    let alive=false;try{alive=!(await readFile(`/proc/${pid}/stat`,'utf8')).includes(') Z ');}catch{}expect(alive).toBe(false);
    await observer.return(undefined);
  });
  it('routes a backend Docker descriptor through docker exec without shell interpolation',()=>{
    expect(executionCommand({kind:'docker',containerName:'owned',workdir:'/workspace',stateRoot:'/controller'},'codex',['exec','a;echo nope'])).toEqual({executable:'docker',args:['exec','-w','/workspace','owned','codex','exec','a;echo nope']});
  });
});
describe('actual Minions HTTP/WS protocol',()=>{
  it('handles uncorrelated session replies, durable reconnect, history pagination and integrated collection',async()=>{
    const f=await setup('');let key='';let status='idle';
    const server=await protocolServer(m=>{
      if(m.type==='list_harnesses')return {type:'harness_list',harnesses:[{name:'codex'}]};
      if(m.type==='create_session'){key=m.sessionKey;return {type:'session_created',sessionKey:key};}
      if(m.type==='list_sessions')return {type:'session_list',sessions:[{sessionKey:key,status}]};
      if(m.type==='sync_session')return {type:'sync_response',sessionKey:m.sessionKey,found:true,status,turns:2,totalCost:0,usageTotals:{input:20,cacheRead:8,cacheCreation:6,output:10}};
      if(m.type==='stop_session'){status='stopped';return;}
      throw new Error(`unexpected ${m.type}`);
    },url=>url.includes('before=2')?{events:[{historyId:1,event:{kind:'text',text:'first'}}],history:{before:null}}:{events:[{historyId:2,event:{kind:'usage',input:10,output:5}}],history:{before:2}});
    cleanups.push(server.close);const config={endpoint:server.endpoint,stateRoot:f.state,codexExecutable:f.executable,workspaceId:'registered'};
    const client=new WebSocketMinionsProtocolClient(config);const handle=await client.launch({mode:'single',run:f.run,restrictions:{}});
    const events=[];for await(const e of client.events(handle))events.push(e);
    expect(events.filter(x=>x.eventId.includes(':history:')).map(x=>x.payload.historyId)).toEqual([1,2]);
    expect(events.at(-1)?.payload.usage).toMatchObject({totalTokens:44,reportedCostUSD:0});
    const reconnect=new WebSocketMinionsProtocolClient(config);const replay=[];for await(const e of reconnect.events(handle,events.length))replay.push(e);expect(replay).toEqual([]);
    expect((await reconnect.collect(handle)).artifacts[0].path).toBe('answer.txt');
    expect(server.commands.find(x=>x.type==='create_session')).toMatchObject({role:'minion',harness:'codex',worktreeIsolation:false});
    status='running';expect((await reconnect.cancel(handle,'cancelled')).descendantsAccountedFor).toBe(true);
  });
  it('starts a WorkItem graph and discovers continuations, failed attempts and children across paginated runs',async()=>{
    const f=await setup('');const runs=[{runKey:'leader',parentRunKey:null},{runKey:'retry-1',parentRunKey:'leader'},{runKey:'retry-2',parentRunKey:'leader'},{runKey:'continuation',parentRunKey:null}];
    const server=await protocolServer(m=>{
      if(m.type==='list_harnesses')return {type:'harness_list',harnesses:[{name:'codex'}]};
      if(m.type==='create_work_item')return {type:'work_item_response',requestId:m.requestId,result:{workItem:{id:'work',lifecycle:{lifecycleRevision:3},currentRunKey:null}}};
      if(m.type==='start_work_item_run')return {type:'work_item_response',requestId:m.requestId,result:{currentRun:{runKey:'leader'}}};
      if(m.type==='list_sessions')return {type:'session_list',sessions:[]};
      if(m.type==='get_work_item_runs')return {type:'work_item_response',command:m.type,result:{runs:m.cursor?runs.slice(2):runs.slice(0,2),nextCursor:m.cursor?null:'page2'}};
      if(m.type==='sync_session')return {type:'sync_response',sessionKey:m.sessionKey,found:true,status:m.sessionKey==='retry-1'?'error':'idle',usageTotals:{input:10,output:5,cacheRead:4,cacheCreation:3},turns:1,totalCost:0};
      if(m.type==='list_task_graph_attempts')return {type:'task_graph_response',requestId:m.requestId,result:[]};
      if(m.type==='get_task_graph_snapshot')return {type:'task_graph_snapshot',workItemId:'work',snapshot:{graphRunId:'graph',revision:4,status:'completed',nodes:[{id:'a'},{id:'b'}]}};
      throw new Error(m.type);
    });cleanups.push(server.close);
    const client=new WebSocketMinionsProtocolClient({endpoint:server.endpoint,stateRoot:f.state,codexExecutable:f.executable,workspaceId:'registered'});
    const handle=await client.launch({mode:'graph',run:f.run,restrictions:{}});
    expect((await client.snapshot(handle)).participants.map(x=>x.id)).toEqual(runs.map(x=>x.runKey));
    expect(server.commands.find(x=>x.type==='start_work_item_run')).toMatchObject({expectedLifecycleRevision:3,orchestrationMode:'auto'});
    const events=[];for await(const e of client.events(handle))events.push(e);
    expect(events.filter(e=>e.type==='usage').at(-1)?.payload.usage).toMatchObject({totalTokens:88});
    expect((await client.snapshot(handle)).terminalOutcome).toBe('completed');
  });
  it('prepares dedicated state and a feature-enforcing executable wrapper without launching providers',async()=>{
    const f=await setup('');const recipe=await dedicatedInstanceRecipe({stateRoot:f.state,appRoot:f.root,codexExecutable:f.executable,port:3142});
    expect(recipe.environment.MINIONS_HOME).toBe(join(f.state,'minions-home'));
    expect(await readFile(recipe.environment.CODEX_PATH,'utf8')).toContain('--disable multi_agent --disable multi_agent_v2');
  });
});
