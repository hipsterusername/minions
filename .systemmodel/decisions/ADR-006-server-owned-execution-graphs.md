---
id: decision.server_owned_execution_graphs
type: decision
title: Make the server authoritative within execution graphs
status: accepted
summary: Graph is always enabled as the standard canonical Leader Minion execution path; WorkItems anchor immutable topology while a leased SQLite scheduler owns graph-run admission, dispatch, recovery, and evidence transitions; direct Leader work remains outside that scope.
evidence: [ shared/task-graph-contracts.ts, server/task-graph/repository.ts, server/task-graph/scheduler.ts, server/task-graph/evidence.ts, server/task-graph/service.ts ]
---
# Make the server authoritative within execution graphs

Execution graphs extend canonical WorkItems rather than replacing them or executing mutable canvas edges. A WorkItem retains durable intent and the current primary run; a content-hashed immutable graph revision defines topology; graph runs and fresh node-attempt identities hold execution state.

Graph is always enabled for canonical Leaders and is the standard path for Minion assignments, including single-step work. Project settings cannot disable it, and saved direct-mode overrides migrate to Graph auto mode while explicit plan review is preserved. Leaders retain direct tools for their own local work and for managing existing compatibility tasks; sessions without canonical WorkItem identity retain the compatibility path because they cannot own graph runtime authority. The scheduler's authority begins only when the Leader submits work into a graph, and it applies only to that graph's nodes and attempts.

One server scheduler lease and transactional outbox govern readiness, admission, dispatch, retries, and recovery. Agent sessions report through fenced attempt identities, while artifacts and verification remain bound to their producer attempt, source snapshot, and immutable hashes.

The Graph Inspector is a derived, revisioned view. It may request fenced controls but cannot claim work, mutate topology, or synthesize missing revisions.
