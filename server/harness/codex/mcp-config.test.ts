/**
 * Unit tests for the Codex MCP config renderer (mcp-config.ts).
 *
 * The renderer is provider-neutral apart from its key shape; we don't talk
 * to a live Codex SDK here. We feed in a minimal stand-in for
 * `McpBridgeRegistration` (only `urlFor` + `bearerToken` matter to the
 * renderer) and assert the produced `CodexConfigObject` and `env` map.
 *
 * Pinned behaviour:
 *   - Each group becomes one `mcp_servers.<group>` entry with `url` and
 *     `bearer_token_env_var`.
 *   - The bearer token is returned via `env`, not in the config object,
 *     so it never reaches the Codex CLI argv.
 *   - Duplicate group names are de-duplicated.
 *   - Group names with `-` map to `_` in env-var names (uppercase).
 *   - Invalid group names are rejected to prevent injection into the
 *     `mcp_servers.<group>.<field>` key path.
 */

import { describe, it, expect } from "vitest";
import { renderBridgeServers, bearerTokenEnvVar } from "./mcp-config.ts";
import type { McpBridgeRegistration } from "../../mcp-bridge/registry.ts";

function fakeRegistration(overrides: Partial<McpBridgeRegistration> = {}): McpBridgeRegistration {
  return {
    sessionKey: "session-a",
    bearerToken: "token-abc",
    urlFor: (group: string) => `http://127.0.0.1:9999/mcp/session-a/${group}`,
    dispose: (): void => {
      /* test stub */
    },
    ...overrides,
  };
}

describe("renderBridgeServers", () => {
  it("produces an mcp_servers.<group> entry per requested group", () => {
    const reg = fakeRegistration();
    const { config } = renderBridgeServers(reg, ["task-manager", "render-dashboard"]);

    expect(config).toEqual({
      "mcp_servers.task-manager": {
        url: "http://127.0.0.1:9999/mcp/session-a/task-manager",
        bearer_token_env_var: "MINIONS_BRIDGE_TOKEN_TASK_MANAGER",
      },
      "mcp_servers.render-dashboard": {
        url: "http://127.0.0.1:9999/mcp/session-a/render-dashboard",
        bearer_token_env_var: "MINIONS_BRIDGE_TOKEN_RENDER_DASHBOARD",
      },
    });
  });

  it("returns the bearer token via env, never in the config object", () => {
    const reg = fakeRegistration({ bearerToken: "secret-xyz" });
    const { config, env } = renderBridgeServers(reg, ["task-manager"]);

    expect(env).toEqual({ MINIONS_BRIDGE_TOKEN_TASK_MANAGER: "secret-xyz" });
    // The token must not leak into any config value.
    const configJson = JSON.stringify(config);
    expect(configJson).not.toContain("secret-xyz");
  });

  it("returns an empty config and env for zero groups", () => {
    const reg = fakeRegistration();
    expect(renderBridgeServers(reg, [])).toEqual({ config: {}, env: {} });
  });

  it("de-duplicates duplicate group names", () => {
    const reg = fakeRegistration();
    const { config, env } = renderBridgeServers(reg, ["task-manager", "task-manager"]);
    expect(Object.keys(config)).toEqual(["mcp_servers.task-manager"]);
    expect(Object.keys(env)).toEqual(["MINIONS_BRIDGE_TOKEN_TASK_MANAGER"]);
  });

  it("uses urlFor() from the registration for each entry", () => {
    let calls = 0;
    const reg = fakeRegistration({
      urlFor: (group: string) => {
        calls += 1;
        return `https://bridge.test/${group}`;
      },
    });
    const { config } = renderBridgeServers(reg, ["a", "b", "c"]);
    expect(calls).toBe(3);
    expect((config["mcp_servers.a"] as { url: string }).url).toBe("https://bridge.test/a");
    expect((config["mcp_servers.b"] as { url: string }).url).toBe("https://bridge.test/b");
    expect((config["mcp_servers.c"] as { url: string }).url).toBe("https://bridge.test/c");
  });

  it("rejects group names that contain unsafe characters", () => {
    const reg = fakeRegistration();
    expect(() => renderBridgeServers(reg, ["bad name"])).toThrow(/invalid group name/);
    expect(() => renderBridgeServers(reg, ["bad.name"])).toThrow(/invalid group name/);
    expect(() => renderBridgeServers(reg, [""])).toThrow(/invalid group name/);
  });
});

describe("bearerTokenEnvVar", () => {
  it("uppercases and replaces hyphens with underscores", () => {
    expect(bearerTokenEnvVar("task-manager")).toBe("MINIONS_BRIDGE_TOKEN_TASK_MANAGER");
    expect(bearerTokenEnvVar("minion-status")).toBe("MINIONS_BRIDGE_TOKEN_MINION_STATUS");
  });

  it("leaves alphanumeric/underscore names alone (apart from upper-casing)", () => {
    expect(bearerTokenEnvVar("simple")).toBe("MINIONS_BRIDGE_TOKEN_SIMPLE");
    expect(bearerTokenEnvVar("with_underscores")).toBe("MINIONS_BRIDGE_TOKEN_WITH_UNDERSCORES");
  });
});
