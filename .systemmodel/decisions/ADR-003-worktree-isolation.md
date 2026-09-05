---
id: decision.worktree_isolation_and_approval
type: decision
title: Isolate agent changes and require explicit review
status: accepted
summary: Git change mode chooses live source-checkout edits or parent worktree isolation; isolated contributions integrate only through locked, gate-aware approval or lineage workflows.
evidence: [server/work-item-bootstrap.ts, server/work-item-child-repo.ts, server/worktree.ts, server/commands/worktree-operation-lock.ts, server/worktree-integration-service.ts]
---
# Isolate agent changes and require explicit review

Live mode edits the source checkout directly. Worktree mode isolates a parent WorkItem, while its children share the parent execution context and coordinate declared file ownership. Git placement is separate from the process sandbox and does not guarantee operating-system isolation.

For isolated contributions, worktree integration protects the project root and makes user approval a durable state machine. Only one mutation operation may run at a time, review is distinct from integration, and gates must pass or receive a valid human waiver.

Legacy approval and canonical lineage are separate command families and must not be mixed.
