import type { GraphTimelineRow, GraphProvenance } from './graph.js';
import type { MetricDefinition, ResultRecord } from "../../schemas/index.js";
export type OutcomeKind = "success" | "task_failure" | "infrastructure_failure" | "capped" | "incomplete";
export interface ReportRecord {
  readonly result: ResultRecord;
  readonly task: { readonly id: string; readonly family: string; readonly difficulty: "simple" | "complex"; readonly revision?: string; readonly prompt?: string; readonly mandatoryCriteria?: readonly string[] };
  readonly mode: { readonly id: string; readonly label?: string; readonly version?: string };
  readonly repetition: number;
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly artifactHashes?: Readonly<Record<string, string>>;
  readonly evidence?: readonly string[];
  readonly launch?: "first" | "replacement" | "preparation_failure" | "unlaunched";
  readonly manifestHash?: string;
  readonly normalizerVersion?: string;
  readonly graphTimeline?: readonly GraphTimelineRow[];
  readonly graphProvenance?: GraphProvenance;
}
export interface ReportFilter { readonly families?: readonly string[]; readonly difficulties?: readonly string[]; readonly modes?: readonly string[]; readonly repetitions?: readonly number[]; readonly outcomes?: readonly OutcomeKind[]; readonly successOnly?: boolean; }
export interface NumericSummary { readonly count: number; readonly median: number | null; readonly iqr: readonly [number, number] | null; }
/** Self-contained factory: the exact compiled functions also execute in the offline browser. */
export function createReportMath() {
  function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
  function coverage(r: ReportRecord): number | null {
    const mandatory = r.task.mandatoryCriteria;
    if (!mandatory) return null;
    const ids = [...new Set(mandatory)];
    const passed = ids.filter(id => { const checks = r.result.grade?.criteria.filter(c => c.criterionId === id) ?? []; return checks.length > 0 && checks.every(c => c.verdict === "pass"); }).length;
    return ids.length ? passed / ids.length : 1;
  }
  function outcome(r: ReportRecord): OutcomeKind {
    const x = r.result;
    if (["timeout", "budget_exceeded"].includes(x.executionOutcome ?? "")) return "capped";
    if (["infra_error", "interrupted"].includes(x.executionOutcome ?? "") || x.gradeOutcome === "error") return "infrastructure_failure";
    if (x.executionOutcome === "completed" && x.gradeOutcome === "passed" && x.grade?.outcome === "passed" && x.protocolAdherence === "valid" && x.grade.regressionPassed === true && coverage(r) === 1) return "success";
    if (x.gradeOutcome === "not_run" || x.executionOutcome === null) return "incomplete";
    return "task_failure";
  }
  function filterRecords(records: readonly ReportRecord[], f: ReportFilter = {}) {
    const includes = <T>(a: readonly T[] | undefined, v: T) => a === undefined || a.includes(v);
    return records.filter(r => includes(f.families,r.task.family) && includes(f.difficulties,r.task.difficulty) && includes(f.modes,r.mode.id) && includes(f.repetitions,r.repetition) && includes(f.outcomes,outcome(r)) && (!f.successOnly || outcome(r) === "success"));
  }
  function summary(values: readonly number[]): NumericSummary {
    const a = values.filter(finite).sort((a,b) => a-b);
    if (!a.length) return { count: 0, median: null, iqr: null };
    const q = (p: number) => { const n = (a.length-1)*p, i = Math.floor(n); return a[i]! + (a[Math.ceil(n)]!-a[i]!)*(n-i); };
    return {count:a.length, median:q(.5), iqr:[q(.25),q(.75)]};
  }
  function tokens(r: ReportRecord): number | null { return r.result.usage?.coverage === "complete" && finite(r.result.usage.totalTokens) ? r.result.usage.totalTokens : null; }
  function time(r: ReportRecord): number | null { return finite(r.result.timings?.executionMs) ? r.result.timings.executionMs : null; }
  function primary(r: ReportRecord) { return r.launch === undefined || r.launch === "first"; }
  function aggregate(records: readonly ReportRecord[], definitions: readonly MetricDefinition[] = [], analysisVersion = "report-v2") {
    const grouped = new Map<string, ReportRecord[]>();
    for (const r of records) { const key = JSON.stringify([r.manifestHash ?? "unspecified",r.task.id,r.task.revision ?? "unspecified",r.mode.id]); grouped.set(key,[...(grouped.get(key) ?? []),r]); }
    const cohorts = [...grouped.values()].map(all => {
      const rows = all.filter(primary), successes = rows.filter(r=>outcome(r)==="success").length;
      const outcomeCounts: Record<OutcomeKind,number> = {success:0,task_failure:0,infrastructure_failure:0,capped:0,incomplete:0}; rows.forEach(r=>outcomeCounts[outcome(r)]++);
      const complete = rows.map(tokens).filter((x): x is number=>x!==null), knownTokens = complete.reduce((a,b)=>a+b,0);
      return {taskId:all[0]!.task.id, taskRevision:all[0]!.task.revision ?? "unspecified", manifestHash:all[0]!.manifestHash ?? "unspecified", modeId:all[0]!.mode.id, attempts:rows.length,successes,outcomeCounts,
        preparationFailures:all.filter(r=>r.launch==="preparation_failure").length, unlaunched:all.filter(r=>r.launch==="unlaunched").length,replacements:all.filter(r=>r.launch==="replacement").length,
        acceptanceCoverage:summary(rows.map(coverage).filter((x):x is number=>x!==null)), tokens:{...summary(complete),complete:complete.length,incomplete:rows.length-complete.length},executionMs:summary(rows.map(time).filter((x):x is number=>x!==null)),
        successTokens:summary(rows.filter(r=>outcome(r)==="success").map(tokens).filter((x):x is number=>x!==null)), successExecutionMs:summary(rows.filter(r=>outcome(r)==="success").map(time).filter((x):x is number=>x!==null)),
        protocolViolations:rows.filter(r=>r.result.protocolAdherence!=="valid").length,regressionFailures:rows.filter(r=>r.result.grade?.regressionPassed===false).length,
        tokensPerSuccess:{value:successes && complete.length===rows.length ? knownTokens/successes:null,state:successes===0?"no_successes":complete.length===rows.length?"known":"lower_bound",knownTokens,lowerBound:successes?knownTokens/successes:null}};
    });
    const metrics: {definitionId:string;revision:string;unit:string;values:{runId:string;value:number|boolean}[]}[] = [];
    for (const r of records) for (const m of r.result.grade?.metrics ?? []) {
      const unit = definitions.find(d=>d.id===m.definitionId && d.revision===m.definitionRevision)?.unit ?? "unknown";
      let column = metrics.find(c=>c.definitionId===m.definitionId && c.revision===m.definitionRevision && c.unit===unit);
      if (!column) { column={definitionId:m.definitionId,revision:m.definitionRevision,unit,values:[]};metrics.push(column); }
      column.values.push({runId:r.result.runId,value:m.value});
    }
    const taskRates = new Map<string,number[]>();
    for (const c of cohorts.filter(c=>c.attempts)) { const k=JSON.stringify([c.manifestHash,c.taskId,c.taskRevision]);taskRates.set(k,[...(taskRates.get(k)??[]),c.successes/c.attempts]); }
    const rates=[...taskRates.values()].map(a=>a.reduce((a,b)=>a+b,0)/a.length);
    return {records,cohorts,metrics,missingUsage:records.filter(r=>tokens(r)===null).length,analysisVersion,quantiles:"linear interpolation (n−1)p",equalTaskSuccessRate:rates.length?rates.reduce((a,b)=>a+b,0)/rates.length:null};
  }
  function pairedComparisons(records: readonly ReportRecord[], leftMode: string, rightMode: string) {
    const grouped = new Map<string,ReportRecord[]>();
    for (const r of records.filter(primary)) {const key=JSON.stringify([r.manifestHash??"unspecified",r.task.id,r.task.revision??"unspecified",r.repetition]);grouped.set(key,[...(grouped.get(key)??[]),r]);}
    return [...grouped.values()].flatMap(rows=>{
      const ls=rows.filter(r=>r.mode.id===leftMode),rs=rows.filter(r=>r.mode.id===rightMode);
      if(leftMode===rightMode||ls.length!==1||rs.length!==1)return [];
      const l=ls[0]!,r=rs[0]!,a=tokens(l),b=tokens(r),t=time(l),u=time(r);
      return [{taskId:l.task.id,repetition:l.repetition,leftRunId:l.result.runId,rightRunId:r.result.runId,leftOutcome:outcome(l),rightOutcome:outcome(r),qualityDelta:Number(outcome(r)==="success")-Number(outcome(l)==="success"),successfulPair:outcome(l)==="success"&&outcome(r)==="success",tokenDelta:a===null||b===null?null:b-a,tokenRatio:a===null||b===null||a===0?null:b/a,timeDeltaMs:t===null||u===null?null:u-t,timeRatio:t===null||u===null||t===0?null:u/t}];
    });
  }
  function modePairs(records: readonly ReportRecord[]) { const modes=[...new Set(records.map(r=>r.mode.id))].sort();return modes.flatMap((l,i)=>modes.slice(i+1).map(r=>({left:l,right:r}))); }
  return {finite,coverage,outcome,filterRecords,summary,tokens,time,primary,aggregate,pairedComparisons,modePairs};
}
export const {coverage,outcome,filterRecords,summary,tokens,time,primary,aggregate,pairedComparisons,modePairs} = createReportMath();
export type Analysis = ReturnType<typeof aggregate>;
export type Cohort = Analysis["cohorts"][number];
export type MetricColumn = Analysis["metrics"][number];
export type PairedComparison = ReturnType<typeof pairedComparisons>[number];
