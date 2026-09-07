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

Every Leader executes as a durable WorkItem run. Canvas, activity, and mobile create work items before launch; the server rejects identity-free Leader starts and identity replacement, and migrates historical Leaders before hydration. Missing identity never selects a compatibility planning profile. Bare sessions remain available to other roles; canonical hosts reject legacy mutation and merge commands.
