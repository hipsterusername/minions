import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual as equal } from 'node:util';
export const schemaVersion = 1;
export const taskId = 'project-archive-complex';
export const revision = 'r2';
export const criterionIds = ['archive.visibility','archive.edits','archive.restore','archive.migration','archive.ui'];

export async function gradeFiles({execute,seed = 'hidden-default'}) {
  const suffix = [...String(seed)].reduce((n,c) => (Math.imul(n,33) + c.charCodeAt(0)) >>> 0, 91);
  const rows = [
    {id:`z-${suffix}`,name:'Legacy Ω',owner:'ana',description:`preserve this description ${suffix}`},
    {id:`a-${suffix}`,name:'Keep me',owner:'bo',description:'untouched'},
    {id:`m-${suffix}`,name:'Middle',owner:'',description:'line\nbreak'},
  ];
  const patch = {name:`Archive <img src=x> Ω ${suffix}`,owner:''};
  const finalDescription = `restored ${suffix}`;
  const probe = await readFile(new URL('./probe.mjs',import.meta.url),'utf8');
  const preflight = await readFile(new URL('./preflight.mjs',import.meta.url),'utf8');
  try {
    const environment = await execute({command:'node',args:['--input-type=module','-e',preflight],timeoutMs:10000});
    if (environment.code !== 0) throw new Error('archive environment preflight: '+environment.stderr.slice(0,1000));
  } catch (error) {
    if (error?.kind === 'grader-infrastructure') throw error;
    throw Object.assign(new Error(String(error?.message ?? error), {cause:error}), {kind:'grader-infrastructure',code:'GRADER_PREFLIGHT'});
  }
  let actual;
  try {
    const result = await candidateExecute(execute, {command:'node',args:['--input-type=module','-e',probe],stdin:JSON.stringify({rows,patch,finalDescription}),timeoutMs:30000});
    if (result.code !== 0) throw new Error('probe exited '+result.code+': '+result.stderr.slice(0,500));
    actual = JSON.parse(result.stdout);
    if (!actual || actual.error) throw new Error(actual?.error || 'invalid observation');
  } catch(error) {if (error?.kind === 'grader-infrastructure') throw error; return criterionIds.map(criterionId => ({criterionId,pass:false,observed:String(error.message)}));}
  const checks = new Map(criterionIds.map(id => [id,[]]));
  const check = (id,name,pass) => checks.get(id).push({name,pass:!!pass});
  const response = (value,body,status=200) => equal(value,{status,body});
  const sorted = values => [...values].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const initial = sorted(rows.map(row => ({...row,archivedAt:null})));
  const activeProject = {...rows[0],...patch,archivedAt:null};
  const timestamp = actual.archive?.body?.archivedAt;
  const archivedProject = {...activeProject,archivedAt:timestamp};
  const otherRows = initial.filter(row => row.id !== rows[0].id);
  const restored = sorted([...otherRows,activeProject]);
  const finalProject = {...activeProject,description:finalDescription};
  const v = criterionIds[0], e = criterionIds[1], r = criterionIds[2], m = criterionIds[3], u = criterionIds[4];
  check(v,'initial default/explicit/archived lists',response(actual.initial,initial) && response(actual.explicit,initial) && response(actual.emptyArchived,[]));
  check(v,'archive creates ISO timestamp',typeof timestamp === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(timestamp) && Number.isFinite(Date.parse(timestamp)) && response(actual.archive,archivedProject));
  check(v,'default excludes and filter includes',response(actual.active,otherRows) && response(actual.archived,[archivedProject]));
  check(v,'detail remains readable',response(actual.detail,archivedProject));
  check(v,'filter validation and missing IDs',response(actual.invalidFilter,{error:'INVALID_FILTER'},400) && actual.missing?.length === 4 && actual.missing.every(value => response(value,{error:'NOT_FOUND'},404)));
  check(e,'active PATCH preserves omitted fields and empty strings',response(actual.editActive,activeProject));
  check(e,'invalid patches rejected',actual.invalid?.length === 4 && actual.invalid.every(value => response(value,{error:'INVALID_PATCH'},400)));
  check(e,'archived PATCH and empty PATCH rejected',response(actual.editArchived,{error:'ARCHIVED'},409) && response(actual.emptyEditArchived,{error:'ARCHIVED'},409));
  check(e,'rejected edits do not persist',response(actual.restart,archivedProject));
  check(e,'restored project editable',response(actual.editRestored,finalProject));
  check(r,'repeat archive preserves timestamp',response(actual.repeatArchive,archivedProject));
  check(r,'repeat restore preserves all data',response(actual.restore,activeProject) && response(actual.repeatRestore,activeProject) && response(actual.restoredActive,restored));
  check(r,'archive persists through killed server',response(actual.restart,archivedProject) && response(actual.restartActive,otherRows) && response(actual.restartArchived,[archivedProject]));
  check(r,'restore and edits survive second restart',response(actual.final,finalProject));
  check(m,'legacy rows migrated with null archive state',response(actual.initial,initial));
  check(m,'physical SQLite retains every row and field',equal(actual.disk,sorted([...otherRows,finalProject])) && Array.isArray(actual.columns) && equal([...actual.columns].sort(),['archivedAt','description','id','name','owner']));
  check(u,'browser archive/filter/restore and reload',!actual.uiError && response(actual.ui?.afterRestore,finalProject) && actual.ui?.activeCount === 2 && actual.ui?.afterArchive?.status === 200 && actual.ui?.afterArchive?.body?.archivedAt !== null && equal({...actual.ui?.afterArchive?.body,archivedAt:null},finalProject));
  check(u,'browser displays HTML-like names as text',actual.ui?.archivedText === patch.name && actual.ui?.injectedElements === 0);
  return criterionIds.map(criterionId => {
    const entries = checks.get(criterionId); const failed = entries.filter(entry => !entry.pass);
    return {criterionId,pass:failed.length === 0,observed:`${entries.length-failed.length}/${entries.length} checks passed${failed.length ? '; failures: '+failed.map(entry => entry.name).join(', ') : ''}${criterionId === u && actual.uiError ? '; browser: '+actual.uiError.slice(0,400) : ''}`};
  });
}

// Only these executor errors describe candidate limits. Unknown faults must escape
// scoring. Stable fields work in native .mjs without importing evaluator TS.
async function candidateExecute(execute, request) {
  try { return await execute(request); }
  catch (error) {
    if (error?.kind === 'candidate' && ['CANDIDATE_TIMEOUT','CANDIDATE_OUTPUT_LIMIT'].includes(error.code)) throw error;
    if (error?.kind === 'grader-infrastructure') throw error;
    throw Object.assign(new Error(String(error?.message ?? error), {cause:error}), {kind:'grader-infrastructure',code:'GRADER_EXECUTOR'});
  }
}
