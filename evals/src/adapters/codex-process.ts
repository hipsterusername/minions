import { executableFingerprint } from './fingerprint.js';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { ParticipantRunSpec, ExecutionSnapshot } from '../../schemas/index.js';
import type { CodexProcessLauncher, ProcessRun } from './protocol.js';
import { command, collectWorkspace, executionCommand, executionDescriptor } from './execution.js';
import { supervisorSource } from './supervisor.js';

export class LocalCodexProcessLauncher implements CodexProcessLauncher {
  constructor(private readonly executable = 'codex', private readonly stateRoot?: string) {}
  async probe() {
    const [help, version, features] = await Promise.all([
      command(this.executable,['exec','--help']), command(this.executable,['--version']),
      command(this.executable,['--disable','multi_agent','--disable','multi_agent_v2','features','list'])]);
    return {executable:this.executable,binaryDigest:await executableFingerprint(this.executable),version:version.trim(),supportsJson:help.includes('--json'),supportsEphemeral:help.includes('--ephemeral'),
      supportsDisableDelegation: ['multi_agent','multi_agent_v2'].every(name=>new RegExp(`^${name}\\s+.*\\sfalse$`,'m').test(features)), supportsReconnect:true};
  }
  async launch(input: {run:ParticipantRunSpec;args:string[];environment:Record<string,string>}): Promise<ProcessRun> {
    const execution = executionDescriptor(input.run,this.stateRoot);
    const id = join(execution.stateRoot,'codex',createHash('sha256').update(input.run.idempotencyKey).digest('hex'));
    await mkdir(join(execution.stateRoot,'codex'),{recursive:true});
    try { await mkdir(id); } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; return this.reconnect(id); }
    const home=execution.kind==='docker'?`/tmp/eval-codex-${createHash('sha256').update(input.run.idempotencyKey).digest('hex').slice(0,16)}`:join(id,'codex-home');
    if(execution.kind==='local')await mkdir(home,{recursive:true,mode:0o700});
    const environment={...input.environment,CODEX_HOME:home};
    const launch = executionCommand(execution,this.executable,[...input.args,input.run.prompt],environment);
    await writeFile(join(id,'launch.json'),JSON.stringify({...launch,cwd:input.run.workspace.mountPath,env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','LANG','TMPDIR','SYSTEMROOT','OPENAI_API_KEY','CODEX_API_KEY'].includes(key))),...environment},createdAt:new Date().toISOString(),containerName:execution.containerName,workspace:input.run.workspace.mountPath}),{mode:0o600});
    // State is claimed before spawn: an uncertain launch is never automatically re-executed.
    const supervisor = spawn(process.execPath,['-e',supervisorSource,id],{detached:true,stdio:'ignore'});
    await new Promise<void>((resolve,reject)=>{supervisor.once('spawn',resolve);supervisor.once('error',reject);}); supervisor.unref();
    return this.reconnect(id);
  }
  reconnect(id: string): ProcessRun { return new DurableProcessRun(id); }
}
export class DurableProcessRun implements ProcessRun {
  constructor(readonly id:string) {}
  get createdAt():string {return JSON.parse(readFileSync(join(this.id,'launch.json'),'utf8')).createdAt;}
  get events() { return this.readEvents(); }
  private async *readEvents(): AsyncIterable<Record<string,unknown>> {
    let offset=0;
    for (;;) {
      // Observe terminal first so the final read includes all bytes written before exit.
      const terminal=(await this.inspect()).terminal;
      let data=''; try {data=await readFile(join(this.id,'stdout.jsonl'),'utf8');} catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const end=terminal?data.length:data.lastIndexOf('\n')+1;
      for(const line of data.slice(offset,end).split('\n').filter(Boolean)) {
        try {yield JSON.parse(line) as Record<string,unknown>;} catch {yield {type:'error',message:'invalid Codex JSONL',raw:line};}
      }
      offset=end; if(terminal)return; await delay(30);
    }
  }
  async inspect(): Promise<{terminal:boolean;outcome:ExecutionSnapshot['terminalOutcome']}> {
    try {const exit=JSON.parse(await readFile(join(this.id,'exit.json'),'utf8'));return {terminal:true,outcome:exit.outcome};} catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    try {const p=JSON.parse(await readFile(join(this.id,'process.json'),'utf8'));process.kill(p.supervisorPid,0);} catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return {terminal:true,outcome:'interrupted'};}
    const age=Date.now()-(await stat(this.id)).mtimeMs;
    try{await stat(join(this.id,'process.json'));}catch {if(age>10_000)return {terminal:true,outcome:'interrupted'};}
    return {terminal:false,outcome:null};
  }
  async stop(): Promise<boolean> {
    if((await this.inspect()).outcome==='interrupted') {
      const spec=JSON.parse(await readFile(join(this.id,'launch.json'),'utf8'));
      if(spec.containerName)await command('docker',['kill',spec.containerName]);
      try {const p=JSON.parse(await readFile(join(this.id,'process.json'),'utf8'));process.kill(-p.pid,'SIGKILL');}catch(error){if(!['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
    }
    await writeFile(join(this.id,'stop.json'),JSON.stringify({at:new Date().toISOString()}));
    for(let i=0;i<100;i++){if((await this.inspect()).terminal)return true;await delay(30);} return false;
  }
  async collect() {
    if(!(await this.inspect()).terminal)throw new Error('cannot collect a live participant');
    const spec=JSON.parse(await readFile(join(this.id,'launch.json'),'utf8'));
    return collectWorkspace(spec.workspace);
  }
}
