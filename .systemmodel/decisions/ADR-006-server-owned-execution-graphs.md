---
id: decision.server_owned_execution_graphs
type: decision
title: Make the server the execution graph authority
status: accepted
summary: Canonical WorkItems anchor immutable graph topology while a leased SQLite scheduler owns graph runs, attempt admission, dispatch, recovery, and evidence transitions.
evidence: [ shared/task-graph-contracts.ts, server/task-graph/repository.ts, server/task-graph/scheduler.ts, server/task-graph/evidence.ts, server/task-graph/service.ts ]
---
# Make the server the execution graph authority

Execution graphs extend canonical WorkItems rather than replacing them or executing mutable canvas edges. A WorkItem retains durable intent and the current primary run; a content-hashed immutable graph revision defines topology; graph runs and fresh node-attempt identities hold execution state.

One server scheduler lease and transactional outbox govern readiness, admission, dispatch, retries, and recovery. Agent sessions report through fenced attempt identities, while artifacts and verification remain bound to their producer attempt, source snapshot, and immutable hashes.

The Graph Inspector is a derived, revisioned view. It may request fenced controls but cannot claim work, mutate topology, or synthesize missing revisions.
