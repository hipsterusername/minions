# Isolated stability checks

Run these from the repository root after installing dependencies:

```sh
node --expose-gc --import ./scripts/register-typescript.mjs tests/stability/archive.mjs
node --expose-gc --import ./scripts/register-typescript.mjs tests/stability/history-memory.mjs eager
node --expose-gc --import ./scripts/register-typescript.mjs tests/stability/history-memory.mjs lazy
node --expose-gc --import ./scripts/register-typescript.mjs tests/stability/graph-validation.mjs
node --import ./scripts/register-typescript.mjs --test tests/stability/integration.mjs tests/stability/lazy-provider.mjs
```

The archive checks create 32 synthetic sessions with 80 events each in a fresh
operating-system temporary directory and delete the database after the check,
including on assertion failures. They do not accept existing database paths.
The memory comparison accepts an optional synthetic session count after its mode
(1–1000). Run each mode in a separate process to compare retained memory.

Graph validation uses an in-memory database. Wake checks use in-memory databases,
isolated temporary working directories, and fixture providers. No check needs
existing application state, user transcripts, or provider credentials.

Memory measurements vary with the host and Node version. Console output is local
diagnostic evidence; keep saved logs under ignored `.scratch/` directories.
