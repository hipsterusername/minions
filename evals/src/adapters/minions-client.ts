import { resolveTreatment } from './treatment.js';
import { atomicJson } from '../core/durable.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExecutionSnapshot, ParticipantRunSpec, RunEvent, RunHandle } from '../../schemas/index.js';
import type { CollectedExecution, StopReason } from '../core/contracts.js';
import type { MinionsProtocolClient } from './protocol.js';
import { UsageLedger } from '../telemetry/usage.js';
import { ContainerMinionsTransport } from './container-transport.js';
import { MinionsTransport } from './minions-transport.js';
import { collectWorkspace, command, executionDescriptor } from './execution.js';

export interface MinionsClientConfiguration {
  endpoint:string; stateRoot:string;
  /** Dedicated CODEX_PATH wrapper from dedicatedInstanceRecipe; checked non-generatively. */
  codexExecutable:string;
  execution?:import("./execution.js").ExecutionDescriptor; workspaceId?:string; requestTimeoutMs?:number; pollMs?:number;
}
interface SavedRun { handle:RunHandle; run:ParticipantRunSpec; sessionKey:string; workItemId?:string; mode:'single'|'graph'; mutationIds:{create:string;start:string}; resolvedTreatment:ReturnType<typeof resolveTreatment>; stopped?:boolean }
const terminal=(status:string)=>['idle','done','completed','stopped','error','failed','cancelled'].includes(status);
export class WebSocketMinionsProtocolClient implements MinionsProtocolClient {
  private readonly transport:MinionsTransport;
  readonly config:MinionsClientConfiguration;
  constructor(config:MinionsClientConfiguration|string) {
    this.config=typeof config==='string'?{endpoint:config,stateRoot:process.env.EVAL_MINIONS_STATE_ROOT??'',codexExecutable:process.env.EVAL_MINIONS_CODEX_PATH??'codex'}:config;
    this.transport=this.config.execution?.kind === "docker" ? new ContainerMinionsTransport(this.config.endpoint,this.config.execution,this.config.requestTimeoutMs) : new MinionsTransport(this.config.endpoint,this.config.requestTimeoutMs);
  }
  async probe() {
    const harnesses=await this.transport.request({type:'list_harnesses'},'harness_list');
    const features=this.config.execution?.kind==='docker' ? await command('docker',['exec',this.config.execution.containerName!,this.config.codexExecutable,'features','list']) : await command(this.config.codexExecutable,['features','list']);
    const disabled=['multi_agent','multi_agent_v2'].every(name=>new RegExp(`^${name}\\s+.*\\sfalse$`,'m').test(features));
    const codex=(harnesses.harnesses ?? []).find((h:any)=>h.name==='codex');
    return {protocolVersion:1,capabilities:{dedicated_state:Boolean(this.config.stateRoot),session_reconnect:true,session_tree:true,usage_export:true,
      workspace_collection:true,stop_descendants:true,role_tool_restrictions:disabled&&Boolean(codex),headless_graph_start:Boolean(codex),
      graph_self_decomposition:true,graph_min_nodes_2:true,graph_terminal_quiescence:true},
      evidence:['App list_harnesses transport succeeded','WorkItem get_work_item_runs pagination, graph snapshots, sync_session and HTTP history are used',
        `CODEX_PATH delegation feature check: ${disabled}`,'Dedicated instance identity and isolation must be supplied by controller startup recipe; minimum graph nodes verified at completion']};
  }
  private directory(id:string) {return join(this.config.stateRoot,'minions',id);}
  private async save(value:SavedRun) {const file=join(this.directory(value.handle.handleId),'handle.json');await atomicJson(file,value);}
  private async load(handle:RunHandle):Promise<SavedRun> {
    if(!/^[a-f0-9]{64}$/.test(handle.handleId))throw new Error('invalid Minions durable handle');
    const saved:SavedRun=JSON.parse(await readFile(join(this.directory(handle.handleId),'handle.json'),'utf8'));
    if(saved.mode==='graph'&&saved.sessionKey.startsWith('eval-')) {
      if(!saved.mutationIds)throw new Error('legacy graph handle has invalid receipt identities; refusing re-execution');
      const created=await this.transport.request({type:'get_work_item_receipt',requestId:saved.mutationIds.create});
      if(!created.workItem)throw new Error('uncertain WorkItem creation; receipt pending; refusing re-execution');
      saved.workItemId=created.workItem.id;
      const started=await this.transport.request({type:'get_work_item_receipt',requestId:saved.mutationIds.start,workItemId:saved.workItemId});
      if(!started.currentRun)throw new Error('uncertain WorkItem launch; receipt pending; refusing re-execution');
      saved.sessionKey=started.currentRun.runKey;await this.save(saved);
    }
    return saved;
  }
  async launch(input:{mode:'single'|'graph';run:ParticipantRunSpec;restrictions:Record<string,unknown>}):Promise<RunHandle> {
    const {run,mode}=input; const resolvedTreatment=resolveTreatment(run.configuration); executionDescriptor(run,this.config.stateRoot);
    const handleId=createHash('sha256').update(run.idempotencyKey).digest('hex');
    const handle:RunHandle={schemaVersion:1,adapterId:mode==='single'?'minion-single':'minion-graph',handleId,runId:run.runId,createdAt:new Date().toISOString()};
    await mkdir(join(this.config.stateRoot,'minions'),{recursive:true});
    try{await mkdir(this.directory(handleId));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;return (await this.load(handle)).handle;}
    const saved:SavedRun={handle,run,mode,sessionKey:`eval-${handleId}`,mutationIds:{create:randomUUID(),start:randomUUID()},resolvedTreatment}; await this.save(saved);
    const probe=await this.probe();if(!probe.capabilities.role_tool_restrictions)throw new Error('dedicated Codex wrapper must disable multi_agent and multi_agent_v2');
    const workspaceId=this.config.workspaceId ?? await this.registerWorkspace(run);
    const settings={harness:'codex',...saved.resolvedTreatment,permissionMode:'acceptEdits',sandboxPolicy:{filesystemScope:'workspace-write',approvalPolicy:'never'},skillIds:[]};
    if(mode==='single') {
      await this.transport.request({type:'create_session',sessionKey:saved.sessionKey,workspaceId,role:'minion',worktreeIsolation:false,
        prompt:run.prompt,systemPrompt:'Complete the assignment directly. Do not delegate, spawn agents, or create execution graphs.',...settings},'session_created');
    }else {
      const detail=await this.transport.request({type:'create_work_item',requestId:saved.mutationIds.create,workspaceId,title:run.taskId,changeMode:'live'});
      saved.workItemId=detail.workItem.id;await this.save(saved);
      const started=await this.transport.request({type:'start_work_item_run',requestId:saved.mutationIds.start,workItemId:saved.workItemId,
        expectedLifecycleRevision:detail.workItem.lifecycle.lifecycleRevision,expectedCurrentRunKey:detail.workItem.currentRunKey,
        orchestrationMode:'auto',prompt:`${run.prompt}\n\nUse a participant-authored execution graph with at least two meaningful nodes. Execute the graph, integrate its outputs into the workspace, and verify the result.`,...settings});
      saved.sessionKey=started.currentRun.runKey;await this.save(saved);
    }
    return handle;
  }
  private async registerWorkspace(run:ParticipantRunSpec):Promise<string> {
    const base=new URL(this.config.endpoint);base.protocol=base.protocol==='wss:'?'https:':'http:';base.pathname='/api/projects';
    const path=(run.configuration.execution as {workdir?:string}|undefined)?.workdir ?? run.workspace.mountPath;
    const existing=(await this.transport.http('/api/projects') as any[]).find(p=>(p.sourceRoot??p.path)===path);if(existing)return existing.workspaceId??existing.id;
    // This is the fresh evaluator-owned fixture, so initialize its Git baseline
    // explicitly instead of leaving the application's registration gate pending.
    const project=await this.transport.http('/api/projects',{method:'POST',body:JSON.stringify({name:run.taskId,path,gitAction:'initialize'})});
    return project.workspaceId??project.id;
  }
  private async discover(saved:SavedRun):Promise<{sessions:any[];graph:any}> {
    const inventory=await this.transport.request({type:'list_sessions'},'session_list');
    const selected=new Map<string,any>();selected.set(saved.sessionKey,{sessionKey:saved.sessionKey,parentRunKey:null});
    if(saved.workItemId){
      let cursor:string|undefined;const cursors=new Set<string>();
      do {const page=await this.transport.request({type:'get_work_item_runs',workItemId:saved.workItemId,cursor,limit:100},'work_item_response');
        for(const run of page.runs)selected.set(run.runKey,{...run,sessionKey:run.runKey});cursor=page.nextCursor??undefined;
        if(cursor){if(cursors.has(cursor))throw new Error('repeated WorkItem cursor');cursors.add(cursor);}
      }while(cursor);
    }
    let changed=true;while(changed){changed=false;for(const session of inventory.sessions??[]){
      if(selected.has(session.sessionKey)||session.workItemId===saved.workItemId&&saved.workItemId||selected.has(session.parentRunKey)){
        if(!selected.has(session.sessionKey))changed=true;selected.set(session.sessionKey,{...selected.get(session.sessionKey),...session});
        for(const child of session.activeMinions??[])if(child.sessionKey&&!selected.has(child.sessionKey)){selected.set(child.sessionKey,{sessionKey:child.sessionKey,parentRunKey:session.sessionKey});changed=true;}
      }
    }}
    const reply=saved.workItemId?await this.transport.request({type:'get_task_graph_snapshot',workItemId:saved.workItemId},'task_graph_snapshot'):null;
    const graph=reply?.snapshot??reply;
    if(graph?.graphRunId){
      const attempts=await this.transport.request({type:'list_task_graph_attempts',workItemId:saved.workItemId,runId:graph.graphRunId});
      for(const attempt of attempts)if(attempt.sessionId&&!selected.has(attempt.sessionId))selected.set(attempt.sessionId,{sessionKey:attempt.sessionId,parentRunKey:saved.sessionKey,attemptId:attempt.id});
    }
    const sessions=[];for(const entry of selected.values()){
      const sync=await this.transport.request({type:'sync_session',sessionKey:entry.sessionKey},'sync_response');
      sessions.push({...entry,...sync});
    }
    return {sessions,graph};
  }
  async snapshot(handle:RunHandle):Promise<ExecutionSnapshot> {
    const saved=await this.load(handle);const {sessions,graph}=await this.discover(saved);
    const participants=sessions.map(s=>({id:s.sessionKey,parentId:s.parentRunKey??null,state:s.status??(s.endedAt?'completed':'unknown'),terminal:s.endedAt!=null||terminal(s.status)}));
    const quiet=participants.every(p=>p.terminal)&&(!graph||['completed','failed','cancelled'].includes(graph.status));
    const graphValid=saved.mode!=='graph'||Boolean(graph&&graph.nodes?.length>=2&&graph.status==='completed');
    return {schemaVersion:1,handle,state:quiet?'terminal':'running',terminalOutcome:quiet?(saved.stopped?'cancelled':!graphValid||saved.mode==='single'&&sessions.some(s=>['error','failed'].includes(s.status))?'failed':'completed'):null,participants,observedAt:new Date().toISOString()};
  }
  async *events(handle:RunHandle,afterSequence=0):AsyncIterable<RunEvent> {
    const saved=await this.load(handle);const file=join(this.directory(handle.handleId),'events.json');
    let ledger:RunEvent[]=[];try{ledger=JSON.parse(await readFile(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const usageLedger=new UsageLedger();
    for(const event of ledger)if(event.payload.kind==='cumulative_session')usageLedger.ingest(event.payload as any);
    const seen=new Set(ledger.map(e=>e.eventId));let delivered=afterSequence;
    const add=(id:string,session:string|null,type:RunEvent['type'],payload:Record<string,unknown>)=>{
      if(seen.has(id))return;seen.add(id);if(payload.kind==='cumulative_session'){usageLedger.ingest(payload as any);payload={...payload,usage:usageLedger.aggregate([...seen].filter(x=>x.startsWith('participant:')).map(x=>x.slice(12))).usage};}ledger.push({schemaVersion:1,eventId:id,experimentId:String(saved.run.configuration.experimentId??'external'),runId:handle.runId,sequence:ledger.length+1,observedAt:new Date().toISOString(),providerTimestamp:null,adapterId:handle.adapterId,participantId:session,sessionId:session,turnId:null,type,payload});
    };
    for(;;){
      const {sessions,graph}=await this.discover(saved);
      for(const session of sessions)add(`participant:${session.sessionKey}`,session.sessionKey,'participant_discovered',{parentId:session.parentRunKey??null});
      for(const session of sessions){
        const history=await this.transport.history(session.sessionKey);
        for(const event of history){const payload=event.event??event;add(`${session.sessionKey}:history:${event.historyId}`,session.sessionKey,payload.kind==='usage'?'usage':'lifecycle',{...payload,historyId:event.historyId});}
        const usage=session.usageTotals;
        if(usage)add(`${session.sessionKey}:totals:${createHash('sha256').update(JSON.stringify([usage,session.totalCost,session.turns,session.status])).digest('hex')}`,session.sessionKey,'usage',{
          ...usage,sourceId:'session',kind:'cumulative_session',semantics:'minions_codex',participantId:session.sessionKey,turnId:null,
          sequence:history.at(-1)?.historyId??0,coversThroughSequence:history.at(-1)?.historyId??0,cacheWrite:usage.cacheCreation,reportedCostUSD:session.totalCost,
          coverage:terminal(session.status)&&!['stopped','error'].includes(session.status)?'complete':'partial',coverageReasons:terminal(session.status)?[]:['in-flight usage may be unreported']});
      }
      if(graph)add(`graph:${graph.graphRunId}:${graph.revision}`,null,'graph_changed',graph);
      await writeFile(file+'.tmp',JSON.stringify(ledger),{mode:0o600});await rename(file+'.tmp',file);
      for(const event of ledger)if(event.sequence>delivered){delivered=event.sequence;yield event;}
      if((await this.snapshot(handle)).state==='terminal')return;
      await delay(this.config.pollMs??250);
    }
  }
  async cancel(handle:RunHandle,reason:StopReason) {
    const saved=await this.load(handle);saved.stopped=true;await this.save(saved);
    for(let i=0;i<20;i++){
      const {sessions,graph}=await this.discover(saved);
      if(graph&&!['completed','failed','cancelled'].includes(graph.status))await this.transport.request({type:'cancel_task_graph_run',workItemId:saved.workItemId,runId:graph.graphRunId,expectedRunRevision:graph.revision});
      for(const session of sessions)if(!terminal(session.status)) {
        // stop_session is fire-and-forget. A subsequent sync verifies its effect.
        await this.transportSendStop(session.sessionKey);
      }
      if((await this.snapshot(handle)).state==='terminal')return {schemaVersion:1 as const,handle,reason,accepted:true,stoppedAt:new Date().toISOString(),descendantsAccountedFor:true};
      await delay(this.config.pollMs??250);
    }
    return {schemaVersion:1 as const,handle,reason,accepted:false,stoppedAt:new Date().toISOString(),descendantsAccountedFor:false};
  }
  private async transportSendStop(sessionKey:string) {
    await this.transport.send({type:'stop_session',sessionKey});
  }
  async collect(handle:RunHandle):Promise<CollectedExecution> {
    const snapshot=await this.snapshot(handle);if(snapshot.state!=='terminal')throw new Error('cannot collect until all descendants quiesce');
    const saved=await this.load(handle);const artifacts=await collectWorkspace(saved.run.workspace.mountPath);
    return {schemaVersion:1,handle,artifacts,provenance:{resolvedTreatment:saved.resolvedTreatment,mode:saved.mode,sessionKey:saved.sessionKey,workItemId:saved.workItemId??null,participants:snapshot.participants,workspace:'integrated live workspace',protocolAdherence:saved.mode==='single' ? (snapshot.participants.length===1?'valid':'violated') : ((await this.discover(saved)).graph?.nodes?.length>=2?'valid':'violated')},usageCoverage:'partial',logTruncated:false};
  }
}
