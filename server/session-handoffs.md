# Session context handoffs

Provider history is an optimization, not the only continuity record.

- A Leader archives user instructions in `session_user_directives`, ordered by
  `id`. Consecutive duplicates are suppressed; a later instruction that reinstates
  an earlier choice remains in chronological order. Generated wake messages and
  checkpoint envelopes are not archived as user instructions.
- `session_continuity` stores the bounded active instruction set, latest complete
  connected-source snapshot, images, selected skills, and skill variables. Host
  snapshots and continuity state commit together. Hydration restores this state
  before automatic wakes; older canonical rows fall back to their run config.
- Checkpoints retain the objective, user corrections, semantic decisions and
  rationale, dead ends, open questions, next steps, current task state, artifact
  references, verification, and recent user/assistant/tool evidence. Current task
  records remain authoritative. Older decisions and evidence are explicitly
  historical, and later user corrections supersede earlier conflicting requests.
- A compatible provider ID resumes normally. Missing IDs, requested provider
  changes, and readiness-induced provider changes use a server-owned handoff
  containing prior-run evidence, report, directives, and source references.
- Fresh provider threads receive the source snapshot and images before execution,
  even without a connected browser. A committed checkpoint also invalidates the
  browser's source delivery ledger, including when discovered through sync.
- UI-created continuations pin user instructions separately from their rolling
  assistant history; the server adopts the pinned instructions durably.

## Budgets and evidence retrieval

The active instruction set is bounded to approximately 12,000 characters,
reserving the first request independently of recent corrections. Checkpoint text
is limited to 24,000 characters through section budgets; connected-source excerpts
have a separate 24,000-character budget. Section delimiters and omission markers
survive truncation. Images retain the normal attachment validation contract.

Full user instructions and the latest full source snapshot remain in the server
SQLite database. Handoffs identify its path, table names and session key. Older
iterations can be followed through `sessions.previous_run_key`. The instruction
journal can be read with:

```sql
SELECT text FROM session_user_directives WHERE session_key = ? ORDER BY id;
SELECT snapshot_json FROM session_continuity WHERE session_key = ?;
```

An automatic forced reset may lack a fresh model-authored summary. Its handoff
reports that limitation and includes durable state and recent evidence. The
checkpoint recommendation and tool request ask the model to supply a structured
summary at a safe boundary, including exact artifact paths and verification.

These records preserve newly received context. They cannot reconstruct content
already lost by an earlier version or omitted before it reached the server.

Regression coverage: `server/session-handoff.test.ts`,
`server/session-launch.test.ts`, and `src/nodes/leader/session-context.test.ts`.
