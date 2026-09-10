export const schemaVersion = 1;
export const taskId = 'orders-report-simple';
export const revision = 'r2';
export const criterionIds = ['orders.parse', 'orders.deduplicate', 'orders.totals', 'orders.exit'];
const header = 'id,created_at,amount\n';
const outputHeader = 'month,total\n';

function buildCases(seed) {
  const cases = [];
  const add = (criterionId, name, rows, expected, args = [], code = 0) => cases.push({criterionId,name,stdin:rows,args,expected,code});
  add(criterionIds[0], 'malformed-rows', header + [
    'ok,2024-02-29T12:34:56.123Z,+0001.2',
    'bad,2025-02-29T00:00:00Z,10', 'bad,2024-04-31T00:00:00Z,10',
    'bad,2024-01-01,10', 'bad,2024-01-01T00:00:00,10',
    'bad,2024-01-01T24:00:00Z,10', 'bad,2024-01-01T00:00:60Z,10',
    'bad,2024-01-01T00:00:00+24:00,10', 'bad,2024-01-01T00:00:00+01:60,10',
    'bad,2024-01-01T00:00:00.12Z,10',
    'bad,0000-01-01T00:00:00Z,10', 'bad,0001-01-01T00:00:00+01:00,10',
    'bad,9999-12-31T23:00:00-02:00,10',
    ...['1.234','1e2',' 1','1 ','NaN','.50','1.','--2',''].map(a => `bad,2024-01-01T00:00:00Z,${a}`),
    ',2024-01-01T00:00:00Z,3', 'has space,2024-01-01T00:00:00Z,3',
    `${'x'.repeat(65)},2024-01-01T00:00:00Z,3`,
    'extra,2024-01-01T00:00:00Z,3,4', 'missing,2024-01-01T00:00:00Z',
    '"quoted",2024-01-01T00:00:00Z,3', '',
  ].join('\n'), outputHeader + '2024-02,1.20\n');
  add(criterionIds[0], 'all-invalid', header + 'x,nope,1\n', outputHeader);
  add(criterionIds[0], 'crlf-no-final-newline', 'id,created_at,amount\r\na,2025-01-01T00:00:00Z,1\r\nb,2025-01-02T00:00:00Z,2.3', outputHeader + '2025-01,3.30\n');
  add(criterionIds[1], 'last-valid-across-months', header + 'a,2025-01-01T00:00:00Z,99\na,2025-02-01T00:00:00Z,-0.50\na,nope,100\nA,2025-01-01T00:00:00Z,2\n', outputHeader + '2025-01,2.00\n2025-02,-0.50\n');
  add(criterionIds[2], 'utc-boundaries-sorted-zero', header + 'a,2025-03-01T00:30:00+01:00,-0.50\nb,2024-12-31T23:30:00-01:00,0.50\nc,2025-01-03T00:00:00Z,-0.5\nd,2025-03-31T23:30:00-02:00,1.25\n', outputHeader + '2025-01,0.00\n2025-02,-0.50\n2025-04,1.25\n');
  add(criterionIds[2], 'arbitrary-precision', header + 'a,2025-01-01T00:00:00Z,900719925474099312345.67\nb,2025-01-01T00:00:00Z,0.01\nc,2025-02-01T00:00:00Z,-0.00\n', outputHeader + '2025-01,900719925474099312345.68\n2025-02,0.00\n');
  add(criterionIds[2], 'year-and-leap-validation', header + 'a,0001-01-01T01:00:00+01:00,0.01\nb,2000-02-29T00:00:00Z,1\nc,1900-02-29T00:00:00Z,99\nd,9999-12-31T23:59:59Z,2\n', outputHeader + '0001-01,0.01\n2000-02,1.00\n9999-12,2.00\n');
  // Generate semantic events first. Rendering is one-way; expected totals never parse CSV.
  let state = [...seed].reduce((n,c) => (Math.imul(n,31) + c.charCodeAt(0)) >>> 0, 13);
  const random = n => { state = (Math.imul(state,1664525) + 1013904223) >>> 0; return state % n; };
  const events = [], lines = [];
  for (let i = 0; i < 72; i++) {
    const id = `order_${random(23)}`, month = `2025-${String(1 + random(12)).padStart(2,'0')}`, cents = random(200001) - 100000;
    events.push({id,month,cents});
    const digits = String(Math.abs(cents)).padStart(3,'0');
    lines.push(`${id},${month}-15T12:00:00Z,${cents < 0 ? '-' : '+'}${digits.slice(0,-2)}.${digits.slice(-2)}`);
    if (i % 4 === 0) lines.push(`${id},not-a-date,999999`);
  }
  const totals = {};
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (events.some((later,j) => j > i && later.id === event.id)) continue;
    totals[event.month] = (totals[event.month] ?? 0) + event.cents;
  }
  const expected = outputHeader + Object.keys(totals).sort().map(month => {
    const value = totals[month], digits = String(Math.abs(value)).padStart(3,'0');
    return `${month},${value < 0 ? '-' : ''}${digits.slice(0,-2)}.${digits.slice(-2)}\n`;
  }).join('');
  for (const criterion of [criterionIds[1],criterionIds[2]]) add(criterion, 'seeded-event-ledger', header + lines.join('\n') + '\n', expected);
  add(criterionIds[3], 'header-only', header, outputHeader);
  for (const input of ['', 'id,when,amount\n', ' id,created_at,amount\n', '\ufeff' + header, 'created_at,id,amount\n']) add(criterionIds[3], 'bad-header', input, '', [], 2);
  add(criterionIds[3], 'unexpected-argument', header, '', ['extra'], 2);
  return cases;
}

export async function gradeFiles({execute, seed = 'hidden-default'}) {
  const checks = [];
  for (const test of buildCases(String(seed))) {
    let pass = false;
    try {
      const result = await candidateExecute(execute, {command:'node', args:['src/index.mjs', ...test.args], stdin:test.stdin, timeoutMs:5000});
      pass = result.code === test.code && result.stdout === test.expected && (test.code === 0 ? result.stderr === '' : result.stderr.length > 0);
    } catch (error) { if (error?.kind === 'grader-infrastructure') throw error; /* Candidate limit: failed check. */ }
    checks.push({...test,pass});
  }
  return criterionIds.map(criterionId => {
    const relevant = checks.filter(c => c.criterionId === criterionId);
    const failed = relevant.filter(c => !c.pass);
    return {criterionId, pass: failed.length === 0, observed:`${relevant.length - failed.length}/${relevant.length} subprocess cases passed; failures: ${failed.map(c => c.name).join(', ')}`};
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
