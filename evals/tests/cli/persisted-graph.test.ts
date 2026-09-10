import { openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const cli = resolve('dist/src/cli/main.js');
const attempt = (id: string, number: number, state: string, tokens: number, start?: number, end?: number) => ({id, number, state, tokens, costUsd:0, ...(start === undefined ? {} : {startedAt:`2026-01-01T00:00:0${start}Z`}), ...(end === undefined ? {} : {finishedAt:`2026-01-01T00:00:0${end}Z`})});
const node = (id: string, logicalState: string, attempts: ReturnType<typeof attempt>[], currentAttempt: ReturnType<typeof attempt> | null) => ({id,title:id,objective:'Synthetic harness task',constraints:[],acceptanceCriteria:[],context:[],kind:'task',completionMode:'task',logicalState,readiness:'terminal',currentAttempt,attemptHistory:attempts,verification:{state:'not_required',evidenceIds:[]},adjudication:null,blocker:null,priority:0,costUsd:0,tokens:attempts.reduce((n,a)=>n+a.tokens,0),criticalPath:false,stale:false,inputIds:[],outputArtifactIds:[]});

it.each(['graph.snapshot.json','graph.json'])('reports persisted real-shaped %s with retries, dependencies and integration evidence', async filename => {
 const root = await mkdtemp(join(tmpdir(),'persisted-graph-'));
 try {
  const dir=join(root,'experiment'), runDir=join(dir,'runs','run');await mkdir(runDir,{recursive:true});
  await writeFile(join(dir,'experiment.lock.json'),JSON.stringify({cells:[{cellId:'cell',taskId:'task',adapterId:'minion-graph',repetition:0}],tasks:[{id:'task',family:'api',difficulty:'simple',revision:'1',criteria:[]}],taskRoots:{},lockDigest:'fixture'}));
  await writeFile(join(dir,'state.json'),JSON.stringify({schemaVersion:1,runs:{run:{runId:'run',cellId:'cell',launched:true}},results:{}}));
  const failed=attempt('a1',1,'failed',7,0,1), success=attempt('a2',2,'succeeded',11,2,4), running=attempt('b1',1,'running',3,4);
  const evidence={id:'evidence',sourceSnapshot:'source',producerAttemptId:'a2',artifactId:'artifact',verifierAttemptId:'verify',consumerNodeIds:['b'],consumedByNodeIds:['b'],status:'passed'};
  const graph={graphRunId:'graph',revision:3,title:'Fixture graph',status:'running',updatedAt:'2026-01-01T00:00:06Z',nodes:[{...node('a','succeeded',[failed,success],success),outputArtifactIds:['artifact']},node('b','pending',[],running),node('waiting','not_run',[],null)],edges:[{id:'edge',source:'a',target:'b',type:'data',state:'ordinary'}],groups:[],evidence:[evidence],timeline:[],capacity:{running:1,limit:2},budget:{spentUsd:0,limitUsd:null,tokens:21},criticalPath:{nodeIds:[],observedMs:0,estimatedRemainingMs:0}};
  const raw=JSON.stringify(graph);await writeFile(join(runDir,filename),raw);
  const log=join(root,'cli.log'), fd=openSync(log,'w');
  const command=spawnSync(process.execPath,[cli,'report','--experiment',dir],{cwd:root,stdio:['ignore',fd,fd]});closeSync(fd);
  const stdout=await readFile(log,'utf8');
  expect(command.status,stdout).toBe(0);
  const output=JSON.parse(stdout), summary=JSON.parse(await readFile(output.files.json,'utf8')), row=summary.records[0];
  expect(row.graphTimeline).toHaveLength(4);
  expect(row.graphTimeline[0]).toMatchObject({id:'a',state:'succeeded',attemptState:'failed',attemptId:'a1',attempt:1,tokens:7,endedAt:failed.finishedAt});
  expect(row.graphTimeline[1]).toMatchObject({attemptId:'a2',attempt:2,tokens:11});
  expect(row.graphTimeline[2]).toMatchObject({id:'b',state:'pending',attemptState:'running',dependencies:['a'],tokens:3});
  expect(row.graphTimeline[2].endedAt).toBeUndefined();expect(row.graphTimeline[3].attempt).toBeUndefined();
  expect(row.graphProvenance).toMatchObject({graphRunId:'graph',revision:3,edges:graph.edges,evidence:[evidence]});
  const blobs:string[]=[];
  const dom=new JSDOM(await readFile(output.files.html,'utf8'),{runScripts:'dangerously',url:'https://offline.invalid',beforeParse(w:any){w.Blob=class{constructor(parts:string[]){blobs.push(parts.join(''))}};w.URL.createObjectURL=()=> 'blob:fixture';w.URL.revokeObjectURL=()=>{};}});
  try {
   const d=dom.window.document;
   expect([...d.querySelectorAll('[data-duration-ms]')].map((e:any)=>e.getAttribute('data-duration-ms'))).toEqual(['1000','2000']);
   expect(d.querySelector('[data-dependency="edge"]').getAttribute('data-source-attempt')).toBe('a2');
   expect(d.querySelector('[data-attempt-id="b1"]').getAttribute('data-incomplete')).toBe('true');
   expect(d.querySelector('main').textContent).toContain('artifact');expect(d.querySelector('main').textContent).toContain('Integration provenance');
   expect(blobs.some(s=>s.includes('data-duration-ms="2000"')&&s.includes('data-tokens="11"'))).toBe(true);
  } finally {dom.window.close();}
  expect(await readFile(join(runDir,filename),'utf8')).toBe(raw);
 } finally {await rm(root,{recursive:true,force:true});}
});
