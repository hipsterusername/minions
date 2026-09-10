import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve, relative, sep, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MetricDefinition } from "../../schemas/index.js";
import { aggregate, modePairs, pairedComparisons, type ReportRecord } from "./aggregation.js";
import { resultsCsv } from "./export.js";
import { renderOfflineReport } from "./html.js";
/** Write a NEW analysis directory. Refuses overwriting historical analysis revisions. */
export async function writeReportArtifacts(directory: string, records: readonly ReportRecord[], definitions: readonly MetricDefinition[] = [], options: {analysisVersion?: string;title?: string; forbiddenRoots?: readonly string[]} = {}) {
  if (!isAbsolute(directory)) throw new Error("report directory must be absolute");
  const parent=await realpath(dirname(directory));
  const target=join(parent,resolve(directory).split(sep).at(-1)!);
  let source=fileURLToPath(new URL(import.meta.url.includes("/dist/src/") ? "../../../" : "../../",import.meta.url));
  for(let cursor=source;dirname(cursor)!==cursor;cursor=dirname(cursor))if((existsSync(join(cursor,".git","HEAD")) || (existsSync(join(cursor,".git")) && statSync(join(cursor,".git")).isFile()))){source=cursor;break;}
  for(const root of [source,...options.forbiddenRoots??[]]) {const rel=relative(await realpath(root).catch((error:NodeJS.ErrnoException)=>{if(error.code!=="ENOENT")throw error;return resolve(root);}),target);if(rel===""||(!rel.startsWith('..'+sep)&&rel!==".."&&!isAbsolute(rel)))throw new Error("report output is inside a forbidden source or participant root");}
  await mkdir(target); // exclusive revision directory; never replace existing artifacts
  await writeFile(join(target,".agent-evals-analysis.json"),JSON.stringify({owner:"agent-evals",analysisVersion:options.analysisVersion??"report-v2"}),{flag:"wx"});
  const analysis=aggregate(records,definitions,options.analysisVersion);
  const files={json:join(target,'summary.json'),csv:join(target,'results.csv'),html:join(target,'report.html')};
  await Promise.all([
    writeFile(files.json,JSON.stringify({...analysis,pairwise:modePairs(records).map(p=>({...p,pairs:pairedComparisons(records,p.left,p.right)}))},null,2),{flag:'wx'}),
    writeFile(files.csv,resultsCsv(analysis),{flag:'wx'}),
    writeFile(files.html,renderOfflineReport(records,definitions,options),{flag:'wx'})
  ]);
  return files;
}
