---
id: decision.canonical_work_item_lifecycle
type: decision
title: Use canonical work items for durable user intentions
status: accepted
summary: Durable work is represented by WorkItems with surface bindings, revision-fenced lifecycle transitions, and explicit runs.
evidence: [shared/work-item-contracts.ts, server/work-item-service.ts, server/commands/work-items.ts]
---
# Use canonical work items for durable user intentions

A user intention outlives any one node or session. WorkItems own lifecycle, workflow position, bindings, current run identity, and history; surfaces project that server-owned state.

Legacy bare sessions remain for explicitly noncanonical paths, but canonical hosts reject legacy mutation and merge commands.
