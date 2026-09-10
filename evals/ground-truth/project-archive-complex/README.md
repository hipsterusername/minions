# Archive fixture/grader integration

The fixture owns only an allowlisted public export. `fixture.mjs` exports
`schemaVersion`, `taskId`, `await build(seed)` returning `{schemaVersion,taskId,
files: Record<relativePath,string>}`, and `await materialize({destination,seed})`.
It copies actual `starter/src/` files and the public prompt/example/package
manifest. It never reads this directory or exports a reference implementation.
Reference submission files live exclusively in `reference/src/`.

`oracle.mjs` exports `schemaVersion`, `taskId`, `revision`, `criterionIds` and
`await gradeFiles({execute,seed})`. This plugs into foundation `fileGrader` and
`processExecutor` without importing participant modules into the controller:

```js
const verdicts = await gradeFiles({
  seed: 'locked-repetition-seed',
  execute: async ({command,args,stdin,timeoutMs}) => {
    // Spawn with submission cwd (or docker exec -i --workdir in its container).
    // Feed stdin, capture bounded streams, kill process group on timeout.
    return {code,stdout,stderr};
  },
});
```

Each verdict is `{criterionId,pass,observed}`. The probe receives input rows and
operation data only. Expected results and comparisons remain in `oracle.mjs` in
the controller. It starts submitted `src/server.mjs`, uses real HTTP, kills and
restarts it twice with the same SQLite file, inspects that file using SQLite,
and drives Chromium through real buttons/selects. The candidate app is never
imported by either controller or probe. The probe cleans up children, browser,
and its unique temporary DB. A missing browser fails `archive.ui` explicitly;
it cannot produce full success. This is a functional subprocess boundary, not
a security boundary against malicious submissions; controlled runs still need
the runner's container/process restrictions.

Setup before timing: Node >=22.13, `playwright@1.62.1` installed from the public
fixture package manifest in the prepared workspace and matching Chromium/system
libraries (`npx playwright install --with-deps chromium`). Build a prepared
browser-enabled image for Docker; the manifest Node base alone does not contain
Chromium. No eval package config change or provider access is needed. Offline
tests reuse the repository's installed Playwright/Chromium through a temporary
node_modules symlink. They do not install dependencies or call models. A plain
external export needs that documented dependency preparation once. Run:

```sh
cd evals
pnpm exec vitest run --config tests/support/vitest.config.ts tests/fixtures/archive-process.test.ts
```

Acceptance mapping:

| Criterion | Independent checks |
| --- | --- |
| archive.visibility | Legacy/default/explicit lists, stable order, archived filter, readable detail, missing IDs, invalid filter, ISO archive timestamp |
| archive.edits | Partial active edits and empty strings, invalid patches, archived edit/empty edit rejection, rejected data unchanged after restart, edits after restore |
| archive.restore | Repeat archive timestamp, repeat restore, all fields preserved, archived state across SIGKILL, restored edits across second SIGKILL |
| archive.migration | Legacy rows start null; exact persisted SQLite rows and column set survive migration/restart |
| archive.ui | Actual Chromium archive/filter/restore/reload, API state after actions, escaped HTML-like name |

The process suite exercises reference with two seeds and repeat grading, broken
starter, seven targeted defects (visibility, editing, data loss, restart reset,
destructive migration, browser action, HTML interpolation), and non-starting
source. Defect tests require normal observations, so listener/browser setup
failures cannot masquerade as evidence of catching an application defect.
