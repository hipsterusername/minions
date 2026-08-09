---
id: decision.portable_workspace_roots
type: decision
title: Separate portable workspace identity, source, state, and execution roots
status: accepted
summary: Stable workspace UUIDs bind canonical source roots to central state and worktree roots while sandbox policy independently governs process access.
evidence: [server/workspace-registry.ts, server/project-store.ts, server/worktree-owned-root.ts, shared/workspace-contracts.ts, server/harness/sandbox-policy.ts]
---
# Separate portable workspace identity, source, state, and execution roots

## Context

Encoding a repository path as project identity tied persisted state to one host layout, wrote Minions metadata into repositories, and excluded legitimate mounted-volume sources. Git worktrees also answer a different question from process sandboxing: they separate change sets but do not constrain what an agent process can read, write, approve, or reach over the network.

## Decision

An explicitly registered workspace receives an opaque stable UUID. The server—not clients—maps that UUID to a canonical `sourceRoot` and to `MINIONS_HOME/workspaces/<uuid>` as its `stateRoot`. New SQLite state, settings, skills, MCP definitions, and execution worktrees live below the state root; worktrees use `<stateRoot>/worktrees`. Source roots may be on arbitrary mounted volumes, but location never grants authority: registration, canonicalization, owned-root checks, traversal rejection, and symlink-escape rejection remain mandatory.

On first registration, existing `<sourceRoot>/.minions` content is copied without following symlinks and without overwriting destination files. Existing `<sourceRoot>/.canvas-worktrees` paths remain recognized for migration and cleanup, while new worktrees use the central execution root. Migration is non-destructive; legacy data is not automatically deleted.

Git change mode and process sandbox policy remain separate. Sandbox requests always specify filesystem scope, approval policy, and network access. Plan mode forces read-only; ordinary authorized roots default to workspace-write; unrestricted access requires an explicit request. Codex enforces all three axes. Other harnesses report axes they cannot enforce as `unmanaged` rather than inheriting or implying a guarantee.

## Consequences and tradeoffs

- Repositories and mounted sources remain portable and free of newly created Minions state.
- Stable UUID routes no longer expose or depend on source path encoding.
- Central state needs backup and retention handling separate from source repositories.
- During migration, central and legacy roots coexist, so ownership checks must accept only the two known roots and must never delete legacy data merely because import succeeded.
- A requested policy is not itself a security guarantee; callers and UI must use the effective, harness-resolved policy.
