# Reconciliation fixture and grader integration

Revision r2 replaces function-object grading with submitted file execution.
Requires Node 22+; fixture, starter, reference and oracle are portable `.mjs`
with no package dependencies. No model, network or application state is used.

Public controller API (`tasks/reconciliation-complex/fixture.mjs`):

- `await build(seed)` returns `{schemaVersion:1, taskId, files}`. `files` maps
  relative paths to UTF-8 content: README, actual `starter/src/index.mjs`, and
  four example JSON inputs. The export uses a fixed allowlist, never a recursive
  repository copy. The fixture recipe itself is not a participant file.
- `await materialize({destination, seed})` writes that export into an isolated
  destination and returns the same fixture. Example amounts vary deterministically
  with the seed. No reference or hidden data is exported.

Hidden controller API (`oracle.mjs`):

```
await gradeFiles({seed, execute})
// execute({command, args, stdin?, timeoutMs?})
//   => Promise<{code, stdout, stderr}>
```

`execute` must run with the frozen submission as cwd. Use the foundation
`processExecutor(submissionRoot, timeoutMs)` for credential-free local checks,
its Docker descriptor for container grading, or an equivalent executor. The
foundation `fileGrader` accepts this oracle directly. Local tests are functional
checks, not controlled benchmark measurements. Enforce process-group termination
and output bounds in the executor. The grader invokes Node with a controller
input-only driver, which writes four fresh paths (with spaces), spawns the actual
`src/index.mjs` with file arguments, and checks the inputs were not modified.
Candidate code is never imported by the controller; all expected output remains
outside the participant process. Submission code and inputs are untrusted: this
protocol is not a replacement for an isolation backend.

The hidden `cases.mjs` holds hand-calculated edge cases and a seeded independent
integer ledger. The ledger constructs semantic values before rendering decimals;
it does not call or copy candidate/reference money or join helpers. Reference
source exists only in `reference/src/index.mjs`. Grading compares exact stdout,
exit code and the documented stderr policy. Executor errors fail every criterion.
The grader exports schemaVersion, taskId, revision and criterionIds for discovery.

| Criterion | Cases |
| --- | --- |
| reconciliation.joins | Zero orders; unknown-reference precedence; missing rates; duplicate exception IDs; normalized ASCII ordering |
| reconciliation.deduplication | UTC latest winner, equal-instant later row, independent payment/refund namespaces |
| reconciliation.rates | UTC timezone crossing; inclusive boundary; rate tie; future exclusion; no inverse/chaining; same-currency identity |
| reconciliation.rounding | Aggregate half-up; six-digit products; arbitrary precision beyond Number safe integers |
| reconciliation.refunds | Partial refunds; chronology and ID tie; reject excess without clamping; exact unrounded limit; own-date conversion |
| reconciliation.io | Four paths; empty arrays; row/date/decimal validation; invalid losing duplicates; malformed JSON; exit and input preservation |

The seeded ledger also maps to every criterion, ensuring a malformed/nonfunctional
submission cannot pass a criterion by printing an error. Each criterion receives
one verdict regardless of its case count. Tests spawn the reference, starter and
15 targeted faulty source variants, plus malformed, mutating and looping files.

Validation command from repository root:

```
pnpm --dir evals exec vitest run --config tests/support/vitest.config.ts tests/fixtures/reconciliation-process.test.ts
```

Only this task package is covered here. Suite-wide profiles, runner lifecycle,
other task families and measured experiments belong to their respective owners.
