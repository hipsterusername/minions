---
id: decision.standalone_evaluation_boundary
type: decision
title: Keep evaluation execution outside the application runtime
status: accepted
summary: Run evaluation lifecycle, adapters, graders, usage normalization, and reports from the independently installable evals package, using only a dedicated Minions protocol client when an app participant is required.
evidence: [ evals/package.json, evals/src/cli/main.ts, evals/src/adapters/factory.ts, evals/src/adapters/minions-client.ts, evals/src/graders/executor.ts, evals/src/reports/registry.ts, evals/tests/architecture/no-core-runtime-imports.test.ts ]
---
# Keep evaluation execution outside the application runtime

The evaluator measures a system under test and must not become one of the
application's runtime services. `evals/` therefore owns its package manifest,
CLI, lifecycle store, adapters, graders, usage ledger, and offline reports.

Minions conditions cross the boundary through an adapter-created, dedicated
server process and its HTTP/WebSocket protocol. The evaluator never imports
server, shared, or UI implementation modules, and it does not attach to a user
instance or database. Raw Codex is likewise launched by an external adapter.

This boundary keeps controlled experiment setup, frozen submissions, hidden
grading, and visualization available with the canvas closed. It also means
fixture demos and host checks establish operational behavior only; they are not
provider-backed benchmark or product-observability claims.
