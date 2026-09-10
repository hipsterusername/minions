import { resolveTreatment } from './treatment.js';
import { applicationFingerprint, executableFingerprint } from './fingerprint.js';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { AdapterConfig, ParticipantRunSpec, RunHandle, ExecutionSnapshot, RunEvent } from '../../schemas/index.js';
import type { ExecutionAdapter, StopReason } from '../core/contracts.js';
import { atomicJson, safeId } from '../core/durable.js';
import { dedicatedInstanceRecipe } from './factory.js';
import { DurableProcessRun } from './codex-process.js';
import { supervisorSource } from './supervisor.js';
import { command, executionCommand, executionDescriptor, type ExecutionDescriptor } from './execution.js';
import { WebSocketMinionsProtocolClient, type MinionsClientConfiguration } from './minions-client.js';
import { MinionSingleAdapter, MinionGraphAdapter } from './minions.js';
import { report } from './protocol.js';

interface Instance { processRoot:string; client:MinionsClientConfiguration; run:ParticipantRunSpec; }
/** Owns one dedicated server per run; the participant deadline includes server startup. */
export class ManagedMinionsAdapter implements ExecutionAdapter {
  readonly version='1.0.0';
  readonly id:string;
  constructor(readonly config:AdapterConfig) { this.id=config.adapterId; }
  private root(runId:string) { return join(String(this.config.settings.stateRoot),'instances',safeId(runId)); }
  async preflight(config:AdapterConfig) {
    resolveTreatment(config.settings);
    const s={...this.config.settings,...config.settings};
    if (s.endpoint) throw new Error('controller owns the Minions endpoint; configure appRoot and codexExecutable');
    if (![s.appRoot,s.codexExecutable,s.stateRoot].every(x=>typeof x==='string'&&isAbsolute(x))) throw new Error('Minions requires absolute appRoot, codexExecutable and controller stateRoot');
    // Image contents are checked in the prepared container before a participant starts.
    if (s.isolation !== 'docker') {
      await readFile(join(String(s.appRoot),'server/index.ts'));
      await command(String(s.codexExecutable),['--disable','multi_agent','--disable','multi_agent_v2','features','list']).then(out=>{
        if (!['multi_agent','multi_agent_v2'].every(name=>new RegExp(`^${name}\\s+.*\\sfalse$`,'m').test(out))) throw new Error('Codex delegation controls not effective');
      });
    }
    const fingerprint=s.isolation==='docker'?'runtime pinned by image digest':`app sha256:${await applicationFingerprint(String(s.appRoot))}; codex sha256:${await executableFingerprint(String(s.codexExecutable))}`;
    return report(this.id,this.version,true,{dedicated_instance:true,durable_supervisor:true,external_protocol:true},[],[fingerprint,'Controller owns server startup, endpoint, isolated state and cleanup; app protocol probed before participant admission']);
  }
  private async saved(runId:string):Promise<Instance> { return JSON.parse(await readFile(join(this.root(runId),'instance.json'),'utf8')); }
  private async failure(runId:string):Promise<{message:string;handle?:RunHandle}|null> {
    try { return JSON.parse(await readFile(join(this.root(runId),'startup-error.json'),'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return null; throw error; }
  }
  private async recordFailure(run:ParticipantRunSpec,error:unknown):Promise<RunHandle> {
    const handle=this.failedHandle(run);
    await atomicJson(join(this.root(run.runId),'startup-error.json'),{message:String(error),handle});
    return handle;
  }
  private adapter(instance:Instance) {
    const client=new WebSocketMinionsProtocolClient(instance.client);
    return this.id==='minion-single'?new MinionSingleAdapter(client):new MinionGraphAdapter(client);
  }
  async start(run:ParticipantRunSpec):Promise<RunHandle> {
    resolveTreatment(run.configuration);
    const root=this.root(run.runId); await mkdir(join(root,'..'),{recursive:true});
    let instance:Instance;
    try { await mkdir(root); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code!=='EEXIST') throw e;
      const failure=await this.failure(run.runId);
      if (failure) return failure.handle ?? this.recordFailure(run,failure.message);
      try { instance=await this.saved(run.runId); return await this.ready(instance,run); }
      catch (error) { await this.shutdown(run.runId); return this.recordFailure(run,error); }
    }
    try {
    const execution=executionDescriptor(run); const appRoot=String(this.config.settings.appRoot), codexExecutable=String(this.config.settings.codexExecutable);
    const port=execution.kind==='docker'?43127:await availablePort();
    let recipe:Awaited<ReturnType<typeof dedicatedInstanceRecipe>>;
    if (execution.kind==='local') recipe=await dedicatedInstanceRecipe({stateRoot:join(root,'state'),appRoot,codexExecutable,port});
    else {
      const state='/state/eval-server'; const wrapper=state+'/codex-no-delegation';
      const script=`const fs=require('node:fs');fs.mkdirSync(${JSON.stringify(state+'/codex-home')},{recursive:true});fs.mkdirSync(${JSON.stringify(state+'/minions-home')},{recursive:true});fs.writeFileSync(${JSON.stringify(wrapper)},${JSON.stringify('#!/bin/sh\nexec '+quote(codexExecutable)+' --disable multi_agent --disable multi_agent_v2 "$@"\n')},{mode:448});`;
      await command('docker',['exec',execution.containerName!,'node','-e',script]);
      recipe={executable:'node',args:['--import','tsx','server/index.ts'],cwd:appRoot,environment:{MINIONS_HOME:state+'/minions-home',DB_PATH:state+'/canvas.db',CODEX_HOME:state+'/codex-home',CODEX_PATH:wrapper,PORT:String(port)},client:{endpoint:`ws://127.0.0.1:${port}`,stateRoot:root,codexExecutable:wrapper}};
    }
    const processRoot=join(root,'server'); await mkdir(processRoot);
    instance={processRoot,client:{...recipe.client,stateRoot:root,execution},run};
    await atomicJson(join(root,'instance.json'),instance);
    const launch=executionCommand({...execution,workdir:appRoot},recipe.executable,recipe.args,recipe.environment);
    await writeFile(join(processRoot,'launch.json'),JSON.stringify({...launch,cwd:execution.kind==='local'?appRoot:run.workspace.mountPath,env:{PATH:process.env.PATH,LANG:'C.UTF-8',...Object.fromEntries(Object.entries(process.env).filter(([key])=>['OPENAI_API_KEY','CODEX_API_KEY'].includes(key))),...recipe.environment},containerName:execution.containerName,createdAt:new Date().toISOString(),workspace:run.workspace.mountPath}),{mode:0o600});
    const supervisor=spawn(process.execPath,['-e',supervisorSource,processRoot],{detached:true,stdio:'ignore'});
    await new Promise<void>((resolve,reject)=>{supervisor.once('spawn',resolve);supervisor.once('error',reject);});supervisor.unref();
    return await this.ready(instance,run);
    } catch (error) {
      await this.shutdown(run.runId);
      return this.recordFailure(run,error);
    }
  }
  private failedHandle(run:ParticipantRunSpec):RunHandle { return {schemaVersion:1,adapterId:this.id,handleId:createHash('sha256').update(run.idempotencyKey).digest('hex'),runId:run.runId,createdAt:new Date().toISOString()}; }
  private async ready(instance:Instance,run:ParticipantRunSpec):Promise<RunHandle> {
    const processRoot=instance.processRoot;
    const adapter=this.adapter(instance); let error:unknown;
    const deadline=Date.now()+Math.min(30000,run.limits.executionTimeoutMs);
    do {
      if ((await new DurableProcessRun(processRoot).inspect()).terminal) throw new Error('dedicated Minions server exited; inspect retained server/stderr.log');
      try { const probe=await adapter.preflight(this.config); if (!probe.supported) throw new Error(probe.limitations.join('; ')); return await adapter.start(run); }
      catch (e) { error=e; }
      await delay(100);
    } while(Date.now()<deadline);
    await this.shutdown(run.runId);throw new Error(`dedicated Minions startup failed: ${String(error)}`);
  }
  async *observe(handle:RunHandle,after?:number):AsyncIterable<RunEvent> {
    const failure=await this.failure(handle.runId);
    if (failure) {
      if ((after ?? -1)<0) yield {schemaVersion:1,eventId:handle.runId+'-startup-error',experimentId:'pending',runId:handle.runId,sequence:0,observedAt:handle.createdAt,providerTimestamp:null,adapterId:this.id,participantId:null,sessionId:null,turnId:null,type:'error',payload:{message:failure.message,phase:'startup'}};
      return;
    }
    yield* this.adapter(await this.saved(handle.runId)).observe(handle,after);
  }
  async inspect(handle:RunHandle):Promise<ExecutionSnapshot> {
    if (await this.failure(handle.runId)) return {schemaVersion:1,handle,state:'terminal',terminalOutcome:'infra_error',participants:[],observedAt:new Date().toISOString()};
    const instance=await this.saved(handle.runId).catch(()=>null);
    if (!instance || (await new DurableProcessRun(instance.processRoot).inspect()).terminal) return {schemaVersion:1,handle,state:'terminal',terminalOutcome:'interrupted',participants:[],observedAt:new Date().toISOString()};
    return this.adapter(instance).inspect(handle);
  }
  async stop(handle:RunHandle,reason:StopReason) {
    const instance=await this.saved(handle.runId).catch(()=>null);
    if (!instance) return {schemaVersion:1 as const,handle,reason,accepted:true,descendantsAccountedFor:true,stoppedAt:new Date().toISOString()};
    try { return await this.adapter(instance).stop(handle,reason); }
    catch { const accepted=await new DurableProcessRun(instance.processRoot).stop(); return {schemaVersion:1 as const,handle,reason,accepted,descendantsAccountedFor:accepted,stoppedAt:new Date().toISOString()}; }
  }
  async collect(handle:RunHandle) {
    const failure=await this.failure(handle.runId);
    if (failure) return {schemaVersion:1 as const,handle,artifacts:[],provenance:{startupError:failure.message,protocolAdherence:'unverified'},usageCoverage:'unavailable' as const,logTruncated:false};
    return this.adapter(await this.saved(handle.runId)).collect(handle);
  }
  async shutdown(runId:string) {
    try { const instance=await this.saved(runId); if (!await new DurableProcessRun(instance.processRoot).stop()) throw new Error('dedicated server did not stop'); }
    catch(e) { if ((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
  }
}
function quote(s:string) {return "'"+s.replaceAll("'","'\\''")+"'";}
async function availablePort():Promise<number> {
  const server=createServer();await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;
}
