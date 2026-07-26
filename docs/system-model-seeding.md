# System Model Seeding

Seeding creates the first repo-side `.systemmodel/` tree for a project. It is
a normal agent worktree change: agents inspect the repo, draft model files, run
validation, and the human reviews the diff through the existing approval flow.

The model captures intent above the code: user-facing capabilities, important
flows, architectural constraints, decisions, risks, and policies. Capabilities
must describe powers users rely on, not implementation modules.

## What Gets Seeded

The repo model lives under `.systemmodel/`:

- `manifest.yaml`
- `domains/*.yaml`
- `capabilities/*.yaml`
- `surfaces/*.yaml`
- `flows/*.yaml`
- `constraints/*.yaml`
- `decisions/ADR-*.md`
- `risks.yaml`
- `policies/freshness.yaml`
- `policies/review-gates.yaml`
- `policies/context-budgets.yaml`

The seeding minion should use the built-in `system-model-authoring` skill. That
skill summarizes the schemas from `shared/system-model/`, the bloat guard rules,
and the rule that every object needs concrete suggested files or policy globs.

Start with a small categorical domain vocabulary. Every capability, flow,
constraint, and risk must name exactly one existing `domain.*`; surfaces do not
name domains. A domain file contains `id`, `type: domain`, `name`, `summary`,
and `keywords`.

Each flow has one required `primary_capability`; never add a reverse
`linked_flows` list to a capability. Use capability `depends_on` only for real
runtime or product dependencies. A constraint must choose `scope: global |
domain | targeted`: global and domain scopes have no guards or explicit object
links, while targeted constraints require non-empty `guards` containing flow or
capability ids. Do not list global or domain constraints in capability or flow
`constraints` arrays.

Keep typed relations inside a domain. When a `primary_capability`, `depends_on`,
or `guards` relationship must cross a domain boundary, add a matching `bridges`
entry to the participating capability or flow:

```yaml
bridges:
  - to: capability.identity
    reason: Workspace opening delegates authentication to identity ownership.
```

Bridge reasons are mandatory and must explain why the exception exists. Do not
use bridges as loose "related to" links.

Define a `surface.*` object for each durable product surface, then add
`entry_points` to capabilities with the surface id and surface-specific
`files`, `tests`, and `flows`. The same surface may host many capabilities, but
a capability may have only one entry point for a given surface. Selecting any
surface or entry-point flow expands to the capability and all sibling entry
points, so keep those links intentional and validate every reference.
Constraints and risks can include `applies_to.surfaces`; use that for rules
shared by every capability entry point on a product surface.

## How To Run It

1. Enable `ProjectSettings.systemModel` for the project when the feature is in
   use, and run the leader with worktree isolation on.
2. Ask the leader to seed the system model for the repo.
3. Delegate read-heavy exploration by subsystem, with narrow owned paths under
   `.systemmodel/**`.
4. Review the resulting worktree diff as the model.
5. Merge through the normal approval card after validation passes.

For this repo, the validation command is:

```bash
pnpm system-model:validate
```

## Validation Gate

`pnpm system-model:validate` loads `.systemmodel/manifest.yaml`, parses YAML and
ADR front matter, validates object schemas, and checks references between
capabilities, flows, constraints, decisions, risks, and review gates.
It also validates surfaces, entry-point flow references, and duplicate
capability/surface entry-point pairs. Strict validation also rejects missing
domains, empty targeted guards, guards or explicit object applicability on
global/domain constraints, redundant global/domain constraint references, empty
bridge reasons, and cross-domain typed relations without a matching bridge.
Repositories that have not configured a model are skipped. Use
`--require-manifest` when the presence of `.systemmodel/manifest.yaml` is
itself part of the acceptance contract.

Validation is the acceptance gate for seeding and can be used in CI. A malformed
model should be fixed in the seed worktree before approval; generated packets or
reports are not committed into `.systemmodel/`.
