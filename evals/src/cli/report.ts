import { projectGraph } from '../reports/graph.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ResultStore } from '../core/store.js';
import { writeReportArtifacts, type ReportRecord } from '../reports/index.js';
import type { OperationalLock } from './operations.js';
import type { ResultRecord } from '../../schemas/index.js';

/** Rebuild solely from locked settings and persisted evidence, including missing cells. */
export async function report(experiment: string) {
  const directory = resolve(experiment), store = new ResultStore(join(directory,'state.json'));
  const lock: OperationalLock = JSON.parse(await readFile(join(directory,'experiment.lock.json'),'utf8'));
  const runs = await store.listRuns(), results = await store.listResults();
  const records: ReportRecord[] = [];
  for (const cell of lock.cells) {
    const task = lock.tasks.find(t => t.id === cell.taskId); if (!task) throw new Error('missing locked task');
    const run = runs.find(r => r.cellId === cell.cellId);
    const result = results.find(r => r.cellId === cell.cellId) ?? {schemaVersion:1,runId:run?.runId ?? `unlaunched-${cell.cellId}`,cellId:cell.cellId,executionOutcome:null,gradeOutcome:'not_run',protocolAdherence:'unverified',usage:null,grade:null,submission:null,timings:{preparationMs:0,executionMs:0,collectionMs:0,gradingMs:0}} satisfies ResultRecord;
    let graph: Partial<Pick<ReportRecord, 'graphTimeline' | 'graphProvenance'>> = {};
    if (run) {
      // Collection snapshots and the runner's graph-event snapshot are both persisted evidence.
      for (const filename of ['graph.snapshot.json', 'graph.json']) {
        let raw: string;
        try { raw = await readFile(join(directory,'runs',run.runId,filename),'utf8'); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
        graph = projectGraph(JSON.parse(raw));
        break;
      }
    }
    records.push({result, task:{id:task.id,family:task.family,difficulty:task.difficulty,revision:task.revision,prompt:run?.spec?.prompt,mandatoryCriteria:task.criteria.filter(c=>c.mandatory).map(c=>c.id)}, mode:{id:cell.adapterId},repetition:cell.repetition,
      launch:run?.launched?'first':result.executionOutcome==='infra_error'?'preparation_failure':'unlaunched',manifestHash:String(lock.lockDigest),normalizerVersion:'usage-v1',
      settings:run?.spec?.configuration ?? {},artifactHashes:Object.fromEntries(result.submission?.files.map(f=>[f.path,f.digest]) ?? []),evidence:result.grade?.criteria.map(c=>c.observedEvidence ?? '') ?? [],...graph});
  }
  const analyses = join(directory,'analyses'); await mkdir(analyses,{recursive:true});
  const files = await writeReportArtifacts(join(analyses,randomUUID()),records,[],{forbiddenRoots:Object.values(lock.taskRoots),title:'Agent evals — persisted execution evidence'});
  return {command:'report',experiment:directory,report:files.html,files,records:records.length};
}
