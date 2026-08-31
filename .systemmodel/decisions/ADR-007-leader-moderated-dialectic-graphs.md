---
id: decision.leader_moderated_dialectic_graphs
type: decision
title: Compile difficult dialectics into Leader-moderated execution graphs
status: accepted
summary: Treat a dialectic as a bounded static specialization of the canonical execution graph: preserve separate durable attempts while resuming one cache-stable provider thread per participant, maximize epistemic and runtime diversity across participants, and return periodic structured synthesis to the accountable Leader through revision-fenced gates.
evidence: [ server/dialectic/graph-plan.ts, shared/task-graph-contracts.ts, server/task-graph/validation.ts, server/task-graph/dispatch-context.ts, server/task-graph/planning-runtime.ts, server/task-graph/planning-tools.ts, server/work-item-service-sqlite.ts ]
---
# Compile difficult dialectics into Leader-moderated execution graphs

Dialectics are a primary reasoning option for genuinely difficult, consequential, or ambiguous problems where sustained opposition is likely to improve the outcome. They are not mandatory ceremony for routine or directly verifiable work.

The p13 dialectic authoring specialization expands to ordinary immutable graph nodes and edges. Two participants receive materially different epistemic roles and different executor tiers by default; callers may select different compatible harnesses or exact models. A neutral synthesizer periodically produces a structured report with goal distance, agreements, disagreements, unresolved questions, a candidate outcome, and a continue, reshape, or stop recommendation.

Every participant and the synthesizer owns a separate provider-thread affinity chain. Graph attempts remain distinct durable child WorkItem runs for fencing, evidence, retries, and recovery, while each later node resumes only the most recent successful provider session from the same totally ordered chain. Harness, model, executor tier, tools, sandbox-relevant ownership, and output contracts remain stable within a chain, and the harness must support both session resume and prompt caching.

Every non-final synthesis blocks the next episode on a human gate. The runtime wakes the bound Leader with the synthesis report and exact checkpoint and revision coordinates. The Leader—not either participant or the synthesizer—decides whether to continue, revision-fence steering that reshapes the remaining subtree, or stop while preserving prior evidence.

The feature-flagged standalone Dialectic canvas node remains a compatibility surface; it is not the canonical execution authority for Leader reasoning graphs.
