# Security Policy

Minions launches coding agents against local repositories and can read files,
create worktrees, run model tools, and expose a local web interface. Treat it
as developer tooling with access comparable to the account that starts it.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's
private vulnerability-reporting or security-advisory feature. If that feature
is unavailable, contact a maintainer privately before sharing reproduction
details.

Include the affected version or commit, impact, prerequisites, and a minimal
reproduction. Please omit real credentials, private repository contents,
transcripts, and personal filesystem paths.

## Security boundaries

- Minions is intended for trusted local or tailnet access, not direct public
  internet exposure. The server binds to `127.0.0.1` by default; changing
  `HOST` expands the trust boundary and requires a trusted HTTPS proxy or
  private-network control.
- The browser token bootstrap accepts only loopback or private Tailscale-style
  requests whose host, peer address, and origin agree. It is not a public-web
  authentication system.
- Git change mode controls where changes land and how they enter review.
  Worktree isolation reduces parallel-edit conflicts, but it does not by itself
  restrict process filesystem or network access.
- Execution sandbox policy independently requests filesystem scope, approval
  behavior, and network access. Plan mode forces read-only; workspace-write is
  the normal authorized-root default; unrestricted filesystem access requires
  an explicit request.
- Codex enforces all three displayed sandbox axes. An axis the selected harness
  cannot enforce is reported as `unmanaged`; do not interpret the requested
  policy as a guarantee. Minions does not claim equivalent enforcement for
  Claude, OpenCode, or Pi. Use a dedicated OS account, VM, or container when an
  unmanaged axis is unacceptable.
- Local MCP processes and tools can have privileges outside a harness sandbox.
  Review their definitions and credentials before unattended orchestration.
- Generated HTML, attachments, project paths, WebSocket messages, and external
  MCP configuration should be treated as untrusted input.

## Credentials and local data

- A stable workspace UUID maps server-side to a canonical source root and to
  `$MINIONS_HOME/workspaces/<uuid>/` (default `MINIONS_HOME=~/.minions`) as its
  state root. Project SQLite data, settings, skills, MCP definitions, and new
  worktrees persist there. Global session history and temporary artifacts live
  elsewhere under `MINIONS_HOME`. Protect and back up the complete central
  state separately from the source repository.
- Opening a source folder is the authorization act. Sources may reside on
  mounted volumes, but Minions rejects unregistered roots, traversal, and
  symlink escapes. A workspace UUID is opaque and must not be used to derive or
  accept a client-supplied source path.
- Modern launch and work-item commands carry only `workspaceId`; the server
  resolves the current source root. Rebind and attachment are explicit REST
  operations. Attachment may retire a copy's automatically assigned binding,
  but it does not delete either workspace's central state directory.
- Legacy `<source>/.minions/` content is copied into central state on first
  registration without overwriting destination files or following symlinks.
  Legacy `<source>/.canvas-worktrees/` remains recognized during migration.
  Neither legacy directory is automatically deleted; retain it until migrated
  state and pending work are verified.
- MCP definitions are stored in the workspace state root as
  `mcp-servers.json`, with owner-only
  permissions where the platform supports POSIX modes. Environment variables
  and HTTP headers in that file are plaintext local secrets: do not commit,
  sync, or paste the state directory into reports.
- Codex launches receive a restricted environment allowlist. Claude and MCP
  permissions remain provider-controlled capabilities; verify effective policy
  and use the narrowest mode that can complete the task.
- If the normal Codex home is unusable, its fallback is created below
  `MINIONS_HOME/runtime/`; Minions does not create runtime state in a repository.
- HTTP MCP endpoints are accepted without TLS only on loopback. Remote MCP
  endpoints must use HTTPS, but Minions does not attest to or sandbox the
  remote server's behavior.

## Deployment guidance

Use the default loopback bind for desktop use. For mobile access, prefer the
documented Tailscale HTTPS setup and do not enable public Funnel exposure.
Place no unrelated reverse proxy, browser extension, or untrusted local user
inside the same trust boundary. If stronger multi-user isolation is required,
run Minions in a dedicated OS account, VM, or container with separately scoped
provider credentials.

Only the latest revision on `main` receives security fixes while the project is
in early development.
