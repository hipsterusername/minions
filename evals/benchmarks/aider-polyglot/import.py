"""Reimport pinned ordinary files: python import.py ARCHIVE [REPO_ROOT]. No network."""
import hashlib, json, pathlib, re, sys, tarfile
PIN = '7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f'
root = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else pathlib.Path(__file__).resolve().parents[3]
archive = pathlib.Path(sys.argv[1])
expected_archive_sha256 = '331eb06fddbbc145e4a800b34c5afc2209b3664ce9a3267604fd9550b60bc68f'
if hashlib.sha256(archive.read_bytes()).hexdigest() != expected_archive_sha256:
    raise ValueError('Pinned archive SHA-256 mismatch')
bench = root / 'evals/benchmarks/aider-polyglot'
def put(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data if isinstance(data, bytes) else data.encode())
def js(value): return json.dumps(value)
header = """import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
// The pinned suites use only dense number arrays and Error message equality.
const expect = actual => ({
  toEqual(expected) { assert.deepStrictEqual(actual, expected); },
  toThrow(expected) { assert.throws(actual, error => error?.message === expected.message); },
});
"""
records = []
with tarfile.open(archive) as tar:
    members = {m.name: m for m in tar.getmembers()}
    for m in members.values():
        p = pathlib.PurePosixPath(m.name)
        if p.is_absolute() or '..' in p.parts: raise ValueError('Unsafe archive path')
    for short, slug, count, tokens, timeout in [('vlq','variable-length-quantity',26,500000,600000),('forth','forth',49,750000,900000)]:
        task_id = 'aider-' + short
        task = root / 'evals/tasks' / task_id
        gt = root / 'evals/ground-truth' / task_id
        prefix = f'polyglot-benchmark-{PIN}/javascript/exercises/practice/{slug}/'
        contents = {}
        for rel in [f'{slug}.js', f'{slug}.spec.js', '.meta/proof.ci.js', '.docs/instructions.md', 'LICENSE']:
            m = members[prefix + rel]
            if not m.isfile(): raise ValueError('Source must be an ordinary file')
            data = tar.extractfile(m).read()
            contents[rel] = data
            destination = gt / 'upstream' / rel
            put(destination, data)
            records.append({'path':str(destination.relative_to(root)), 'url':f'https://raw.githubusercontent.com/Aider-AI/polyglot-benchmark/{PIN}/javascript/exercises/practice/{slug}/{rel}', 'sha256':hashlib.sha256(data).hexdigest()})
        put(task/'starter'/f'{slug}.mjs', contents[f'{slug}.js'])
        put(task/'LICENSE', contents['LICENSE'])
        put(gt/'reference'/f'{slug}.mjs', contents['.meta/proof.ci.js'])
        source = contents[f'{slug}.spec.js'].decode()
        assert len(re.findall(r'\b(?:x?test)\(', source)) == count
        transformed = header + source.replace(f"'./{slug}'", f"'./{slug}.mjs'").replace('xtest(', 'test(')
        put(gt/'tests.mjs', transformed)
        contract = ('''Export encode(numbers) and decode(bytes) from variable-length-quantity.mjs.
Both take arrays and return arrays. Encode unsigned integers 0 through 0xffffffff
as minimal, most-significant-group-first VLQs; concatenate multiple encodings.
Decode concatenated VLQs into unsigned numbers in order, including values above
0x7fffffff. A trailing continuation byte must throw Error with message
`Incomplete sequence`, even when its payload is zero. Inputs are within the
stated unsigned 32-bit/byte domain; no other invalid-input behavior is required.
''' if short == 'vlq' else '''Export class Forth from forth.mjs. new Forth() starts with an empty stack;
evaluate(program) consumes a space-separated string of signed decimal integers
and words, preserving the stack and definitions across calls. Read stack as an
array from bottom to top. Arithmetic pops right operand then left operand;
/ performs integer division (positive quotients discard the fraction).
DUP copies the top item; DROP removes it; SWAP exchanges the top two;
OVER copies the second item onto the top. Too few operands for any operation
must throw Error('Stack empty'), including the one-operand binary case.
Division by zero throws Error('Division by zero'). Unknown words throw
Error('Unknown command'). Definitions use `: name body ;`; numeric names,
including negative integers, throw Error('Invalid definition'). Missing `;`
throws Error('Unterminated definition'). Words and definitions are case-insensitive.
Definitions may override built-ins, operators, or prior definitions. Existing
compiled words retain earlier meanings when a dependency is redefined; a new
definition may use the previous definition of its own name. Definitions belong
to their Forth instance. Only this small language is required; no REPL is needed.
''')
        prompt = '# JavaScript ' + slug + '\n\n' + contract + '\nUse Node built-ins only; implement the named module. You may create local checks.\nDo not use the internet or consult solutions outside this workspace.\nFor graph mode, use Codex with model gpt-5.6-sol for every child agent.\n\n' + contents['.docs/instructions.md'].decode()
        put(task/'prompt.md', prompt)
        put(task/'fixture.mjs', f'''import {{readFile, mkdir, writeFile}} from 'node:fs/promises';
import {{dirname, resolve}} from 'node:path';
export const schemaVersion = 1;
export const taskId = {js(task_id)};
export async function build() {{
  return {{schemaVersion, taskId, files: {{
    'README.md': await readFile(new URL('./prompt.md', import.meta.url), 'utf8'),
    'LICENSE': await readFile(new URL('./LICENSE', import.meta.url), 'utf8'),
    '{slug}.mjs': await readFile(new URL('./starter/{slug}.mjs', import.meta.url), 'utf8'),
  }}}};
}}
export async function materialize({{destination}}) {{
  const fixture = await build();
  for (const [name, content] of Object.entries(fixture.files)) {{
    const target = resolve(destination, name);
    await mkdir(dirname(target), {{recursive:true}});
    await writeFile(target, content);
  }}
  return fixture;
}}
''')
        manifest = {'schemaVersion':1,'id':task_id,'revision':'r2','family':'aider-polyglot','difficulty':'simple' if short=='vlq' else 'complex','promptFile':'prompt.md','fixture':{'builderId':'fixture.'+task_id,'configFile':'fixture.mjs','imageDigest':'node:26-alpine'},'requiredCapabilities':['filesystem','process'],'submission':{'include':['*.mjs'],'exclude':['node_modules/**'],'maxBytes':262144},'criteria':[{'id':task_id+'.upstream','description':f'Pass all {count} pinned Aider assertions/tests with skipped tests enabled.','mandatory':True}],'grader':{'id':'grader.'+task_id,'revision':'r1','configFile':f'../../ground-truth/{task_id}/oracle.mjs'},'limits':{'maxTotalTokens':tokens,'executionTimeoutMs':timeout,'preparationTimeoutMs':60000,'gradingTimeoutMs':60000}}
        put(task/'manifest.json', js(manifest)+'\n')
        put(gt/'oracle.mjs', f'''import {{readFile}} from 'node:fs/promises';
export const schemaVersion = 1;
export const taskId = {js(task_id)};
export const revision = 'r1';
export const testCount = {count};
export async function gradeFiles({{execute}}) {{
  const source = await readFile(new URL('./tests.mjs', import.meta.url), 'utf8');
  let pass = false, observed;
  try {{
    // Trusted test source travels over stdin; imports resolve in the candidate cwd.
    // Each grade gets a fresh Node process through the evaluator executor.
    const result = await execute({{command:'node', args:['--test-reporter=tap','--input-type=module','-'], stdin:source, timeoutMs:50000}});
    const metric = name => {{const matches = [...result.stdout.matchAll(new RegExp('^# '+name+' (\\\\d+)$','gm'))]; return matches.length === 1 ? Number(matches[0][1]) : -1;}};
    pass = result.code === 0 && metric('tests') === testCount && metric('pass') === testCount && metric('fail') === 0 && metric('skipped') === 0 && metric('cancelled') === 0;
    observed = `${{metric('pass')}}/${{testCount}} tests passed; exit=${{result.code}}; skipped=${{metric('skipped')}}; failed=${{metric('fail')}}`;
  }} catch (error) {{
    if (error?.kind !== 'candidate' || !['CANDIDATE_TIMEOUT','CANDIDATE_OUTPUT_LIMIT'].includes(error.code)) throw error;
    observed = error.code;
  }}
  return [{{criterionId:taskId+'.upstream', pass, observed}}];
}}
''')
        suite = {'id':task_id+'-validation','profiles':{'validation':{'taskIds':[task_id],'modes':['codex-raw','minion-single','minion-graph'],'repetitions':1}}}
        put(bench/(task_id+'.json'), js(suite)+'\n')
put(bench/'provenance.json', js({'repository':'https://github.com/Aider-AI/polyglot-benchmark','commit':PIN,'archiveUrl':f'https://codeload.github.com/Aider-AI/polyglot-benchmark/tar.gz/{PIN}','archiveSha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'license':'MIT; Copyright (c) 2021 Exercism','sources':records})+'\n')
