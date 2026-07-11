# System Model

The system model is a small, versioned description of how a repository is
supposed to work. It connects user-facing capabilities and flows to important
constraints, decisions, risks, files, tests, freshness rules, and merge review
gates. Minions uses the relevant subset to build a Work Packet and Context Pack
for a task; it does not add the whole model to every prompt.

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
reports out-of-scope files or missing suggested tests; and recalculates gate
requirements. Resolve or explicitly waive those findings before merging.

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

