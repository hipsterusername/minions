import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResultRecord } from "../../schemas/index.js";
import { aggregate, pairedComparisons, renderOfflineReport, resultsCsv, type ReportRecord, ReportViewRegistry } from "../../src/reports/index.js";

const hash = "a".repeat(64);
function record(runId: string, mode: string, repetition: number, options: Partial<ResultRecord> = {}): ReportRecord {
  return { task: { id: "task-a", family: "api", difficulty: "simple", mandatoryCriteria: ["must"] }, mode: { id: mode }, repetition,
    result: { schemaVersion: 1, runId, cellId: `cell-${runId}`, executionOutcome: "completed", gradeOutcome: "passed", protocolAdherence: "valid", usage: { schemaVersion: 1, sourceId: `source-${runId}`, participantId: null, turnId: null, observationKind: "delta", inputTokensTotal: 80, inputTokensUncached: 50, cacheReadTokens: 20, cacheWriteTokens: 10, outputTokensTotal: 20, reasoningTokens: 5, totalTokens: 100, reportedCostUSD: null, estimatedCostUSD: null, coverage: "complete", coverageReasons: [] }, submission: null, grade: { schemaVersion: 1, gradeId: `grade-${runId}`, graderId: "grader", graderVersion: "1", graderRevision: "r1", submissionHash: hash, outcome: "passed", criteria: [{ criterionId: "must", verdict: "pass", expectedEvidence: null, observedEvidence: null, logReferences: [] }], regressionPassed: true, metrics: [{ definitionId: "queue.lostJobs", definitionRevision: "1", value: 2, evidence: [] }], logReferences: [] }, timings: { preparationMs: 1, executionMs: 40, collectionMs: 1, gradingMs: 1 }, ...options } };
}
describe("offline report aggregation", () => {
  it("uses launched attempts as denominator and preserves incomplete usage in token metrics", () => {
    const failed = record("run-fail", "raw", 0, { gradeOutcome: "failed", grade: { ...record("tmp", "raw", 0).result.grade!, outcome: "failed", criteria: [{ criterionId: "must", verdict: "fail", expectedEvidence: null, observedEvidence: null, logReferences: [] }] } });
    const incomplete = record("run-partial", "raw", 1, { usage: { ...record("tmp2", "raw", 0).result.usage!, coverage: "partial", coverageReasons: ["terminal usage missing"] } });
    const analysis = aggregate([record("run-ok", "raw", 0), failed, incomplete]);
    const cohort = analysis.cohorts[0]!;
    expect(cohort.attempts).toBe(3); expect(cohort.successes).toBe(2); expect(cohort.outcomeCounts.task_failure).toBe(1);
    expect(cohort.tokens.complete).toBe(2); expect(cohort.tokens.incomplete).toBe(1);
    expect(cohort.tokensPerSuccess).toMatchObject({ state: "lower_bound", value: null, knownTokens: 200 });
  });
  it("computes paired values only for complete, nonzero denominators while retaining quality pairs", () => {
    const left = record("left", "single", 4);
    const right = record("right", "graph", 4, { usage: { ...left.result.usage!, sourceId: "right", totalTokens: 150, inputTokensTotal: 130, outputTokensTotal: 20 } });
    const zero = record("zero", "single", 5, { usage: { ...left.result.usage!, sourceId: "zero", totalTokens: 0, inputTokensTotal: 0, outputTokensTotal: 0 } });
    const partial = record("partial", "graph", 5, { usage: { ...right.result.usage!, sourceId: "partial", coverage: "partial", coverageReasons: ["missing"] } });
    const pairs = pairedComparisons([left, right, zero, partial], "single", "graph");
    expect(pairs[0]).toMatchObject({ tokenDelta: 50, tokenRatio: 1.5, leftOutcome: "success", rightOutcome: "success" });
    expect(pairs[1]).toMatchObject({ tokenDelta: null, tokenRatio: null, leftOutcome: "success", rightOutcome: "success" });
  });
  it("keeps metric revisions and units separate and exports spreadsheet-safe CSV", () => {
    const a = aggregate([record("one", "raw", 0)], [{ schemaVersion: 1, id: "queue.lostJobs", revision: "1", description: "lost", valueType: "number", unit: "jobs", scope: "run", preferredDirection: "lower", missingValueMeaning: "none", aggregation: ["sum"] }]);
    expect(a.metrics).toEqual([expect.objectContaining({ definitionId: "queue.lostJobs", revision: "1", unit: "jobs" })]);
    expect(resultsCsv(a)).toContain('"runId"');
  });
  it("escapes hostile stored content and generates a self-contained accessible artifact", () => {
    const hostile = record("evil", "<img src=x onerror=alert(1)>", 0);
    const html = renderOfflineReport([{ ...hostile, task: { ...hostile.task, id: "</script><script>alert(1)</script>" }, evidence: ["<svg onload=alert(1)>" ] }]);
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain('type="application/json"'); expect(html).toContain("aria-live"); expect(html).not.toContain('src="http');
  });
  it("registers report views explicitly", () => {
    const registry = new ReportViewRegistry(); const view = { id: "custom", version: "1", render: async () => ({ html: "", warnings: [] }) };
    registry.register(view); expect(registry.get("custom")).toBe(view); expect(() => registry.register(view)).toThrow(/already/);
  });
  it("produces a portable HTML artifact without an application runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-evals-report-"));
    try {
      const path = join(directory, "report.html");
      await writeFile(path, renderOfflineReport([record("artifact", "raw", 0)]), "utf8");
      expect(await readFile(path, "utf8")).toContain("Self-contained offline report");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

import { createRequire } from 'node:module';
import { filterRecords, outcome, summary, coverage, modePairs, writeReportArtifacts, createReportViewRegistry } from '../../src/reports/index.js';
// Optional host DOM tooling; the standalone runtime has no DOM dependency.
let JSDOM: any;
({ JSDOM } = createRequire(import.meta.url)('jsdom'));
it('requires protocol, regression and every mandatory criterion, counting missing criteria',()=>{
 const base=record('a','raw',0);
 expect(outcome({...base,result:{...base.result,protocolAdherence:'violated'}})).toBe('task_failure');
 expect(outcome({...base,result:{...base.result,grade:{...base.result.grade!,regressionPassed:false}}})).toBe('task_failure');
 const missing={...base,task:{...base.task,mandatoryCriteria:['must','missing']}};
 expect(coverage(missing)).toBe(.5);expect(outcome(missing)).toBe('task_failure');
 expect(aggregate([missing]).cohorts[0].tokensPerSuccess.state).toBe('no_successes');
 expect(filterRecords([base],{modes:[]})).toEqual([]);
 expect(summary([10,20,30,40])).toEqual({count:4,median:25,iqr:[17.5,32.5]});
 expect(modePairs([base,record('b','single',0),record('c','graph',0)])).toHaveLength(3);
});
it('separates launch populations and preserves null observations',()=>{
 const base=record('a','raw',0);
 const a=aggregate([base,{...record('b','raw',1),launch:'replacement'},{...record('c','raw',2),launch:'unlaunched'},record('d','raw',3,{usage:null})]);
 expect(a.cohorts[0]).toMatchObject({attempts:2,successes:2,replacements:1,unlaunched:1,tokens:{complete:1,incomplete:1},tokensPerSuccess:{state:'lower_bound',value:null}});
 expect(resultsCsv(aggregate([{...base,task:{...base.task,id:'=SUM(1)'}}]))).toContain("'=SUM(1)");
});
it.skipIf(!JSDOM)('executes offline DOM filters, shared medians, three comparisons and plotted downloads safely',async()=>{
 const a=record('a','raw',0),b=record('b','raw',1,{usage:{...a.result.usage!,totalTokens:200}});
 const blobs: {text: string}[]=[];let count=0;
 const hostile='</script><img src=x onerror="globalThis.injected=1">';
 const html=renderOfflineReport([a,b,{...record('c','single',0),evidence:[hostile],graphTimeline:[{id:'n',state:'completed',startedAt:'2026-01-01T00:00:00Z',endedAt:'2026-01-01T00:00:02Z',tokens:100}]},record('d','graph',0)]);
 const dom=new JSDOM(html,{runScripts:'dangerously',url:'https://offline.invalid/',beforeParse(w: any){w.Blob=class{constructor(parts:any[]){blobs.push({text:parts.join('')})}};w.URL.createObjectURL=()=> 'blob:fixture-'+count++;w.URL.revokeObjectURL=()=>{};}});
 try {
 const d=dom.window.document;
 expect(d.querySelector('#pair').options.length).toBe(3);
 expect(d.querySelector('main').textContent).toContain('150 / [125,175]');
 expect(d.querySelectorAll('svg circle').length).toBeGreaterThan(0);
 expect(d.querySelector('svg rect[data-duration-ms]').getAttribute('data-duration-ms')).toBe('2000');
 expect(blobs.some(b=>b.text.includes('<circle')&&b.text.includes('data-value="1"'))).toBe(true);
 expect(d.querySelector('img')).toBeNull();expect(dom.window.injected).toBeUndefined();
 const all=[...d.querySelectorAll('input[data-filter="modes"]')] as any[];all.forEach(c=>c.checked=false);all[0].dispatchEvent(new dom.window.Event('change',{bubbles:true}));
 expect(d.querySelector('main').textContent).toContain('selected runs: 0');
 expect(d.querySelectorAll('svg circle')).toHaveLength(0);
 expect(JSON.parse(decodeURIComponent(dom.window.location.hash.slice(1))).modes).toEqual([]);
 const exported=JSON.parse(blobs.filter(b=>b.text.startsWith('{')).at(-1)!.text);expect(exported.records).toEqual([]);
 all.forEach(c=>c.checked=true);all[0].dispatchEvent(new dom.window.Event('change',{bubbles:true}));
 const pop=d.querySelector('#population');pop.value='success';pop.dispatchEvent(new dom.window.Event('change',{bubbles:true}));expect(d.querySelector('main').textContent).toContain('success population');
 } finally {dom.window.close()}
});
it('writes immutable portable artifacts and renders built-in registry view',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'report-artifacts-'));
 try{const files=await writeReportArtifacts(join(dir,'revision-1'),[record('a','raw',0)]);expect(JSON.parse(await readFile(files.json,'utf8')).cohorts[0].successes).toBe(1);expect(await readFile(files.csv,'utf8')).toContain('"success"');await expect(writeReportArtifacts(join(dir,'revision-1'),[])).rejects.toThrow();expect((await createReportViewRegistry().get('offline').render({results:[record('a','raw',0)],metrics:[]})).html).toContain('report-data');}finally{await rm(dir,{recursive:true,force:true})}
});
it('keeps metric revisions separate and checks failed-run cost by hand',()=>{
 const a=record('a','raw',0),b=record('b','raw',1,{gradeOutcome:'failed',usage:{...a.result.usage!,totalTokens:300}});
 const changed={...b,result:{...b.result,grade:{...b.result.grade!,metrics:[{definitionId:'queue.lostJobs',definitionRevision:'2',value:4,evidence:[]}]}}};
 const analysis=aggregate([a,changed]);expect(analysis.cohorts[0].tokensPerSuccess.value).toBe(400);expect(analysis.cohorts[0].tokens.median).toBe(200);expect(analysis.metrics.map(m=>m.revision)).toEqual(['1','2']);
});
