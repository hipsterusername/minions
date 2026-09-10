import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { TaskDefinitionSchema } from '../../schemas/index.js';
import { LifecycleRunner, ResultStore, EventStore } from '../../src/core/index.js';
import { ProcessFakeAdapter } from '../../src/core/testing-runtime.js';
import { processExecutor, fileGrader } from '../../src/graders/executor.js';
const root = resolve(import.meta.dirname,'../..');
for (const mode of ['infrastructure','candidate','watchdog'] as const) it(`persists ${mode} as the correct grade outcome with a real process adapter`,async () => {
  const directory = await mkdtemp(join(tmpdir(),'eval-grade-outcome-'));
  try {
    const task = TaskDefinitionSchema.parse(JSON.parse(await readFile(join(root,'tasks/pagination-simple/manifest.json'),'utf8')));
    const store = new ResultStore(join(directory,'store.json'));
    const execute = processExecutor(directory,1000);
    const grader = fileGrader(task,join(root,'ground-truth/pagination-simple/oracle.mjs'),directory,'seed',request => execute({
      ...request,command:mode === 'infrastructure' ? '/nonexistent-eval-runtime' : 'node',
      args:['-e','while(true) {}'], timeoutMs:mode === 'watchdog' ? 1000 : 30,
    }));
    const runner = new LifecycleRunner({experimentId:'fixture',aggregateTokenCap:100,store,events:new EventStore(join(directory,'events.jsonl')),
      snapshotSubmission:async () => ({schemaVersion:1,submissionHash:'a'.repeat(64),rootDigest:'a'.repeat(64),files:[],capturedAt:new Date().toISOString()}),
      graderContext:{schemaVersion:1,graderRevision:'r2',timeoutMs:mode === 'watchdog' ? 100 : 5000,environment:{}},
    },new ProcessFakeAdapter(join(directory,'state')),grader);
    await runner.start({cell:{schemaVersion:1,cellId:'cell',experimentId:'fixture',taskId:task.id,adapterId:'process-fake',repetition:0,fixtureSeed:'seed',status:'planned'},
      spec:{schemaVersion:1,runId:'run',idempotencyKey:'run',taskId:task.id,prompt:'fixture',workspace:{id:'workspace',mountPath:directory},limits:{...task.limits,executionTimeoutMs:5000},configuration:{command:[process.execPath,'-e','process.exit(0)']},visibleAssets:[]}});
    await runner.drive('run');
    const result = await store.getResult('run');
    expect(result?.executionOutcome).toBe('completed');
    expect(result?.gradeOutcome).toBe(mode === 'candidate' ? 'failed' : 'error');
    if (mode !== 'candidate') {
      expect(result?.grade).toBeNull();
      expect(await readFile(join(directory,'events.jsonl'),'utf8')).toContain('"phase":"grading"');
    } else expect(result?.grade?.criteria.every(c => c.verdict === 'fail')).toBe(true);
  } finally { await rm(directory,{recursive:true,force:true}); }
},10000);
