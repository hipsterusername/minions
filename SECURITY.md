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
- Agent and MCP permissions determine what model sessions can do. Review
  permission changes before enabling unattended orchestration.
- Worktree isolation reduces parallel-edit conflicts; it is not a sandbox or a
  substitute for operating-system isolation. Agents and stdio MCP servers run
  with the operating-system privileges of the account that starts Minions.
- Generated HTML, attachments, project paths, WebSocket messages, and external
  MCP configuration should be treated as untrusted input.

## Credentials and local data

- Project state and transcripts are stored in per-project SQLite data under
  `.minions/`; worktrees normally live under `.canvas-worktrees/`. These files
  persist until the project or worktrees are removed. Back up, retain, and
  delete them according to the sensitivity of the repository.
- MCP definitions are stored in `.minions/mcp-servers.json` with owner-only
  permissions where the platform supports POSIX modes. Environment variables
  and HTTP headers in that file are plaintext local secrets: do not commit,
  sync, or paste the sidecar into reports.
- Codex launches receive a restricted environment allowlist. Claude and MCP
  permissions remain provider-controlled capabilities; use the narrowest mode
  that can complete the task.
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
