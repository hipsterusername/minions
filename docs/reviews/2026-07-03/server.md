# Minions Server Architecture Review

## A. How The Subsystem Actually Works


The dominant runtime object is `SessionHost`. A host owns one logical session's mutable state: status, model, harness name, abort controller, current event stream/control handle, task/render/reasoning state, worktree reference, wait timer, event buffer, and proactive compaction state. `SessionRegistry.start()` creates or finds a host and fire-and-forgets `host.start()`. `SessionHost.start()` sets the host to running, resolves the agent type, ensures or inherits a worktree, builds the agent context, asks the agent type for tool groups, registers those tools with the selected harness, starts the harness, and drains normalized events into the host buffer, persistence, bus, task lifecycle, render state, and completion hooks. `terminateSessionHost()` handles stop/close/remove/abort by clearing waits, aborting or closing the harness control, marking the host stopped, emitting status, applying minion lifecycle, and invoking role-specific termination.


Worktree isolation is centered on `WorktreeInfo`. Leaders can get a branch under `.canvas-worktrees/<sessionKey>`. The approval path uses MCP `request_approval` to capture diff state and expose UI actions. WebSocket commands such as `approve_changes`, `force_merge`, `theirs_merge`, and `retry_merge` call a shared `runMergeFlow()`, which aborts the running session, calls `mergeAndCleanup()`, updates session/task state, emits approval and completion events, and clears the host worktree on success. The merge implementation is intentionally safer than a normal checkout merge: it merges the target branch into the isolated canvas branch, then atomically advances the target ref with `git update-ref <new> <old>`, and only hard-resets the main worktree after checking it is clean.



The system is optimized for one server process, one in-memory truth, a small number of active sessions, and trusted local/Tailscale users. The architecture is readable and well factored compared with a monolithic switch-loop server, but it does not yet have strong command idempotency, per-session operation locks, durable queues/timers, bounded event storage, or multi-process coordination.

## B. Strengths Worth Preserving

- The composition root is meaningfully thinner than a classic application god-file. `server/index.ts` mostly wires dependencies, routes, registries, and graceful process handlers rather than containing command/lifecycle logic.
- The WebSocket command table is a good extension point. `COMMAND_TABLE` is typed as the single command registry and the handlers are small, testable modules.
- The bus envelope model gives the client a consistent event shape and creates a single outbound broadcast chokepoint. The architecture test forbidding direct `broadcast()` calls is the right kind of fitness function.
- `SessionHost` centralizes lifecycle ownership. It is stateful, but the state has a named home rather than being spread across commands and SDK adapters.
- The worktree merge strategy is materially safer than checking out or merging directly in the user's main worktree. The `update-ref` old-SHA guard is a strong protection against overwriting a branch advanced by another actor.
- The task lifecycle reducer is comparatively disciplined: the reducer is pure, terminal states are guarded, and persistence/broadcast are wrapped in `applyLifecycleEvent()`.
- The MCP bridge has good security instincts: loopback binding, per-session bearer tokens, narrow URL-safe identifiers, constant-time token compare, and explicit disposal.

## C. Findings

### 1. High: Closing or removing a leader marks children cancelled but may leave minion sessions running

Evidence: `closeSession` passes termination deps without `terminateSession` at `server/commands/close-session.ts:16-19`; `removeSession` does the same at `server/commands/remove-session.ts:24-27`. `terminateSessionHost()` only includes `terminateSession` in the agent context when the supplied deps contain it at `server/session-host-terminate.ts:80-102`. Leader teardown relies on that optional callback to abort each minion at `server/agents/leader-teardown.ts:26-40`.

Why it matters: `cancelChildrenOnLeaderTeardown()` will still mark non-terminal child tasks as `parent_terminated`, but `ctx.terminateSession?.(...)` becomes a no-op. The UI/task state can say the child is cancelled while the minion process continues spending tokens and potentially mutating the inherited worktree.

Recommendation: Do not let command handlers hand-roll partial termination deps. Add a `registry.terminate(sessionKey, reason)` method that always uses the canonical deps from `index.ts`, including `terminateSession`, `wakeWaitingLeaderIfAllChildrenTerminal`, and task-state iteration. Add a regression test: close/remove a leader with a running minion and assert the minion host is aborted/stopped, not just the task record.

### 2. High: Merge/approval commands are not serialized per session

Evidence: `approve_changes`, `force_merge`, `theirs_merge`, and `retry_merge` all check `host.worktree` and immediately call `runMergeFlow()` with no in-flight guard (`server/commands/approve-changes.ts:12-20`, `server/commands/force-merge.ts:9-25`, `server/commands/theirs-merge.ts:9-17`, `server/commands/retry-merge.ts:9-17`). `runMergeFlow()` starts async `mergeAndCleanup()` without setting a merge state or lock at `server/commands/helpers.ts:153-218`.

Why it matters: Two browser tabs, double-clicks, or reconnect/retry behavior can start two merges against the same branch/worktree. The first may auto-commit, update the target ref, and remove the worktree while the second is still inspecting or mutating it. Results become non-deterministic and can surface as confusing failures after a successful merge.

Recommendation: Add a per-session operation lock for destructive worktree actions (`approval/merge/discard/remove`). Store an explicit `worktreeOperation` or `approval.state = merging` field and return the existing operation result for duplicate `requestId`s. Cover duplicate `approve_changes` from two sockets in a contract or command test.

### 3. High: Successful merges can be reported as failures if cleanup fails

Evidence: `mergeAndCleanup()` calls `mergeWorktree()` and then, on success, awaits `removeWorktree()` at `server/worktree-merge.ts:293-299`. If removal throws, the function rejects instead of returning the already-successful merge result. Command handlers catch that as a generic control error at `server/commands/helpers.ts:216-218` or `server/commands/merge-worktree.ts:42-44`, and the host is not cleared or persisted as merged.

Why it matters: The target branch may already have been advanced by `update-ref` (`server/worktree-merge.ts:219-225`), but the UI can show a failed merge with the same active worktree still attached. A retry may then operate on a branch that was already merged, or users may manually intervene based on a false failure.

Recommendation: Split merge and cleanup results. Return `{ merge: success, cleanup: failed }` when target ref update succeeded but worktree removal failed; persist the session as merged with `worktree.lifecycle = "cleanup_failed"` and surface a cleanup-specific remediation. Only keep approval unresolved when the merge itself failed.

### 4. High: WebSocket dispatch has no top-level exception boundary

Evidence: `attachConnectionListeners()` calls `deps.dispatch(validation.cmd, ws)` directly at `server/ws-connection.ts:59-66`. `dispatchCommand()` directly invokes the handler at `server/commands/index.ts:120-134`. There is no try/catch around handler lookup/invocation.

Why it matters: Most command handlers are written defensively, but any synchronous throw from validation gaps, path handling, registry/harness lookup, or future command code can escape the WebSocket message callback. In Node, an uncaught exception in an event handler can crash the server process.

Recommendation: Put a narrow exception boundary in `dispatchCommand()` or the WS message handler. Convert sync throws into a session-scoped `control_response` when possible or a global `error` otherwise, and log the full stack server-side. Add a command-table test with a deliberately throwing handler.

### 5. Medium: Persistence writes that represent one logical mutation are not transactional

Evidence: `persistTaskState()` deletes stale task rows, upserts current rows, and updates session approval as separate statements at `server/session-persist.ts:274-292`. `removePersistedSession()` deletes session, render state, reasoning state, event log, and task records as separate statements at `server/session-persist.ts:187-200`. `ensureTaskRecordsCompositePk()` rewrites `task_records` through multiple DDL/DML statements at `server/db.ts:247-272`.

Why it matters: A process crash or SQLite error midway can leave contradictory state: approval updated without task rows, task rows without the session row, render/reasoning state orphaned, or a half-applied schema rewrite. Hydration already tolerates some malformed state, but inconsistent state creates user-visible recovery ambiguity.


### 6. Medium: Event log is append-only and only capped on read

Evidence: every buffered event is persisted through `SessionHost.bufferEvent()` at `server/session-host.ts:195-201`; `persistEvent()` appends to `event_log` at `server/session-persist.ts:213-220`; hydration reads only the recent tail at `server/session-persist.ts:247-266`; the schema creates `event_log` without a retention mechanism at `server/db.ts:135-143`.

Why it matters: Long-lived sessions and streaming/partial events can grow `event_log` without bound. Reads are capped, but disk usage and SQLite write/index cost are not. This is likely one of the first scaling limits as sessions grow.

Recommendation: Add event retention on write or periodic maintenance: keep the latest `MAX_BUFFERED_EVENTS` per session, or enforce a time/size cap. Add an index suitable for pruning (`session_key, id`) and a test that appending beyond the cap deletes older rows.

### 7. Medium: Bus fan-out is simple but has no backpressure or send-error isolation

Evidence: `broadcast()` JSON-serializes once and calls `client.send(msg)` for every open client at `server/bus.ts:44-52`. The file explicitly states all envelopes are sent to every socket and backpressure is a non-goal at `server/bus.ts:11-16`. In-process subscribers are protected by try/catch at `server/bus.ts:128-139`, but WebSocket sends are not.

Why it matters: One slow or problematic client can build memory via `bufferedAmount`; a rare send throw can interrupt the bus emit path; and event volume scales as `events * open_tabs`, not as subscribed topics. Two or more browser tabs multiply traffic and receive every session's events.

Recommendation: Add per-client send error handling and a high-water mark policy. Then introduce server-side topic subscriptions if event volume grows: connection announces topics, bus fans only to interested sockets, and global events remain explicit.

### 8. Medium: Harness abstraction still leaks provider-specific behavior

Evidence: `SessionHost` imports concrete harness modules for side-effect registration at `server/session-host.ts:15-18`. The harness registry is mutable module state at `server/harness/index.ts:15-23`. Project defaults and model compatibility are hard-coded for Claude/Codex at `server/project-store.ts:51-62` and `server/project-store.ts:270-276`. Codex advertises MCP capability but drops external MCP servers by design at `server/harness/codex/index.ts:198-207`.

Why it matters: Adding a fourth harness is more than implementing `AgentHarness`: the developer must remember side-effect import locations, update defaults/model compatibility, decide external MCP behavior, and audit prompt/tool assumptions. This is a real seam for simple starts, but not yet a clean provider plugin boundary.

Recommendation: Move harness registration into the composition root or a generated registry module, and add a `HarnessDescriptor` that owns defaults, model compatibility, external MCP support, and UI-visible capabilities. Split `mcp: true` into internal-tool MCP and external-user-MCP support so Codex's current limitation is not ambiguous.





### 10. Medium: Remove-session can orphan worktrees after deleting server state

Evidence: `removeSession` starts `removeWorktree(...).catch(...)` asynchronously at `server/commands/remove-session.ts:29-35`, sets `host.worktree = null` at `server/commands/remove-session.ts:36`, deletes the host from the registry at `server/commands/remove-session.ts:39`, and removes persisted session state at `server/commands/remove-session.ts:40`.

Why it matters: If worktree removal fails, the only durable references have already been erased. The server logs a warning but loses the session/worktree metadata needed to retry cleanup from the UI or boot hydration.

Recommendation: Treat worktree cleanup as a state transition. Mark lifecycle `removing`, attempt removal, then mark `cleaned` or `cleanup_failed`. Keep enough persisted metadata to retry cleanup and expose leaked worktrees in a maintenance command.

### 11. Low: Schema migration is pragmatic but lacks an explicit versioned migration story

Evidence: `initDb()` runs `CREATE TABLE IF NOT EXISTS` and a series of `ensureColumn()` calls at `server/db.ts:17-219`; `ensureColumn()` introspects `PRAGMA table_info` and runs `ALTER TABLE` at `server/db.ts:280-288`; the event-log schema migration deletes old rows based on detecting a missing column at `server/db.ts:206-217`.

Why it matters: This is acceptable while the app is local and schemas are simple, but it becomes difficult to reason about ordered migrations, rollback, destructive changes, and data repair. The task-record migration already has a hard failure path on duplicate rows (`server/db.ts:232-245`).

Recommendation: Introduce `PRAGMA user_version` or a `schema_migrations` table and move migrations into ordered, transactional steps. Keep `ensureColumn()` only for defensive repair or tests.

### 12. Low: The auth token is process-local and restart-invalidates clients

Evidence: `AUTH_TOKEN` is generated randomly at process startup at `server/index.ts:40-42`; REST and WebSocket auth compare against that in-memory value at `server/index.ts:85-94` and `server/index.ts:120-138`.

Why it matters: This is reasonable for a local app bootstrap token, but it means restart is a global client logout and prevents multi-process server instances from sharing auth. It also couples `/api/auth/token` availability to local/Tailscale origin checks.

Recommendation: If remote/mobile use becomes important, persist a revocable auth secret or move to a small token store with rotation. For local-only use, document the restart behavior and make client re-bootstrap robust.

## D. Top 5 Recommendations Ranked By Impact/Effort

1. High impact / low-medium effort: Centralize termination through `SessionRegistry.terminate()` and fix leader close/remove child abortion. This closes a real resource-leak/correctness bug with a narrow API change and focused tests.

2. High impact / medium effort: Add per-session locks and idempotency for destructive worktree commands. This protects the approval path from two-tab/double-click races and makes retries predictable.

3. High impact / medium effort: Split merge success from cleanup success. This prevents false merge failures after the target branch has already advanced and gives users a recoverable cleanup path.

4. Medium-high impact / low effort: Add top-level exception handling around WebSocket command dispatch and bus sends. This improves operational resilience without changing the architecture.

5. Medium impact / medium effort: Transactionalize persistence write groups and add event-log retention. These two changes address the most likely long-term data consistency and growth issues while preserving the current SQLite/write-through model.
