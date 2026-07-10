# Contributing to Minions

Minions is under active development. Before starting a substantial change,
open an issue or discussion describing the problem and proposed direction so
work does not proceed on conflicting assumptions.

## Development setup

You need Node.js 22 or newer, pnpm, and git. Install dependencies with:

```bash
pnpm install
```

The current development workflow and optional Tailscale setup are documented
in [README.md](./README.md). Project-specific testing and architecture rules
live in [docs/testing-strategy.md](./docs/testing-strategy.md) and
[CLAUDE.md](./CLAUDE.md).

## Before submitting a pull request

Run the same gate used by CI:

```bash
pnpm verify
```

Behavior changes must include tests. Prefer colocated unit or component tests;
use `tests/contracts/` for cross-subsystem contracts and
`tests/architecture/` for repository-wide invariants.

Keep pull requests focused. Do not combine feature work, generated artifacts,
large formatting changes, and unrelated refactors in one change. Preserve
existing user work in dirty worktrees and never use destructive git commands
to resolve unrelated changes.

## Pull request notes

Describe:

- The user-visible problem and outcome.
- Important design decisions or compatibility effects.
- Tests run and any checks that could not be run.
- Security, migration, or persistence implications.

By contributing, you agree that your contribution will be distributed under
the repository's license once one is added. Until then, maintainers should not
accept external contributions.
