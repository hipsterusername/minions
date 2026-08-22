---
id: decision.server_owned_execution_graphs
type: decision
title: Make the server authoritative within execution graphs
status: accepted
summary: For work a Leader chooses to place in a graph, canonical WorkItems anchor immutable topology while a leased SQLite scheduler owns graph-run admission, dispatch, recovery, and evidence transitions; direct Leader work remains outside that scope.
evidence: [ shared/task-graph-contracts.ts, server/task-graph/repository.ts, server/task-graph/scheduler.ts, server/task-graph/evidence.ts, server/task-graph/service.ts ]
---
# Make the server authoritative within execution graphs

Execution graphs extend canonical WorkItems rather than replacing them or executing mutable canvas edges. A WorkItem retains durable intent and the current primary run; a content-hashed immutable graph revision defines topology; graph runs and fresh node-attempt identities hold execution state.

Using an execution graph is a Leader choice, not a prerequisite for planning, acting, or delegating. Graph-enabled Leaders retain their direct task tools and may use them for small, exploratory, sequential, or tightly integrated work. The scheduler's authority begins only when the Leader submits work into a graph, and it applies only to that graph's nodes and attempts.

One server scheduler lease and transactional outbox govern readiness, admission, dispatch, retries, and recovery. Agent sessions report through fenced attempt identities, while artifacts and verification remain bound to their producer attempt, source snapshot, and immutable hashes.

The Graph Inspector is a derived, revisioned view. It may request fenced controls but cannot claim work, mutate topology, or synthesize missing revisions.
