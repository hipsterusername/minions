/**
 * Codex `--config` rendering for bridge-backed MCP servers.
 *
 * Codex consumes per-thread MCP server config via `Codex` constructor's
 * `config` field, which the SDK flattens to `--config <key>=<value>`
 * overrides on the CLI. The keys live under `mcp_servers.<name>.<field>`
 * — see https://developers.openai.com/codex/mcp.
 *
 * For Minions-internal tools (task-manager, render-dashboard, minion-status),
 * each tool group registered with the bridge becomes one Codex MCP server
 * entry pointing at the bridge's HTTP endpoint, with the bearer token
 * supplied through an environment variable so it never appears in the
 * Codex CLI argv (which is logged).
 *
 * This module is provider-neutral apart from the literal Codex key shape:
 * the bridge `McpBridgeRegistration` is the only thing it depends on, and
 * `BridgeServerConfigGroup` mirrors only the fields Codex actually accepts.
 *
 * CodexHarness calls this renderer for every bridge-backed run.
 */

import type { McpBridgeRegistration } from "../../mcp-bridge/registry.ts";

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Single Codex `mcp_servers.<name>.*` entry for an HTTP-transport server.
 * Codex's HTTP MCP fields per its docs: `url`, `bearer_token_env_var`,
 * optional `http_headers`, optional `env_http_headers`, plus universal
 * fields (`enabled`, `enabled_tools`, ...). We only set what the bridge
 * actually needs; keeping the type narrow makes it obvious when something
 * starts to leak.
 */
export interface BridgeServerConfigGroup {
  url: string;
  bearer_token_env_var: string;
}

/**
 * Free-form Codex config object. The Codex SDK's CodexConfigObject is
 * `Record<string, unknown>` — we mirror that shape locally so this module
 * does not need to depend directly on `@openai/codex-sdk`.
 */
export type CodexConfigObject = Record<string, unknown>;

// ── Renderer ──────────────────────────────────────────────────────────────────

export interface RenderBridgeServersResult {
  /**
   * Flat config object ready to merge into the Codex constructor's `config`.
   * Keys follow `mcp_servers.<group>` so the SDK can flatten further to
   * `--config mcp_servers.<group>.url=...` on the CLI.
   */
  config: CodexConfigObject;
  /**
   * Environment variables Codex must inherit so its MCP client can read
   * the bearer token (referenced by `bearer_token_env_var` per group).
   */
  env: Record<string, string>;
}

/**
 * Render bridge-backed MCP servers for one Codex thread.
 *
 * @param reg     The session's bridge registration (token + URL builder).
 * @param groups  Names of the tool groups to expose to Codex. Order is not
 *                significant; duplicates are dropped.
 *
 * @returns A `{ config, env }` pair to merge into the Codex constructor.
 *
 * Token handling note: tokens go into `env`, not `http_headers`, so they
 * never appear in the Codex CLI argv (which `--config` arguments do).
 * The env var name is derived from the group name to keep them disjoint
 * across groups.
 */
export function renderBridgeServers(
  reg: McpBridgeRegistration,
  groups: readonly string[],
): RenderBridgeServersResult {
  const config: CodexConfigObject = {};
  const env: Record<string, string> = {};
  const seen = new Set<string>();

  for (const group of groups) {
    if (seen.has(group)) continue;
    seen.add(group);
    if (!isValidGroupName(group)) {
      throw new Error(
        `renderBridgeServers: invalid group name "${group}". ` +
          "Group names must be non-empty alphanumeric/underscore/hyphen identifiers.",
      );
    }

    const envVar = bearerTokenEnvVar(group);
    const entry: BridgeServerConfigGroup = {
      url: reg.urlFor(group),
      bearer_token_env_var: envVar,
    };
    config[`mcp_servers.${group}`] = entry;
    env[envVar] = reg.bearerToken;
  }

  return { config, env };
}

/**
 * Compute the env-var name Codex looks up for a group's bearer token.
 * Exposed because the Codex harness also needs to assemble the env in
 * `CodexOptions.env`; keeping the naming scheme in one place avoids drift.
 */
export function bearerTokenEnvVar(group: string): string {
  // Group names can contain `-` (e.g. `task-manager`); env vars are
  // conventionally uppercase with `_` separators, so map `-` → `_`.
  return `MINIONS_BRIDGE_TOKEN_${group.replace(/-/g, "_").toUpperCase()}`;
}

// ── Internals ─────────────────────────────────────────────────────────────────

/** Group names map directly into config keys and env vars; restrict the
 *  charset so we can't accidentally produce `mcp_servers..foo` or env vars
 *  with shell-special characters. */
function isValidGroupName(group: string): boolean {
  return group.length > 0 && /^[A-Za-z0-9_-]+$/.test(group);
}
