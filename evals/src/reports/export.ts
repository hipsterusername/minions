import { createReportMath, modePairs, pairedComparisons, type Analysis } from "./aggregation.js";
/** CSV strings are neutralized against spreadsheet formula execution. */
export function createCsvExporter(math: ReturnType<typeof createReportMath>) {
  return function resultsCsv(analysis: Analysis): string {
    const cell = (v: unknown) => { let s=String(v??"");if(typeof v === "string" && /^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"'; };
    const headers=["runId","taskId","family","difficulty","mode","repetition","outcome","gradeOutcome","protocol","usageCoverage","totalTokens","executionMs","acceptanceCoverage","regressionPassed","launch","analysisVersion","schemaVersion","normalizerVersion","graderRevision"];
    const rows=analysis.records.map(r=>[r.result.runId,r.task.id,r.task.family,r.task.difficulty,r.mode.id,r.repetition,math.outcome(r),r.result.gradeOutcome,r.result.protocolAdherence,r.result.usage?.coverage??"unavailable",math.tokens(r),math.time(r),math.coverage(r),r.result.grade?.regressionPassed,r.launch??"first",analysis.analysisVersion,r.result.schemaVersion,r.normalizerVersion??"unspecified",r.result.grade?.graderRevision]);
    return [headers,...rows].map(r=>r.map(cell).join(',')).join('\n');
  };
}
export const resultsCsv = createCsvExporter(createReportMath());
export function analysisJson(analysis: Analysis): string { return JSON.stringify({...analysis,pairwise:modePairs(analysis.records).map(p=>({...p,pairs:pairedComparisons(analysis.records,p.left,p.right)}))},null,2); }
