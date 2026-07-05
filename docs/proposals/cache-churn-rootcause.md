# Cache-Creation Churn Root Cause

## Summary

The dominant Fable 5 cache-write churn in session `38465c76-de56-47b8-a865-0292fbee10fc` was prompt-prefix invalidation from tool-list changes, not 5-minute TTL expiry. The tight burst at transcript lines 17, 18, 19, 21, and 23 created the same 206,639-token prefix five times in 6.275 seconds, which is too short for TTL expiry. The same transcript shows user-level `claude.ai` Gmail/Calendar/Drive MCP tools being added, removed, and re-added as deferred tools. Because Claude prompt caching is a strict prefix match over tools -> system -> messages, changing the SDK/CLI tool list invalidates the whole cached prefix.

## Evidence

Source files:

- Analysis: `/tmp/fable-session-eval.md`
- Transcript: `/home/hipsterusername/.claude/projects/-home-hipsterusername-PersonalRepos-minions/38465c76-de56-47b8-a865-0292fbee10fc.jsonl`

Session-level totals from the eval:

- Session `38465c76`: 129 assistant events, 27,488,251 cache-read tokens, 4,185,710 cache-creation tokens, total cost `$87.575`.
- Cache invalidation events after the first usage turn: 25 events, 3,962,072 cache-creation tokens, `$49.526`.
- The turn 4-8 burst alone wrote `5 * 206,639 = 1,033,195` cache-creation tokens.

The critical burst:

| transcript line | timestamp UTC | request | input | cache read | cache create | 1h create | 5m create |
|---:|---|---|---:|---:|---:|---:|---:|
| 17 | 2026-07-02T14:20:21.760Z | `req_011CcdNrcbJGjJN7W1qt3WuF` | 2 | 0 | 206,639 | 206,639 | 0 |
| 18 | 2026-07-02T14:20:22.430Z | same | 2 | 0 | 206,639 | 206,639 | 0 |
| 19 | 2026-07-02T14:20:22.435Z | same | 2 | 0 | 206,639 | 206,639 | 0 |
| 21 | 2026-07-02T14:20:26.183Z | same | 2 | 0 | 206,639 | 206,639 | 0 |
| 23 | 2026-07-02T14:20:28.035Z | same | 2 | 0 | 206,639 | 206,639 | 0 |

The gap from line 17 to line 23 is 6.275 seconds, so the 5-minute TTL cannot explain the repeated full-prefix writes. The usage details also report all five writes as `ephemeral_1h_input_tokens`, with `ephemeral_5m_input_tokens = 0`, so this path was already using 1-hour cache writes.

Tool-list instability in the same transcript:

| transcript line | timestamp UTC | deferred-tools delta |
|---:|---|---|
| 4 | 2026-07-02T14:19:44.364Z | Initial deferred list includes Minions MCP tools and built-ins. |
| 25 | 2026-07-02T14:20:28.119Z | Adds `mcp__claude_ai_Gmail__*`, `mcp__claude_ai_Google_Calendar__*`, and `mcp__claude_ai_Google_Drive__*`. |
| 47 | 2026-07-02T14:25:26.422Z | Removes those six `claude_ai` connector tools. |
| 59 | 2026-07-02T14:26:01.200Z | Re-adds the same six connector tools. |
| 72 | 2026-07-02T14:27:50.239Z | Removes the same connector tools and reports pending servers: `claude.ai Gmail`, `claude.ai Google Calendar`, `claude.ai Google Drive`. |
| 81 | 2026-07-02T14:28:20.783Z | Re-adds the same connector tools again. |

The transcript later repeats that pattern at lines 148/171, 236/243, 310/318, and 355/367. Several large cache-create spikes align with or immediately follow those deltas: line 49 creates 197,223 tokens after line 47 removed the connector tools; lines 73-75 create 17,932 tokens after line 72 removed them; line 237 creates 281,553 tokens after line 236 removed them.

## Repo-Controlled Surfaces

`server/session-host-run.ts` assembles the normalized start options. It builds `allowedTools` from `harness.builtInTools`, repo MCP tool names, and explicitly supplied external MCP tool names, then passes `externalMcpServers` through to the harness.

`server/harness/claude/index.ts` is the repo-controlled Claude SDK boundary. Before this fix it:

- Stored registered tool groups in caller-provided object/array order.
- Iterated `Object.entries(registeredGroups)` directly when building `mcpServers`.
- Passed `opts.allowedTools` through in caller-provided order.
- Merged repo MCP servers and explicit `externalMcpServers`, but did not use the SDK's `strictMcpConfig` option.

That means repo-controlled MCP registration could create byte-order drift, and Claude Code could also load ambient project/user/plugin MCP configuration outside this repo's explicit `mcpServers` option.

## SDK-Controlled Surfaces

The flapping `mcp__claude_ai_*` tools are not created by Minions tool factories. They appear as Claude Code deferred tools in the transcript and correspond to user-level `claude.ai` remote connectors. Without `strictMcpConfig`, the Claude Agent SDK/Claude Code layer may include project `.mcp.json`, user settings, plugins, on-disk agent frontmatter MCP, and deferred tools from those sources. Those are SDK/CLI-controlled unless this repo explicitly filters them through SDK options.

The SDK typings expose `strictMcpConfig`, documented as using only MCP servers passed via `mcpServers` plus explicitly passed agent definitions, ignoring project/user/plugin/on-disk MCP config. I did not find an SDK option to set prompt-cache TTL directly. In the captured run, TTL selection was already effectively 1 hour because every cache write in the usage records was under `ephemeral_1h_input_tokens`.

## Fix Applied

In `server/harness/claude/index.ts`:

- Sort registered MCP server names and tool definitions by name at `registerTools()`.
- Snapshot registered groups in sorted order before each run.
- Sort `allowedTools` before passing SDK query options.
- Sort merged repo/external `mcpServers` before passing SDK query options.
- Set `strictMcpConfig: true` so ambient user/project/plugin MCP servers cannot enter this harness through Claude Code configuration.

In `server/harness/claude/index.test.ts`:

- Assert `strictMcpConfig: true` is passed to `query()`.
- Add a deterministic-order regression test covering unsorted tool groups, unsorted allowed tools, and unsorted external MCP servers.

## Residual Risk

This fixes in-repo ordering drift and blocks ambient MCP configuration at the Claude harness boundary. It cannot control tool-list changes injected by a different launcher or future code path that bypasses `ClaudeHarness`. If leaders must use user-level remote connectors, they should be explicitly configured through the repo's stable `externalMcpServers` surface and kept out of ambient Claude Code settings for leader sessions.

The session also contains later long gaps, including a 6-hour gap before transcript line 237. Even with 1-hour cache writes, those gaps can expire the cache. That is a separate cost mode from the tight 14:20:21-14:20:28 burst and cannot be solved by a 5-minute-to-1-hour TTL change because the captured run was already writing 1-hour cache entries.
