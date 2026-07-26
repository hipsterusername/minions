# System Model

The system model is a small, versioned description of how a repository is
supposed to work. It organizes user-facing capabilities and flows alongside important
constraints, decisions, risks, files, tests, freshness rules, and merge review
gates. Minions uses the relevant subset to build a Work Packet and Context Pack
for a task; it does not add the whole model to every prompt.

## Organizational layer: domains and constraint scope

Every capability, flow, constraint, and risk declares exactly one `domain:
domain.x`. Domain objects live in `domains/*.yaml`, use ids matching
`domain.[a-z0-9_]+`, and require `id`, `type: domain`, `name`, `summary`, and
`keywords`. Surfaces intentionally have no domain because they are
cross-cutting. Decisions also retain their existing domain-independent shape.

Every constraint declares one of these scopes:

- `global`: injected for every retrieval or Work Packet. It has no `guards` or
  explicit `applies_to` object links and must not appear in a capability or
  flow's `constraints` list.
- `domain`: injected when a directly matched object belongs to the constraint's
  domain. It has the same no-explicit-links rule as global scope.
- `targeted`: declares a non-empty `guards` array of `capability.*` and/or
  `flow.*` ids. Guards are the authoritative tight relation.

`applies_to` remains available on constraints and risks for its existing file,
surface, and applicability behavior. On global and domain constraints, only
file applicability is meaningful; explicit capability, flow, or surface links
are rejected.

## Relational layer: tight typed links

Each flow declares exactly one `primary_capability`. The inverse `implements`
relation is derived; capabilities no longer declare `linked_flows`. A capability
may declare typed `depends_on` capability ids. Capabilities and flows may also
declare `bridges: [{ to, reason }]`, where `reason` must contain non-whitespace
text.

`primary_capability`, `depends_on`, and `guards` stay within one domain. A
cross-domain reference is valid only when the participating capability or flow
declares the matching bridge. Bridges are explicit architectural exceptions,
not general related-object lists.

Capabilities can expose `entry_points` on first-class `surface.*` objects. Each
entry point names its own files, tests, and flows, so a shared capability can
span canvas, kanban, mobile, or activity surfaces without losing provenance.
Retrieval is deliberately bounded. From directly matched objects it follows
typed adjacency (`primary_capability`/inverse `implements`, `depends_on`,
`guards`, `entry_point`, decision, risk, and evidence) for one hop within the
same domain. It crosses domains only through a declared bridge. Global
constraints and domain constraints for directly matched domains are injected
by scope rather than represented as ordinary edges. Query results include a
`why` label such as `implements`, `guards (inverse)`, `scope: global`,
`scope: domain domain.workspace`, or `bridge: <reason>`.

## When to enable it

Use the system model when a repository has architectural rules or review steps
that agents should consistently discover. Leave it off for small or exploratory
repositories where maintaining the model would cost more than it saves.

Choose the mode in **Settings → System Model**:

- **Off** does not load the model or evaluate its gates.
- **Advisory** supplies model context and shows gate findings, but does not
  prevent a merge.
- **Enforced** supplies the same context and blocks a merge while a required
  gate is pending or failed.

Enabling advisory or enforced mode is not enough by itself: the repository (or
agent worktree) must contain `.systemmodel/manifest.yaml`.

## Seed a model

For a new repository, copy `examples/system-model-starter/` to `.systemmodel/`
and adapt it, or ask a Leader to seed the model in an isolated worktree. Keep
capabilities user-facing, flows durable, and file/test references concrete.
Follow [System Model Seeding](system-model-seeding.md) for the complete workflow
and validation command. Review and merge the seed like any other code change.

## Read merge gates

When changed files match a review-gate policy, the approval card shows a chip
for that gate. Open the chip to see why it matched and its verification state:

- **Pending** means a Work Packet, reconciliation, or required verification is
  incomplete.
- **Passed** means reconciliation and recorded verifications passed.
- **Failed** means a required verification or reconciliation failed.
- **Waived** records an explicit human exception and its reason.

In advisory mode these states are informational. In enforced mode, Pending and
Failed block the merge. A reviewer can waive a gate in enforced mode only by
entering a reason; use waivers for deliberate exceptions, not routine cleanup.

## Freshness and reconciliation

Freshness compares the last change to a code-coupled model object with the last
change to its referenced code. A newer code change makes the object stale and
can require inspection, an agent action, or verification according to
`policies/freshness.yaml`. Unknown freshness is a prompt to verify, not proof
that an object is current.

Reconciliation runs against the actual worktree diff before approval. It
expands the Work Packet to newly affected capabilities, flows, and constraints;
reports matching entry points and their sibling surfaces, out-of-scope files or
missing suggested tests; and recalculates gate requirements. Resolve or
explicitly waive those findings before merging.

The minion Context Pack includes one `Entry point <surfaceId> for
<capabilityId>: files ...; tests ...` line per selected entry point and an
`Instruction <constraintId>: ...` line for each constraint instruction. These
lines obey the configured per-object and total context budgets. Required
freshness actions are copied to the Work Packet's `agentInstructions` and
rendered as `Freshness instruction: ...` lines in the same Context Pack.

`query_system_model` accepts exact `surface.*` ids and returns entry-point link
stubs in both directions: querying a capability shows its surfaces, and
querying a surface shows the capabilities available there. Work Packet create
and amendment inputs may confirm a specific `{ capabilityId, surfaceId }`
entry-point pair. Retrieval does not recursively traverse from the capability
to sibling objects beyond the one-hop boundary.

## Graph wire format

The graph contains `domain` nodes. Nodes for capabilities, flows, constraints,
and risks carry `domain`; surfaces and decisions do not. Tight edge relations
are `implements`, `depends_on`, `guards`, and `bridge`; bridge edge `summary`
is the declaration's reason. The retained relations are `decision`, `risk`,
`evidence`, and `entry_point`. The removed generic relations
`linked_flow`, `capability`, and `constraint` are invalid wire values.

## Maintenance policy (starter)

- Name an author or owning team in the repository's contribution policy and
  have that owner review structural model changes.
- Review affected model objects whenever their referenced behavior, files,
  tests, constraints, or gates change. Run model validation in CI.
- Prefer a small number of durable capabilities and flows over inventories of
  functions. Remove dead references as part of the code change that makes them
  obsolete.
- Mark replaced ADRs `superseded` and point to the replacement; mark abandoned
  decisions `deprecated`. Keep accepted ADR history rather than silently
  rewriting the decision.
