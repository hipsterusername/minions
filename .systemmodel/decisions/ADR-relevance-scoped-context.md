---
id: decision.relevance_scoped_context
type: decision
status: accepted
summary: System-model context enters an agent only when a deterministic signal says it applies; flows represent durable user journeys with deliberately narrow evidence footprints.
---
# Relevance-Scoped Context

The system-model layer must give agents *relevant* capability/flow/constraint
context, not the entire graph. Two rules keep it that way:

1. **Relevance is computed, never assumed.** Objects enter context only when a
   scored match or glob hit says they apply. There is no unconditional "go
   query the model" prompting.
2. **Flows are durable journeys with narrow evidence.** Each flow models one
   user- or agent-recognizable outcome across a small number of steps. Its
   `suggested_files` and `suggested_tests` identify the narrowest useful
   implementation evidence instead of enumerating every internal function.
   Applicability metadata (gate/constraint globs) must stay well under
   repo-wide coverage or it carries no information.

Consequences:

- Prefer stable end-to-end journeys over tool-, command-, or function-shaped flows.
- Keep retrieval precise through narrow evidence lists and scored matching, not by fragmenting a journey.
- Constraints and gates point at their *enforcement surface*, not every file
  they conceptually touch.
- Overbreadth (globs covering >40% of tracked files) is a validation warning.
