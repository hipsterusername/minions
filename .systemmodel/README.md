# Authoring relevant task context

Capabilities describe user powers. Surfaces describe where those powers are
available. Put launch, conversation, and approval entry points on those
capabilities; a mobile surface is not itself a second copy of every capability.

Search returns compact cards. Read selected facets to open relevant detail, and
explicitly expand one-hop dependencies, bridges, or inverse relationships. Queries
never create packets or record exposure as use. Responses have bounded, lossless
continuation; see [the retrieval contract](../docs/progressive-system-model-retrieval.md).
Compiled Work Packets use a separate scope:

- Explicitly selected behavior and its primary capability remain in context.
- A selected capability contributes its implementing flows; when task files are
  supplied, only matching flows are added. Selecting a flow does not add siblings.
- Dependencies and bridges remain discoverable without expanding work ownership.
- Packets persist their selected objects and declared paths separately from
  derived scope, so repeated amendments do not widen context automatically.
- An explicit surface selects its entry points. Otherwise task files select
  matching entry points, or a selected flow selects the entries that expose it.
- Explicit constraint references and guards remain authoritative. File matches
  add applicable constraints across domains. Global and domain constraints with
  file applicability are included when those files match; those without files
  apply throughout their declared scope. Keep such universal guidance short.

Provide concrete task files or owned paths whenever known. These drive file-based
packet applicability and review gates; suggested implementation and test paths
are navigation hints. Gate trigger dimensions use OR semantics. Subsystem gates
must omit risk-only triggers unless they intentionally apply across subsystems.

`context-budgets.yaml` uses the `context_budgets` wrapper with
`leader_prompt_addendum`, `minion_context_pack`, and `per_object_summary`.
Budgets are estimated tokens (four characters per token). Context presents task
intent, freshness actions, open signals, coverage, selected behavior and entry
points before broader evidence and file hints. Applicable constraints are ranked
by severity. Omission markers identify context that needs another query.

Freshness policy classes default to each capability or flow's `freshness.class`
(`code_coupled` when absent). Code-coupled guidance uses source timestamps;
policy and informational guidance use configured semantic-review actions rather
than inferring truth from code timestamps. Freshness never proves a model claim.

Run `pnpm system-model:validate -- --strict` after edits. It validates schema,
object links, file/test anchors, decision evidence and gate test targets, including
new untracked files. `server/system-model/repository-context.test.ts` checks the
actual model's budgets, retrieval, relevant gates, and context boundaries.
