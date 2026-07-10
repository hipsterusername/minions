---
id: decision.relevance_scoped_context
type: decision
status: accepted
summary: System-model context enters an agent only when a deterministic signal says it applies; flows are authored fine-grained so retrieval pulls a small, relevant footprint rather than the whole model.
---
# Relevance-Scoped Context

The system-model layer must give agents *relevant* capability/flow/constraint
context, not the entire graph. Two rules keep it that way:

1. **Relevance is computed, never assumed.** Objects enter context only when a
   scored match or glob hit says they apply. There is no unconditional "go
   query the model" prompting.
2. **Flows are narrow by construction.** Each flow models one coherent
   end-to-end path with a small `suggested_files` set and minimal cross-links.
   A task that matches a flow pulls that flow's footprint — not a mega-flow
   that unions an entire subsystem. Applicability metadata (gate/constraint
   globs) must stay well under repo-wide coverage or it carries no information.

Consequences:

- Prefer many small single-purpose flows over few broad ones.
- Constraints and gates point at their *enforcement surface*, not every file
  they conceptually touch.
- Overbreadth (globs covering >40% of tracked files) is a validation warning.
