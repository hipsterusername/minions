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
  internet exposure.
- Agent and MCP permissions determine what model sessions can do. Review
  permission changes before enabling unattended orchestration.
- Worktree isolation reduces parallel-edit conflicts; it is not a sandbox or a
  substitute for operating-system isolation.
- Generated HTML, attachments, project paths, WebSocket messages, and external
  MCP configuration should be treated as untrusted input.

Only the latest revision on `main` receives security fixes while the project is
in early development.
