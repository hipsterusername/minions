---
id: decision.worktree_isolation
type: decision
status: accepted
summary: Agent edits run in isolated git worktrees and merge through explicit approval paths.
---
# Worktree Isolation

Leaders and minions may run parallel code-editing work, so Minions isolates
agent changes in git worktrees and routes integration through approval,
merge, retry, discard, and cleanup commands.

Consequences:

- Merge code must avoid disrupting the user's main checkout.
- Approval state and merge results must be visible through bus events.
- Parallel tasks need narrow ownership boundaries to reduce conflict risk.
