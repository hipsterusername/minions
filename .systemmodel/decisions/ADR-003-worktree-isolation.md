---
id: decision.worktree_isolation_and_approval
type: decision
title: Isolate agent changes and require explicit review
status: accepted
summary: Agent code changes occur in isolated worktrees and merge only through locked, gate-aware approval or lineage workflows.
evidence: [server/worktree.ts, server/commands/worktree-operation-lock.ts, server/worktree-integration-service.ts]
---
# Isolate agent changes and require explicit review

Worktree isolation protects the project root and makes user approval a durable state machine. Only one mutation operation may run at a time, review is distinct from integration, and gates must pass or receive a valid human waiver.

Legacy approval and canonical lineage are separate command families and must not be mixed.
