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
- `capabilities/*.yaml`
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
Repositories that have not configured a model are skipped. Use
`--require-manifest` when the presence of `.systemmodel/manifest.yaml` is
itself part of the acceptance contract.

Validation is the acceptance gate for seeding and can be used in CI. A malformed
model should be fixed in the seed worktree before approval; generated packets or
reports are not committed into `.systemmodel/`.
