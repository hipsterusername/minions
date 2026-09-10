# External execution boundary

`createExternalAdapter(config)` constructs the three real adapters. It accepts
adapter settings without importing application internals. Minions factories return
`ManagedMinionsAdapter`, which owns a separate server process per run.
`LocalCodexProcessLauncher` launches the executable directly. Both
`multi_agent` and `multi_agent_v2` are disabled at the root CLI level and checked
with `features list`; `exec --help` checks JSON and ephemeral support only.

The isolation backend supplies `run.configuration.execution`:

```ts
{ kind: 'local' | 'docker', containerName?: string,
  workdir: '/workspace', stateRoot: '/controller/run-state' }
```

`workspace.mountPath` remains the controller-visible integrated workspace mount,
which collection hashes after quiescence. `workdir` is the participant namespace
path. `stateRoot` is controller-owned, absolute, and outside that mount. Docker
launches execute `docker exec -w workdir containerName codex ...`; the backend
must create and verify that dedicated container before supplying its descriptor.
Cancellation may kill that **dedicated** container. Never reuse a container for
multiple runs. Local execution is a development path, not controlled isolation.

The detached Node supervisor persists `launch.json`, `process.json`,
`stdout.jsonl`, `stderr.log`, `stop.json`, and `exit.json` below stateRoot.
The handle points at that directory. A new launcher/adapter reads it and replays
from the beginning, skipping already ingested event sequence numbers. The
idempotency directory is claimed before spawning; uncertain state never starts
a second model process. Keep controller state private: launch metadata can
contain credential environment values. The backend owns hard wall-time/resource
limits and final process/container cleanup, including a dead supervisor.

## Dedicated Minions startup

Supply absolute `appRoot` and `codexExecutable` settings to the factory. The CLI
supplies private controller `stateRoot`; it refuses arbitrary existing endpoints.
`ManagedMinionsAdapter` uses `dedicatedInstanceRecipe` for local execution and
prepares the equivalent paths inside Docker. The recipe creates a CODEX_PATH
wrapper enforcing both native-delegation disables and launches:

```text
node --import tsx server/index.ts
```

The controller starts the prepared application with fresh `MINIONS_HOME`,
`DB_PATH`, `CODEX_HOME`, `CODEX_PATH` and an assigned port. A detached supervisor
and `instance.json` persist process and endpoint ownership. Reconnection reuses
that instance and participant handle; a failed startup becomes an explicit
interrupted/infrastructure result. Startup is inside the execution deadline.
After collection, the controller stops the server and removes its participant
container/workspace. This is never the user's ordinary app instance.

Docker uses internal loopback and `ContainerMinionsTransport`: each HTTP/WS
operation runs through `docker exec` inside the owned network namespace, without
publishing a port. The image contains the prepared application and Codex; it
never mounts the evaluator checkout. Only the workspace is participant writable.
Local mode has no equivalent security boundary and is development-only.

`WebSocketMinionsProtocolClient` remains separately exported for protocol tests
and embedding behind another controller. It bootstraps `/api/auth/token`, uses
authenticated WS commands and bearer-authenticated HTTP history, and registers
the workspace through `/api/projects`. The managed factory constructs its client
configuration from owned state; callers do not pass `recipe.client` to the CLI.

Single mode uses `create_session` with role `minion`, no armed skills, live
workspace, and Codex harness. The app's `server/agents/minion-tool-policy.ts`
excludes delegation/graph tools; `server/harness/codex/index.ts` filters bridge
definitions by the exact role allowlist. The CODEX_PATH wrapper disables native
subagents in every provider invocation, including continuations.

Graph mode uses `create_work_item` and revision-fenced `start_work_item_run`
with `orchestrationMode: auto`. The participant authors the graph; no benchmark
DAG is injected. App planning policy must permit automatic admission. An idle
leader with no two-node completed graph fails adherence/completion checks;
it is never counted as a successful graph execution. Plans requiring policy
approval remain subject to the external deadline. The client never bypasses
server graph admission or approves policy-gated work on the user's behalf.

Discovery combines `list_sessions`, paginated `get_work_item_runs`, graph
snapshots, `list_task_graph_attempts`, and `sync_session`. It includes earlier
primaries, retries, failed children, and descendants. Full HTTP history follows
exclusive cursors and downloads archived exact events. `stop_session` is
fire-and-forget; cancellation verifies state with subsequent syncs and cancels
active graphs with their observed revision. Collection uses the integrated live
workspace, rather than selecting an arbitrary child's worktree.

## Accounting and validation

Raw observations remain in event payloads; `payload.usage` carries the normalized
run aggregate expected by the runner. Minions' authoritative session totals
reconstruct input as ordinary + cache read + cache creation. Raw Codex input is
already inclusive. The ledger replaces source revisions and reconciles session
coverage intervals rather than summing cumulative snapshots. Unknown costs are
null, explicit zero costs are retained, and missing participants are partial.
Historical per-turn observations remain available for audit; they are not added
a second time to session totals. Cancelled/in-flight usage is partial.

Credential-free tests in `tests/adapters` use a real local RFC6455/HTTP server
and actual fake executables through the detached launcher. Run:

```sh
pnpm --dir evals exec vitest run --config tests/support/vitest.config.ts tests/adapters src/adapters src/telemetry
pnpm --dir evals typecheck
```

No tests call providers. A sandbox that forbids localhost listening needs these
transport tests run by its host controller; denial is not a passing transport
result. Controlled runs additionally require backend container/port cleanup
verification. The generic app wire protocol has no dedicated-instance identity
attestation: the controller must bind the endpoint to its owned process and
CODEX_PATH recipe. A minimal future general capability response could expose
instance ID, state-root digest, effective harness feature controls and shutdown
ownership; none is assumed or invented by this client.
