# Minions Quality / Operational Posture Review

Date: 2026-07-03
Repo: `/home/hipsterusername/PersonalRepos/minions`
Scope: read-only review of testing reality vs `docs/testing-strategy.md`, CI, error handling, observability, restart recovery, telemetry, dependencies.

## Reality-vs-Strategy Scorecard

| # | Strategy claim checked | Reality | Verdict |
|---|---|---|---|
| 1 | `server/db.ts` has new `server/db.test.ts` for fresh tmpdir migration/destructive migration safety (`docs/testing-strategy.md:454`). | Exists. Sampled test uses tmpdir DB and real writes to public tables / migrations (`server/db.test.ts:1`). | Aligned |
| 2 | `server/project-store.ts` has new `server/project-store.test.ts` (`docs/testing-strategy.md:455`). | Exists. | Aligned |
| 3 | `server/render-tools.ts` has new L2 `server/render-tools.test.ts` (`docs/testing-strategy.md:457`). | Exists. Also has stronger producer-to-consumer contract coverage in `tests/contracts/render-dsl-roundtrip.test.ts:1`. | Aligned |
| 4 | `server/minion-tools.ts` has new L2 `server/minion-tools.test.ts` (`docs/testing-strategy.md:458`). | Exists. | Aligned |
| 5 | Every `server/task-tools/<tool>.ts` has colocated tests (`docs/testing-strategy.md:459`). | All concrete task-tool files sampled are covered; only `shared.ts` and `types.ts` lack tests, which are support/types files. | Mostly aligned |
| 6 | `server/agents/registry.ts` has colocated test (`docs/testing-strategy.md:464`). | Missing `server/agents/registry.test.ts`. | Drift |
| 7 | `server/commands/<cmd>.ts` each have colocated tests (`docs/testing-strategy.md:465`). | Much improved but incomplete: missing tests for `approve-changes`, `canvas-context`, `force-merge`, `retry-merge`, `theirs-merge`; helper/index/types/test-harness also untested. | Drift |
| 8 | `server/routes/<area>.ts` have real Express route tests (`docs/testing-strategy.md:467`). | No colocated route tests under `server/routes/**`; coverage exists instead under `tests/contracts/*routes*.test.ts`. The strategy says colocated route tests. | Drift / partial substitute |
| 10 | Client pure-logic NEW tests: `use-socket`, `use-autosave`, `use-canvas-keyboard`, `wheel-detector` (`docs/testing-strategy.md:515-520`). | These exist (`use-socket.test.tsx`, `use-autosave.test.tsx`, `use-canvas-keyboard.test.tsx`, `wheel-detector.dom.test.ts`). | Aligned |
| 11 | Client pure-logic NEW tests: `canvas-scale`, `api`, `node-registry`, `skills/registry`, `skills/user-skills` (`docs/testing-strategy.md:498,521-524`). | Missing those target tests. | Drift |
| 12 | Component NEW tests: `Canvas.tsx`, `CanvasNode.tsx`, `EdgeRenderer.tsx`, `markup-palette.tsx` (`docs/testing-strategy.md:531-543`). | `CanvasNode.test.tsx` and `EdgeRenderer.test.tsx` exist. `Canvas.test.tsx` and `components/markup-palette.test.tsx` are missing. | Partial |
| 13 | Delete `tests/contracts/command-table.test.ts` and `image-node.test.ts` (`docs/testing-strategy.md:573-574`). | Both are absent. | Aligned |
| 14 | Harness snapshot rewrites: no inline snapshots in `tests/harness`; collapse duplicate `sdk-messages-snapshot` vs `session-stream-snapshot` (`docs/testing-strategy.md:583-584`). | `sdk-messages-snapshot.test.ts` is gone; `session-stream-snapshot.test.ts` remains but uses property assertions, no `toMatchInlineSnapshot`. | Aligned, filename stale |
| 15 | New banned assertion lint named `tests/architecture/no-banned-assertions.test.ts` (`docs/testing-strategy.md:567`). | Gate exists as `tests/architecture/banned-assertions.test.ts`, scanning `src`, `server`, `shared`, and `tests` (`tests/architecture/banned-assertions.test.ts:28`). Filename differs; no oxlint custom rule. | Functional drift |

## Suite Results

- `pnpm test:run`: failed in 6.53s. Vitest reported 253 test files, 3,388 tests: 3,387 passed, 1 failed.
- Failing test: `src/nodes/LeaderNode.test.tsx > LeaderNode: message actions > keeps chunk selection tied to assistant messages around grouped tools`.
- Failure evidence: `screen.getByText("Read, Grep")` cannot find the grouped tool label (`src/nodes/LeaderNode.test.tsx:387`).
- `pnpm typecheck`: passed in 11.8s.

## Strengths

- The suite is large, fast, and layered: 253 files / 3,388 tests ran in under 7s despite one failure.
- Many formerly aspirational §7 tests now exist, especially DB, project store, render tools, minion tools, command handlers, worktree internals, component tests, and hook tests.
- The strategy’s key quality guardrails are represented in executable tests: file-size ceilings, monotonic baseline ratchet, banned assertion scanner, no direct broadcast, no direct WS send, no cross-tree imports.
- Contract tests are moving in the right direction. `tests/contracts/render-dsl-roundtrip.test.ts` uses real server producer output and real client consumer replay rather than hand-built schema literals (`tests/contracts/render-dsl-roundtrip.test.ts:1`).
- User-visible session errors are usually surfaced through `session_error` bus events, not only logs (`server/session-host.ts:367`).
- Context-window recovery has a concrete implementation and integration coverage in `server/session-host.test.ts`; it starts one fresh compacted continuation and surfaces failure after a retry.
- Mutation testing is configured and exposed as `pnpm test:mutation`; `stryker.conf.json` targets the documented first rotation modules.

## Findings

### 1. High: Main suite is currently red

Evidence: `pnpm test:run` failed in 6.53s with 1 failing test out of 3,388. The failure is in `src/nodes/LeaderNode.test.tsx:387`, where the test expects visible text `Read, Grep` but RTL cannot find it.

Impact: The CI `Test` gate runs `pnpm test:run` (`.github/workflows/ci.yml:61`), so current main/PR verification is blocked. Since typecheck passes, this looks like a component behavior/test expectation regression rather than broad project breakage.

Recommendation: Fix or update the `LeaderNode` grouped-tool message behavior under the same test. Treat this as the first quality item because all other testing posture work depends on a green baseline.

### 2. High: §7 route coverage target is not met in the location/shape promised


Impact: The project may have useful route contract coverage, but the working agreement and actual tree have diverged. Reviewers cannot rely on §7 as an accurate coverage map.

Recommendation: Either move/duplicate route tests to the promised colocated files, or update §7 to name the actual `tests/contracts/*routes*.test.ts` ownership model and list uncovered route modules explicitly.

### 3. Medium: Several §7 NEW tests are still missing


Impact: The strategy says every matrix cell is a contract (`docs/testing-strategy.md:442-447`), but several contracts remain open without a documented exception.

Recommendation: Convert the scorecard into an explicit gap list. Add the missing tests or change the strategy rows to documented exceptions with owner/date.

### 4. Medium: Command coverage improved, but the “one per command” target is incomplete

Evidence: The strategy requires one colocated test per WS command (`docs/testing-strategy.md:465`). Missing command tests include `approve-changes`, `canvas-context`, `force-merge`, `retry-merge`, and `theirs-merge`. Many other command tests do exist, so this is no longer the old “28 commands need tests” state.

Impact: High-risk operational commands around merge/approval flows are not uniformly pinned at the command layer.

Recommendation: Prioritize merge/approval command tests first because they touch worktrees and user trust. Then update the strategy note that says only two commands are covered, because it is now stale.

### 5. Medium: Banned assertion gate exists, but it is not the oxlint/custom-rule story the strategy claims

Evidence: The strategy calls out `no-banned-assertions.test.ts` and oxlint custom rules (`docs/testing-strategy.md:391-405`, `docs/testing-strategy.md:598`). Actual repo has `tests/architecture/banned-assertions.test.ts`, not `no-banned-assertions.test.ts`, and `package.json` has no `lint` script or oxlint dependency (`package.json:11-69`). CI does not run lint/oxlint (`.github/workflows/ci.yml:55-68`).

Impact: The project does have a working Vitest architecture gate, but the tooling contract is inaccurate. New contributors looking for oxlint will not find it, and CI does not enforce any general lint pass.

Recommendation: Either add oxlint as documented and wire `pnpm lint` into CI, or amend the testing strategy to say banned assertions are enforced by Vitest architecture tests, not oxlint.

### 6. Medium: Operational logging is unstructured and console-only


Impact: Failures are hard to aggregate by session/project/request. This is acceptable for local development, but it weakens production/debug posture for multi-session agent workflows.

Recommendation: Introduce a small server logger wrapper with level, component, sessionKey/projectId fields, and JSON output option. Keep console as the sink initially, but stop formatting ad hoc strings at call sites.

### 7. Medium: Persistence failures are availability-friendly but can silently degrade recovery



Recommendation: Keep best-effort persistence for non-critical writes, but emit a session/project-scoped health event when persistence disables or repeatedly fails. Add a visible “persistence degraded” status and a counter so users know restart recovery is no longer guaranteed.

### 8. Medium: Context-window recovery is useful but narrow and somewhat entangled with proactive compaction

Evidence: Recovery triggers only when `resumeId` is present, attempts only once, clears `resumeId`, and builds a compacted prompt from task state, recent events, and original prompt (`server/session-host-context-recovery.ts:38-65`, `server/session-host-context-recovery.ts:80-102`). In `SessionHost.start`, any run with no `recoveryOpts` then calls `buildPendingCompactionStartOptions` and recursively restarts if it returns options (`server/session-host.ts:360-365`).

Impact: This is a good recovery path for resumed context-window failures, but it does not address server-process restart mid-active-stream by itself. The recursive restart path is dense, and a regression could cause unexpected continuation loops if compaction conditions change.

Recommendation: Keep the existing integration tests and add focused tests around “no compaction => drain wait resume”, “compaction emits exactly once”, and “context recovery does not also emit session_error”. Document exactly which restart scenarios are covered: model context overflow vs Node server restart.

### 9. Low/Medium: Usage telemetry is local accounting, not operational telemetry

Evidence: `server/usage-telemetry.ts` tracks token/cost totals in SQLite and computes cache hit rate (`server/usage-telemetry.ts:31-134`). No metrics emitter, histograms, counters, tracing, or external telemetry sink were found.

Impact: The app can show usage totals, but operators cannot answer reliability questions such as error rate by harness, command latency, dropped persistence writes, reconnect count, or recovery success rate without log scraping.

Recommendation: Do not add a heavyweight telemetry stack yet. Add internal counters/events for session errors, command validation errors, persistence degraded state, context recovery attempts/success/failure, and MCP tool errors. Expose them via debug endpoint or structured logs.

### 10. Low/Medium: Dependency pinning is mixed and CI has no dependency-risk gate beyond frozen install/licenses

Evidence: `package.json` pins many UI/build packages exactly, but core runtime/harness packages use ranges: `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `better-sqlite3`, `express`, `ws`, `zod`, Stryker, `tsx`, and several `@types/*` entries (`package.json:34-69`). `pnpm-lock.yaml` is present and CI runs `pnpm install --frozen-lockfile` (`.github/workflows/ci.yml:52-53`) plus license check (`.github/workflows/ci.yml:64-65`). No audit/vulnerability/SBOM gate is present. `dist/` exists locally but is ignored and not tracked by git.

Impact: The lockfile protects CI reproducibility, but range specs make dependency update PRs potentially broader than the source manifest suggests. Lack of an audit gate may be acceptable for local tooling, but it should be an explicit choice.

Recommendation: Decide whether harness/runtime deps should be exact pins like React/Vite/Vitest. If staying with ranges, keep Dependabot focused and consider a non-blocking scheduled audit report rather than gating every PR.

### 11. Low: Some schema tests still read like schema parity rather than producer/consumer contracts




### 12. Low: CI is complete for verify, but not broad for version/platform confidence

Evidence: CI runs one job on `ubuntu-latest` and Node 22 (`.github/workflows/ci.yml:29-68`). It performs frozen install, app typecheck, server typecheck, test, license check, and build. There is no OS or Node matrix.

Impact: This is pragmatic and fast, but the app includes native `better-sqlite3`, filesystem/worktree operations, and WebSocket/server code where Node/OS differences can matter.

Recommendation: Keep the fast single-job PR gate. Add a scheduled or manual matrix smoke job for Node LTS/current and macOS if this app is expected to be developed/run cross-platform.

## Test Quality Sampling

- Command test: `server/commands/create-session.test.ts` is strong. It names two production regressions, tests live-vs-stopped cap behavior, and asserts session-scoped error routing rather than implementation internals. One caveat: it reaches into `SessionRegistry.map`, but that is for fixture setup.
- Task-tool test: `server/task-tools/assign-task.test.ts` is broad and behavior-focused: parse guard, prompt construction, skill substitution, result text, emitted task/spawn events. It uses real `project-store` skill writes and a fake bus boundary, which matches strategy.
- Component test: `src/SessionPanel.test.tsx` is mostly aligned. It removed trivial `getBy*.toBeDefined()` tests and now checks collapsed state, grouping, focus callback, aria state, and token display.
- Contract test: `tests/contracts/ws-envelope.test.ts` and `ws-envelope-roundtrip.test.ts` correctly drive real bus/unicast producers into `wsEnvelopeSchema`. This is aligned with §5.4, though there is some overlap between the two files.
- Architecture test: `tests/architecture/banned-assertions.test.ts` is useful and stricter than the doc in some ways because it scans `src`, `server`, `shared`, and `tests`. It also has an escape hatch marker, which is pragmatic but needs periodic review.
- Harness test: `tests/harness/session-stream-snapshot.test.ts` no longer uses inline snapshots. It remains named “snapshot”, but the assertions are properties: roles, content, costs, streaming buffer transitions.

## CI Assessment

CI is a solid `verify` mirror: frozen pnpm install, typecheck, server typecheck, test, license check, build. Actions are SHA-pinned, token permissions are read-only, and pnpm caching is enabled through `actions/setup-node`.

Gaps: no lint/oxlint despite the strategy naming oxlint; no OS/Node matrix; no coverage/mutation gate by design; no dependency audit gate; CI timeout is 10 minutes, reasonable for the current 7s test suite but potentially tight if build/test expand.

## Operational Posture Summary

Errors surfaced to users:
- WS parse/validation failures are sent as global `error` envelopes (`server/ws-connection.ts:54-64`).
- Session harness/runtime failures become `session_error` envelopes and buffered events (`server/session-host.ts:367-382`).
- MCP bridge tool failures are returned as MCP tool results with `isError: true`, not thrown over HTTP (`server/mcp-bridge/dispatch.ts:212-240`).

Errors mostly logged only:
- Persistence open/write/read failures.
- Cleanup/worktree warnings.
- Clipboard/UI copy failures.
- Some debug-oriented canvas/server logs.

Recovery:
- Session event buffering and persistence are intended to rebuild transcripts after restart.
- Context-window overflow recovery is implemented for resumed sessions and tested.
- Persistence degradation is the main recovery risk because it is silent beyond logs.

Telemetry:
- Usage accounting exists in SQLite.
- No general metrics, traces, counters, or structured logs.

## Top 5 Recommendations

1. Restore the green test baseline by fixing the failing `LeaderNode` grouped-tool message test/behavior.
2. Reconcile `docs/testing-strategy.md` §7 with the actual tree: mark completed items, list remaining gaps, and correct stale filename/tooling claims.
4. Add a minimal structured logger and persistence-degraded health signal so operational failures are visible by session/project, not only buried in console output.
5. Decide the lint story: either wire oxlint into `package.json`/CI as documented, or officially make Vitest architecture tests the lint substitute and remove oxlint from the strategy.
