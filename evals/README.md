# Standalone agent evaluations

`agent-evals` prepares fixtures, runs participants, persists lifecycle and usage,
freezes submissions, executes graders, and builds offline reports. It runs as a
separate package and process. Minions adapters communicate with dedicated server
processes through the application's HTTP/WS protocol; there are no application
runtime imports.

## Credential-free quickstart

Use Linux, Node 24+ and pnpm. From `evals/`:

```bash
pnpm install --ignore-workspace --frozen-lockfile
pnpm build
node dist/src/cli/main.js demo --results-root /tmp/agent-evals-demo
```

Choose a fresh absolute directory outside the source checkout. The demo launches
two actual fixture processes, captures files and fixture usage counters, grades
one correct and one incorrect submission, and writes an HTML report. **Exit 1 is
expected** because the incorrect case fails. Its counters are harness evidence,
not model measurements. No provider credentials or application server are needed.
The emitted JSON contains the experiment and report paths. Open `report.html`
locally; it has no external scripts, fonts, server or network dependencies.

All commands emit JSON (the optional `--json` flag is accepted). Exit codes are:
0 success; 1 finalized task/protocol failures or incomplete cohort; 2 invalid
configuration, provenance drift or unsupported preflight; 3 execution/collection/
grading infrastructure failure; 130 cancellation. Report exit 0 only means the
report was generated.

```bash
node dist/src/cli/main.js status --experiment /tmp/agent-evals-demo
node dist/src/cli/main.js resume --experiment /tmp/agent-evals-demo
node dist/src/cli/main.js cancel --experiment /tmp/agent-evals-demo
node dist/src/cli/main.js grade --experiment /tmp/agent-evals-demo
node dist/src/cli/main.js report --experiment /tmp/agent-evals-demo
```

Resume reconnects durable handles and retains original deadlines. It never
restarts a finalized participant. Cancel persists an admission stop, stops owned
processes and descendants, and preserves partial results. Grading uses frozen
files without starting participants and preserves grade revisions. Reports write
new analysis directories, include planned but unlaunched cells, and work with
participants and Minions shut down. Filters share the same tested arithmetic as
JSON/CSV exports. Chart SVG downloads contain the displayed plotted data.

## Six-task oracle verification

```bash
pnpm exec playwright install chromium
node dist/src/cli/main.js validate --suite suites/baseline.json
pnpm typecheck
pnpm test
```

Browser installation is an explicit preparation operation, never performed by a
run or test. The archive fixture needs Node SQLite, the pinned Playwright package,
matching Chromium and its Linux system libraries, and permission to bind localhost.
`validate` executes all selected source references and broken starters through the
common process executor. Focused tests also reject targeted defects. Worker tests
kill and restart real processes; archive tests exercise SQLite, HTTP and Chromium.
No candidate function is imported into the evaluator process.

## Plans and real adapters

The [Aider polyglot imports](benchmarks/aider-polyglot/README.md) provide two
web-sourced tasks: `aider-vlq` (26 upstream tests) and `aider-forth` (49 tests).
Pinned source hashes, MIT notices, reference solutions, and the mechanical test
adaptation are retained. Add these task IDs to a suite profile to compare the
three adapters. This hidden-test adaptation is distinct from Aider's official
feedback workflow; a small local pilot is not an official leaderboard score.

Real participants require Git as well as their adapter runtime. Preparation
creates a committed Git baseline in each owned fixture workspace before launch.

The baseline profiles select the 3/18/90 launch cohorts but deliberately omit
model/runtime configuration. They will not produce runnable paid plans until you
supply it. Make a JSON suite with a named profile, for example:

```json
{
  "id": "local-smoke",
  "profiles": {
    "development": {
      "taskIds": ["pagination-simple"],
      "modes": ["codex-raw"],
      "repetitions": 1,
      "settings": {
        "profile": "local-development",
        "model": "YOUR_RESOLVED_MODEL",
        "reasoningEffort": "medium",
        "executable": "/opt/codex/bin/codex"
      }
    }
  }
}
```

```bash
node dist/src/cli/main.js plan --suite /tmp/suite.json --profile development --output /tmp/eval-plan
# Explicit execution; this may use a paid provider:
node dist/src/cli/main.js run --plan /tmp/eval-plan/experiment.lock.json --results-root /tmp/eval-results
```

`plan` performs non-generative capability checks and locks the randomized matrix,
seeds, task/oracle trees (including supporting oracle files), implementation
source, schemas, dependency lock, settings and capability reports. `run` rejects
drift. Model identifiers are supplied explicitly; a provider may not offer an
immutable model snapshot. Local development is **ineligible for controlled
comparisons** and does not hide the host filesystem from participants.

For `minion-single` or `minion-graph`, supply absolute `appRoot` and
`codexExecutable` in settings. Use `modeSettings` to override settings by adapter
ID in a mixed profile. The controller creates fresh Minions/Codex state, installs
a delegation-disabling wrapper, starts a dedicated server per run, assigns its
endpoint, persists a detached supervisor, reconnects through current app commands,
and shuts the server down after evidence collection. Do not supply an endpoint
for an existing user instance. The external application must already be built and
have its runtime dependencies installed. Server startup is included in execution
time. API-key authentication may be supplied through the process environment;
existing user app databases and Codex state are not reused.

For Docker, set `settings.isolation` to `docker` and a profile `imageDigest` to
`repository@sha256:<64 hex>` or a local `sha256:<64 hex>` image ID. Prepare images
before planning: the runner never pulls. An image must contain Node and the
selected adapter runtime; Minions images also need the prepared app at `appRoot`
and Codex at `codexExecutable`. Browser images must have pinned Playwright under
`/opt/evals-runtime/node_modules` and matching Chromium/system dependencies;
preparation probes them before launch and graders use that trusted tooling. Commands and protocol requests enter the owned
container with `docker exec`; no host port is published. Only `networkPolicy:
"none"` is implemented. `declared_only` is explicitly rejected. Consequently,
networked-provider **controlled runs require an egress-policy implementation**;
local provider development and credential-free container probes remain usable.

## Extension routes

- [Core contracts and registry](src/core/contracts.ts): versioned adapters,
  isolation backends, graders and result records.
- [Adapter factories](src/adapters/factory.ts): register an executable factory;
  unknown IDs fail before launch. See [adapter protocols](src/adapters/README.md).
- [Fixture contract](src/graders/fixture-api.ts): add a task manifest/prompt,
  editable `starter/`, and async `build(seed)` returning allowlisted files.
  Put reference source and `gradeFiles({execute, seed})` only in `ground-truth/`.
- [Common executor](src/graders/executor.ts): bounded local/Docker subprocess
  execution. [CLI operations](src/cli/operations.ts) join preparation and grading.
- [Report registry](src/reports/registry.ts) and [shared aggregation](src/reports/aggregation.ts):
  extend offline views without changing lifecycle scheduling.

## Evidence and limitations

Results contain run/cell/task/mode/repetition identities, handles, deadlines,
raw and normalized usage ledgers, participant trees, graph observations when
available, immutable submission manifests/files, patches, grades and result
records. Analysis revisions contain `summary.json`, `results.csv`, and
`report.html`. Missing usage remains unknown; failed and missing cells remain
visible with explicit denominators. Generated data belongs outside the checkout.

The local backend is an operational development harness, not a security boundary.
Token enforcement occurs at observed usage boundaries and can overshoot. Graph
structure checks establish observed node count/completion, not subjective node
quality. Current app protocols do not attest a dedicated instance identity or
expose every treatment setting; live-provider calibration is still required
before comparative claims. Docker and browser checks require host permissions;
tests do not silently skip localhost failures. The opt-in Docker smoke is:

```bash
AGENT_EVALS_DOCKER_TEST=1 AGENT_EVALS_DOCKER_IMAGE=node:22-alpine pnpm exec vitest run --config tests/support/vitest.config.ts tests/lifecycle/docker-live.test.ts
```

Use an already installed image (or its digest). No benchmark performance results
are supplied or implied. See [SPEC.md](SPEC.md) and the
[acceptance checklist](docs/implementation-acceptance.md) for the full requirements.
