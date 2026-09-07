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
live in [CLAUDE.md](./CLAUDE.md).

## Local working artifacts

When using Minions to work on this repository, keep session working material in
ignored `.scratch/<task>/` directories. For example:

- `.scratch/<task>/notes.md` and `handoff.md` for working notes and continuity.
- `.scratch/<task>/evidence/` for logs, screenshots, audit ledgers and reports.
- `.scratch/<task>/repro/` for disposable experiments and reproduction scripts.
- `.scratch/<task>/backups/` for recovery patches and copies of pending changes.

Create these directories as needed; their contents stay local. For disposable
test state, use `fs.mkdtemp` with `os.tmpdir()` and clean up the directory after
use. Give each task or test its own directory. Keep runtime databases, provider
state and credentials in their configured application storage, outside source
files; tests must use isolated temporary storage rather than live user state.

Use the canvas `update_project_context` tool to save project knowledge in
workspace-owned storage. Include these scratch conventions in task assignments.
Do not write session context or raw audit output into published documentation.
Legacy `docs/audits/` working records are also ignored.

Before promoting a result into source or documentation, remove usernames,
absolute checkout paths, session identifiers, credentials and dependencies on
local evidence files. Use repository-relative links in documentation and
fictional paths such as `/workspace/project/docs/report.md` in test fixtures.
Promote useful reproductions into normal tests with temporary fixtures.

Before staging, use `git check-ignore -v -- <scratch-path>` to confirm the
location is ignored. Stage intended files explicitly, then inspect
`git diff --cached --name-status` and `git diff --cached` for local artifacts and
personal data. Ignore rules do not protect already tracked files or prevent
`git add -f`; never force-add local working artifacts or add ignore exceptions
for session output. Existing tracked leaks must be removed or sanitized explicitly.

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

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in Minions is provided under the Apache License 2.0, as described
in [LICENSE](./LICENSE).
