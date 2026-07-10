---
id: decision.worktree_isolation
type: decision
status: accepted
summary: Agent edits run in isolated git worktrees and merge through explicit approval paths.
---
# Worktree Isolation

Agent-authored changes never mutate the shared checkout directly. Each session
that edits code runs against its own git worktree branch. Changes reach the
project branch only through explicit approval, merge, retry, force-merge, or
discard commands — the merge boundary is the single enforcement point for
review gates.

Consequences:

- Parallel agents get disjoint write sets via per-session worktrees.
- Merge/approval command paths must evaluate gates from the actual diff before
  cleanup, and emit results through the bus.
