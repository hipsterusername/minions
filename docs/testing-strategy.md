# Testing strategy

Tests earn their maintenance cost by detecting a distinct, plausible regression.
Use coverage and runtime as diagnostic trends; neither a test-count target nor a
global coverage percentage establishes that a suite protects the product.

## Choose the boundary

| Risk / behavior | Preferred evidence |
| --- | --- |
| Pure decisions, parsing, graph transformations | Small deterministic unit tests with meaningful boundary cases |
| Authorization, paths, workspace identity, provider permissions | Positive and negative contract tests through the actual validation boundary |
| Persistence, cancellation, recovery, event ordering | State-transition tests that observe stored state, emitted events, and failure handling |
| UI interaction and accessibility | DOM tests that perform the interaction and inspect its observable result |
| Geometry, overflow, responsive layout | Browser evidence where jsdom cannot model layout; focused CSS checks only for an explicit invariant |
| Installation, native modules, clean startup | Isolated install and smoke suites, including platform-specific CI |
| Forbidden architectural dependencies | Narrow architecture checks with a documented rule and actionable failure |

Mock external providers, clocks, and other nondeterministic boundaries where
appropriate. A mock-heavy test can still protect valuable orchestration. Check
the outcome as well as the call when a collaborator invocation alone does not
establish the behavior. Avoid duplicating implementation logic in expected values.

## Review, prune, or refactor

For each candidate, record the triggering input, the defect the test would catch,
and the assertion that detects it. Classify the test as keep, refactor, replace,
delete, or defer. Prioritize authority boundaries, persisted state, concurrency,
compatibility, and recovery before cosmetic duplication.

A deletion needs one of these evidence trails:

- **Duplicate:** name the surviving test and show that it exercises the same
  boundary and failure mode, including any distinct input or negative case.
- **Tautology:** show why a broken production implementation cannot falsify the
  assertion. Preserve any independent behavior assertions in the same test.
- **Obsolete behavior:** trace the removed feature or unreachable path in current
  code and check callers and compatibility requirements.
- **Implementation coupling:** replace a source-text or private-shape assertion
  with executable behavior, or identify existing stronger coverage first.

Do not delete a test merely because it is failing, slow, small, mocked, textual,
or similar to another test. In a spatial application, geometry and visibility
are behavior. Protocol shape and architecture rules can also be real contracts.
Consolidating table-driven cases reduces repetition, not the number of behaviors
that should be exercised. Share fixtures only when their defaults and mutations
remain clear at each call site.

Keep reusable fixtures in non-test modules. Importing a discovered test file
registers its scenarios again in the importing suite. Verify the canonical
scenarios and consumer scenario identities before and after extracting helpers.
Temporary fixture projects and application homes should live under a root owned
by suite cleanup, including on assertion failure.

Make assertions discriminate between plausible implementations: insert records
out of order before testing sorting; establish nonempty collections before
uniqueness or identity loops; assert marker presence before comparing indexes;
use independently known expected values rather than the object's post-call state.
For a deduplication limit, choose inputs that exceed the limit when duplicates
are incorrectly counted, and retain a distinct-input overflow case.

## Verification and progress gates

1. Inventory every test surface and record the starting worktree and pre-existing
   failures. Separate full-file inspection from automated triage or sampling.
2. Partition independent audits with exclusive write ownership. Preserve unrelated
   work. Join the branches only after each produces its coverage and change ledger.
3. Run affected suites after each coherent change. For consequential replacements,
   deliberately perturb the protected behavior or use focused mutation testing
   to check that the assertion fails; restore the perturbation before proceeding.
4. Independently review all deletions and meaningful assertion changes. Reject
   changes whose surviving coverage does not protect the stated failure mode.
5. Run the complete applicable suite and type checks. Compare failures by test
   identity and cause, not only total count. Report unavailable checks explicitly.
6. Record tests and lines removed, maintenance simplifications, meaningful coverage
   added or preserved, unresolved risks, and validation. A smaller suite is useful
   only if the evidence still supports the product's important behaviors.

Stop pruning when remaining candidates lack proof of redundancy or require
unrelated production changes. Record those candidates for a later scoped review.
Revisit this ledger when touching the associated behavior or when a flaky/slow
suite imposes a concrete maintenance cost.

## Repository checks

An exhaustive audit must account for every original file, including dirty files
that cannot be edited. Read all scenario bodies and trace the governing production
paths. Record per-file hashes, full read ranges, scenario groups, production line
references, assertion quality, negative cases, isolation and a retention decision.
Automated callback-span and hash checks detect omissions and drift; they supplement
semantic review. A reviewed file may still have documented gaps. Reconcile changed
files before accepting evidence, retry interrupted batches from retained records,
and keep completion dependent on independent review and integrated validation.

- `pnpm exec vitest run <affected paths> --maxWorkers=2` provides focused feedback.
- `pnpm test:run` runs the Node and DOM projects in `vitest.config.ts`.
- `pnpm typecheck` and `pnpm typecheck:server` validate the separate TypeScript trees.
- `pnpm verify` additionally checks licenses, the system model, and the build.
- `pnpm test:coverage` and `pnpm coverage:report` diagnose coverage trends in CI;
  there is deliberately no global coverage gate.
- `pnpm test:install`, `pnpm test:sqlite`, and `pnpm test:smoke` protect startup and
  packaging. `pnpm test:e2e` runs smoke followed by broader browser scenarios.
- `pnpm test:mutation` currently targets `src/canvas-state.ts` and
  `src/graph-runtime.ts`; it is a periodic diagnostic, not a universal gate.

Tests that exercise filesystem state must isolate it in temporary directories,
clean up only their own resources, and avoid depending on the developer's live
registry, credentials, or sessions. Prefer an explicit fixture for the actual
storage boundary over assuming that mocking one import isolates all transitive
writes. Both Vitest projects run `tests/setup-node.ts` before each test file to
supply a fresh `MINIONS_HOME` and `DB_PATH`, and clear inherited
`MINIONS_SERVER_DB` and `MINIONS_ARTIFACTS_DIR` overrides. Teardown removes the
temporary directory without restoring live storage paths that late session
finalizers could use. Fixtures can override these values for path-specific
behavior, but must restore the isolated values afterward. This
isolates application state; it does not redirect every possible filesystem path
or provider credential. Browser fixtures create their own temporary application
home and explicitly override all four storage variables for the test server.
`pnpm test:install` exercises these boundaries with a simulated user installation
to catch fixture sessions leaking into real storage.

Keep per-run audit ledgers, handoffs, logs, and reproduction evidence in ignored
`.scratch/<task>/` directories or an OS temporary directory. Publish only
sanitized findings and reproducible instructions that stand on their own without
local evidence files. See [Local working artifacts](../CONTRIBUTING.md#local-working-artifacts).
