# Operational implementation acceptance

This checklist complements SPEC.md. A registered interface or command that always
returns unsupported is not a working execution path. Provider access need not be
used in development, but credential-free process tests must exercise real launch,
streaming, stopping, collection, grading and reporting.

## Shared integration conventions

- Keep the existing public schema/type exports compatible where possible. New
  optional execution metadata belongs in configuration or explicitly versioned
  records; do not infer task IDs from opaque cell/run IDs.
- A task's `starter/` directory contains the actual files given to participants.
  Fixture recipes are controller-side builders. Reference implementations live
  only under `ground-truth/<task-id>/reference/`. No reference function is exported
  from public fixture files. Each task exposes a deterministic public export.
- Task graders execute submitted files in a separate process through an injectable
  executor. They compare returned data against controller-owned expectations.
  Do not import candidate functions into the controller or grader process.
- Grader executors must support local development and Docker command execution;
  the local backend is explicitly ineligible for controlled measurements.
- All artifact results include the actual task, mode, repetition and launch
  identity. Preserve raw/normalized usage, submission files and grade results.
  A credential-free demo may use a named fake adapter, clearly labeled as a
  harness check rather than an agent benchmark.
- Real adapters can receive an execution descriptor through configuration:
  `{ execution: { kind: "local" | "docker", containerName?: string,
  workdir: string, stateRoot: string } }`. Docker descriptors must be produced
  and verified by the isolation backend, not trusted from task-controlled input.
  Launch participant commands with `docker exec` in that container; starting an
  idle container while spawning the agent on the host does not establish isolation.
- Durable subprocess execution can use an external supervisor that writes PID,
  exit state and JSONL logs outside the participant workspace. Reconnect reads
  those handles/logs without restarting an agent. Cancellation kills descendants.
- Minions needs a concrete external WS/HTTP client, a dedicated instance startup
  recipe, and actual protocol tests. Existing application commands are the
  integration boundary; do not invent an unimplemented `/eval` endpoint.
- Root `codex --disable multi_agent --disable multi_agent_v2 features list`
  demonstrates the available delegation controls. Verify the effective feature
  settings and pass them to launches; avoid assuming `exec --help` lists every
  available configuration setting.
- Docker `declared_only` cannot map silently to unrestricted bridge networking.
  Reject unsupported policies before launch. `network=none` credential-free
  isolation tests must run against a real container when the host permits it.
- Reports consume shared, tested aggregation rules. Full success requires a
  completed execution, valid protocol adherence, all mandatory criteria passed,
  and passing regression gates. Missing criteria remain in the denominator.
- An offline report must contain actual plotted quantitative data and useful
  chart export, along with accessible tables; a list of textual points or an SVG
  containing only a report title is insufficient.
- Include `src/**/*.test.ts` and `tests/**/*.test.ts` in package test discovery.
  The parent `.gitignore` ignores all directories named `reports/`; use scoped
  package exceptions for report source/tests, not for generated run artifacts.

## Required black-box acceptance

1. A fresh external directory can run validate, plan, and a credential-free demo
   through the built CLI, producing finalized result records, frozen files,
   grades, usage coverage and an offline report.
2. Cancel and resume operate on persistent handles; an interrupted controller
   does not duplicate participant launch, erase deadlines, or drop failed cells.
3. An executable test fixture for raw Codex and a protocol-compatible local WS
   fixture for Minions exercise concrete clients without calling providers.
4. All six reference submissions pass independently executed hidden cases, and
   broken starters/targeted defects fail. Archive has real persistent storage,
   HTTP endpoints and UI; worker recovery uses real restartable processes and
   committed persistent effects. Data tasks run submitted CLI programs.
5. Report tests include even-sized medians, missing mandatory criteria, invalid
   protocol, empty filters, all three pairwise mode comparisons, incomplete
   telemetry, script injection and plotted-data exports.
6. Package build/typecheck/all tests pass. Model validation and discovery point
   future agents to the actual CLI, extension and visualization files.

## Lifecycle and provenance requirements

- The controller owns dedicated Minions startup, endpoint binding and shutdown,
  persists the server handle for recovery, and includes startup in measured time.
  Container-loopback endpoints use a controller-owned container transport;
  they must never connect accidentally to a host instance at the same port.
- Workspace preparation consumes the fixture's allowlisted build/materialization
  contract, including public manifests and examples. Preparation inputs are pinned;
  browser and image prerequisites are probed before participant execution.
- Collection, cancellation, errors and recovery clean up owned participant and
  grading processes and containers. Durable accounting evidence survives teardown.
- Launch requests conform to the application's actual command schemas. Requested
  model and reasoning settings are applied and recorded, or rejected explicitly.
  Receipt identities remain valid and stable across controller recovery.
- Raw accounting retains original provider fields. Normalized accounting handles
  replay, duplicates and corrections separately without losing the raw evidence.
- Infrastructure failures produce grading errors; candidate build, assertion and
  execution-limit failures produce task failures. Unknown executor exceptions
  must not silently become failed correctness criteria.
- Persisted graph reports include graph edges and each distinct attempt's state,
  duration, tokens and available integration provenance, including retries.
- CLI output reflects actual execution provenance. Unknown provider usage stays
  unknown; only the credential-free demo may assert no provider calls by design.
- Evaluator fingerprints cover implementation source and lockfile. Task hashes
  include trusted grader dependencies, not just the oracle entry point. Controlled
  plans require immutable image digests or reject mutable tags before launch.
- Archive restore cases preserve a seeded nonempty description and reject a
  candidate that erases it during restore.

## Reproducible checks

Run package checks from `evals/`, with Node 24+, pnpm, and the matching Chromium
runtime prepared as described in [the quickstart](../README.md):

```bash
pnpm install --ignore-workspace --frozen-lockfile
pnpm typecheck
pnpm test
node dist/src/cli/main.js validate --suite suites/baseline.json
```

The opt-in Docker check requires a locally available, digest-pinned Node image
with the fixture prerequisites. It does not pull an image or call a provider:

```bash
AGENT_EVALS_DOCKER_TEST=1 \
AGENT_EVALS_DOCKER_IMAGE='registry.example/node@sha256:REPLACE_WITH_PREPARED_DIGEST' \
pnpm exec vitest run --config tests/support/vitest.config.ts tests/lifecycle/docker-live.test.ts
```

From the repository root, validate model discovery and external protocol contracts:

```bash
pnpm system-model:validate -- --strict
pnpm exec vitest run server/system-model/repository-context.test.ts server/system-model/match.test.ts server/system-model/gates.test.ts
pnpm exec vitest run --config evals/tests/support/vitest.config.ts tests/evals/adapter-wire-contracts.test.ts
```

Keep run-specific logs, snapshots, screenshots and verification verdicts outside
published documentation. Record sandbox-denied checks separately from source
failures; broad passing suites do not supersede a reproduced contract defect.
Credential-free checks establish harness behavior, not comparative agent quality
or token-efficiency results.
