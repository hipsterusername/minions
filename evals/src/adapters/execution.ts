import { createHash } from 'node:crypto';
import { readdir, readFile, mkdtemp, open, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import type { ParticipantRunSpec } from '../../schemas/index.js';

/** Controller/backend-owned configuration, never parsed from participant files. */
export interface ExecutionDescriptor { kind: 'local' | 'docker'; containerName?: string; workdir: string; stateRoot: string }
export function executionDescriptor(run: ParticipantRunSpec, fallback?: string): ExecutionDescriptor {
  const value = run.configuration.execution as ExecutionDescriptor | undefined;
  const execution = value ?? { kind: 'local', workdir: run.workspace.mountPath, stateRoot: fallback ?? '' };
  if (!['local', 'docker'].includes(execution.kind) || !isAbsolute(execution.workdir) || !isAbsolute(execution.stateRoot)) throw new Error('absolute backend execution workdir/stateRoot required');
  const rel = relative(resolve(run.workspace.mountPath), resolve(execution.stateRoot));
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('supervisor stateRoot must be outside participant workspace');
  if (execution.kind === 'docker' && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(execution.containerName ?? '')) throw new Error('backend-owned Docker containerName required');
  return execution;
}
export function executionCommand(execution: ExecutionDescriptor, executable: string, args: string[], environment: Record<string,string> = {}) {
  return execution.kind === 'docker'
    ? { executable: 'docker', args: ['exec', '-w', execution.workdir, ...Object.entries(environment).flatMap(([key,value]) => ['-e', `${key}=${value}`]), execution.containerName!, executable, ...args] }
    : { executable, args };
}
export async function command(executable: string, args: string[]): Promise<string> {
  const root=await mkdtemp(join(tmpdir(),'eval-probe-'));
  const out=await open(join(root,'stdout'),'w');const err=await open(join(root,'stderr'),'w');
  try {
    await new Promise<void>((resolve,reject)=>{
      const child=spawn(executable,args,{stdio:['ignore',out.fd,err.fd]});
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`${executable} probe timed out`));},15_000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`${executable} exited ${code}`));});
    });
    return await readFile(join(root,'stdout'),'utf8');
  } finally {await out.close();await err.close();await rm(root,{recursive:true,force:true});}
}
export async function collectWorkspace(root: string) {
  const files: Array<{path:string;digest:string;bytes:number}> = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, {withFileTypes:true})) {
      const path = join(dir,entry.name);
      if (entry.isDirectory() && entry.name !== '.git') await visit(path);
      else if (entry.isFile()) { const bytes = await readFile(path); files.push({path:relative(root,path),digest:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length}); }
      else if (entry.isSymbolicLink()) throw new Error(`refusing symlink in collected workspace: ${entry.name}`);
    }
  }
  await visit(root); return files.sort((a,b)=>a.path.localeCompare(b.path));
}
