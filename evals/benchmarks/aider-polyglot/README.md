# Two pinned Aider JavaScript tasks

`aider-vlq` and `aider-forth` are evaluator fixtures derived from
[Aider-AI/polyglot-benchmark at 7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f](https://github.com/Aider-AI/polyglot-benchmark/tree/7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f/javascript/exercises/practice).
`provenance.json` records the archive URL/SHA-256 and every imported source
URL/SHA-256. The imported exercises carry the MIT license, copyright 2021
Exercism; complete notices accompany both public tasks and preserved sources.
Both references are the pinned Aider `.meta/proof.ci.js` bytes, unchanged except
for the destination filename. No external Exercism fallback was needed.

| Task | Tests | Assertions | Originally skipped | Tokens | Execution deadline |
|---|---:|---:|---:|---:|---:|
| aider-vlq | 26 | 26 | 25 | 500,000 | 600 seconds |
| aider-forth | 49 | 50 | 48 | 750,000 | 900 seconds |

Task revision `r2` raises the initial 60,000/120,000-token calibration caps;
the upstream sources, prompts, and graders are unchanged. These are observed
usage limits: a provider may report a large turn only after it finishes, so a
run can overshoot its cap substantially. Keep budget outcomes and usage coverage
separate from upstream test correctness when interpreting results.

Both grading deadlines are 60 seconds. The grader executes one fresh Node process
with a 50-second command limit. All tests must pass, with exactly the expected
test/pass counts and zero skipped, failed, or cancelled tests. Unknown executor
faults propagate as infrastructure errors; candidate time/output limits fail.

The mechanical transform prepends `node:test` imports and a narrow assertion
adapter, changes the candidate import suffix to `.mjs`, and replaces every
`xtest(` with `test(`. All remaining upstream test bytes are identical.
`toEqual` maps to `assert.deepStrictEqual` (these suites compare only dense numeric
arrays). `toThrow(new Error(message))` maps to `assert.throws` with exact message
equality, preserving Jest's Error-argument semantics. Nested suites and the Forth
`beforeEach` remain intact. The grader forces TAP reporting and checks counts.
Preserved originals and transformed tests live only in `ground-truth/`.

The public builder exports exactly README.md, LICENSE, and the upstream starter
renamed to `.mjs`. Prompts include the API, errors, state/definition behavior,
upstream instructions, no internet/outside-workspace solutions rule, and the
Codex gpt-5.6-sol child-model instruction for graph mode. Frozen submissions
include top-level `.mjs` files only. Grading sends trusted test source over stdin
through the common executor; the controller never imports candidate modules.

From the repository root, reimport using Python 3 and the pinned archive:

```sh
# Download is an explicit preparation step; import.py itself is offline.
curl --fail --location https://codeload.github.com/Aider-AI/polyglot-benchmark/tar.gz/7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f --output /tmp/aider-polyglot.tar.gz
python3 evals/benchmarks/aider-polyglot/import.py /tmp/aider-polyglot.tar.gz
cd evals
node --import tsx src/cli/main.ts validate --suite benchmarks/aider-polyglot/aider-vlq.json
node --import tsx src/cli/main.ts validate --suite benchmarks/aider-polyglot/aider-forth.json
pnpm exec vitest run --config tests/support/vitest.config.ts tests/fixtures/aider-polyglot.test.ts
pnpm typecheck
```

The importer verifies the pinned archive hash before writes, rejects unsafe paths,
and reads only explicitly named ordinary members; it does not unpack arbitrary
archive entries. It regenerates task packages, originals, references, suites and
provenance deterministically. The README, importer, and regression test are
maintained source. With a built evaluator, the equivalent CLI entry is
`node dist/src/cli/main.js`. Package dependencies must already be installed;
the implementation/tests require no Jest, downloads, or paid provider calls.

The regression test verifies source hashes, exact transforms/counts, unchanged
references, public allowlists, reference acceptance and starter rejection through
`verifyOracle`, and frozen mutant rejection through `processExecutor`. The VLQ
mutant makes decoded high-bit values signed; the Forth mutant subtracts for `+`.

These suites list all three modes but intentionally omit runtime/model settings;
the run owner must supply matched adapter settings before planning paid runs.
Prompt instructions alone do not enforce child model selection. This is an
adapted hidden-test evaluation, not the original Aider editing/test-feedback
protocol. Static upstream coverage is not exhaustive language correctness.
The local executor is not a hostile-code security boundary; candidate and tests
share a process, and local development does not hide the host checkout. Use
appropriate isolation for participants. Validation is fixture evidence only,
not model performance evidence. No participant runs are included.
