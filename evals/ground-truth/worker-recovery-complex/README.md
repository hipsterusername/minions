# Worker fixture integration API

The public builder `tasks/worker-recovery-complex/fixture.mjs` exports async
`build(seed)` returning `{schemaVersion:1,taskId,files:Record<string,string>}` and
`materialize({destination,seed?})` writing exactly those files. Only README,
starter `src/index.mjs`, and a seeded example are exported. Reference source is
under this directory's `reference/src/index.mjs`, never in the builder.

The controller module `oracle.mjs` exports `revision`, `criterionIds`, and
`async gradeFiles({execute,seed?})`. It uses the foundation `GraderExecutor`
contract (`src/graders/executor.ts`): `execute({command,args,stdin?,timeoutMs?})`
runs in the submission cwd and returns `{code,stdout,stderr}`. The existing
`fileGrader` translates `{criterionId,pass,observed}` into foundation grades.
Node 22+, a writable submission cwd and child process support are required.
All commands work with local or Docker executors; local execution is a fixture
development check, not an isolation claim. No provider calls are made.

A trusted transport starts real candidate Node processes, captures OS exit
signals, and reads state.json. The oracle computes expected states in the
controller, never imports candidate modules, and never sends expected states
back after queue initialization. It creates fresh private queue directories per
case and cleans them in finally. It does not load reference source. Reference
and faulty variants are installed as source bytes only by the fixture tests.

Criterion mapping:

| Criterion | Independent observations |
| --- | --- |
| worker.claim-lease | All persisted job fields, attempt counts, skip before lease expiry, reclaim at equality, two transient failures with retry delay, skip done jobs |
| worker.restart | Actual SIGKILL at each requested boundary, subsequent fresh-process recovery, no lost/prematurely done jobs, empty queue and stable completion |
| worker.idempotency | Full ordered journal equals expected IDs and values at every boundary; repeated post-effect crashes commit once |

`tests/fixtures/worker-process.test.ts` runs the reference with multiple seeds,
checks repeatability/public export, and rejects the starter and targeted defects
through real subprocesses. Power failure, filesystem corruption and concurrent
live workers are outside the public serialized-worker contract. Atomic snapshot
rename plus fsync implements the local queue/effect boundary without SQLite or
third-party dependencies.
