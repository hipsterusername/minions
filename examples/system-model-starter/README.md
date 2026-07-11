# System Model Starter

Copy the contents of this directory into `.systemmodel/` at your repository
root, then replace the example names, globs, files, and tests with real ones.

- `manifest.yaml` identifies the model for people and tooling.
- `capabilities/workspace.yaml` describes one user-facing capability and links
  the two flows and its constraint.
- `flows/open_workspace.yaml` and `flows/save_workspace.yaml` describe two
  durable user journeys, including the files and tests that implement them.
- `constraints/workspace_changes_are_reviewed.yaml` states an invariant and
  connects it to the review gate.
- `policies/review-gates.yaml` makes that gate apply when workspace code changes.
- `starter.test.ts` copies this starter into a temporary `.systemmodel/`, loads
  it with the production loader, and checks that schema/reference validation has
  no errors.

After editing, run your repository's system-model validation command. In
Minions itself that is `pnpm system-model:validate`.

