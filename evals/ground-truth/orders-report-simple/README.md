# Controller integration (revision r2)

Public builder: `tasks/orders-report-simple/fixture.mjs` exports async
`build(seed: string)` returning `{schemaVersion: 1, taskId, files: Record<string,string>}`
and `materialize({destination: string, seed?: string})`, which writes those files
into a **new, controller-owned empty directory**. Export only `files`, never the
whole task directory, task manifest, recipe, repository, or this directory.
No dependencies, Git history, hidden tests, or solution files belong in the export.
The public source is `starter/src/index.mjs`; the reference is `reference/src/index.mjs`
under this grader-only directory. To validate a reference, first materialize a
public fixture, then replace only `src/index.mjs` with that reference file.

`oracle.mjs` exports `schemaVersion`, `taskId`, `revision`, `criterionIds`, and:

```ts
async function gradeFiles({ execute, seed = 'hidden-default' }: {
  execute(request: {
    command: string; args: string[]; stdin?: string; timeoutMs?: number;
  }): Promise<{code: number; stdout: string; stderr: string}>;
  seed?: string;
}): Promise<Array<{criterionId: string; pass: boolean; observed: string}>>;
```

This structurally returns foundation `CriterionVerdict` records with exactly the
manifest's mandatory criterion IDs. `execute` must spawn the command with the
frozen submission as cwd, pipe stdin, collect bounded stdout/stderr, enforce the
provided timeout and kill descendants. A Docker executor runs the same command
inside the submission container. Expectations and the oracle stay outside that
container. Do not import candidate functions into the controller. No legacy
in-memory `grade(candidate)` or public reference export is supported.

The seed deterministically chooses additional hidden cases. It is supplied by
the controller and is not a path. Execution errors, timeouts, malformed responses,
and wrong exit/output behavior fail the affected criteria. Each mandatory
criterion has curated cases; seeded cases supplement the explicit boundary cases.
`observed` contains case labels and counts, not expected outputs. Grading feedback
is retained only after participant execution ends.

Local subprocess tests are credential-free functional checks. Host cwd isolation
is not a security boundary or evidence of controlled Docker isolation. The runner
owns isolation, resource limits, immutable capture, and grade result provenance.
Run from `evals/`: `pnpm exec vitest run --config tests/support/vitest.config.ts tests/fixtures/simple-process.test.ts`.
