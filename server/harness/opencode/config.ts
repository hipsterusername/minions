import type { McpBridgeRegistration } from "../../mcp-bridge/registry.ts";

/** Merge Minions' ephemeral prompt and MCP bridge into OpenCode's inline config. */
export function buildOpenCodeEnv(input: {
  baseEnv?: NodeJS.ProcessEnv;
  systemPrompt: string;
  bridge?: McpBridgeRegistration;
  groups?: readonly string[];
}): NodeJS.ProcessEnv {
  const env = { ...(input.baseEnv ?? process.env) };
  const existing = parseObject(env["OPENCODE_CONFIG_CONTENT"]);
  const agent = objectValue(existing["agent"]);
  const build = objectValue(agent["build"]);
  agent["build"] = { ...build, prompt: input.systemPrompt };
  existing["agent"] = agent;

  if (input.bridge) {
    const mcp = objectValue(existing["mcp"]);
    for (const group of new Set(input.groups ?? [])) {
      if (!/^[A-Za-z0-9_-]+$/.test(group)) continue;
      const tokenEnv = `MINIONS_BRIDGE_TOKEN_${group.replace(/-/g, "_").toUpperCase()}`;
      env[tokenEnv] = input.bridge.bearerToken;
      mcp[group] = {
        type: "remote",
        url: input.bridge.urlFor(group),
        enabled: true,
        oauth: false,
        headers: { Authorization: `Bearer {env:${tokenEnv}}` },
      };
    }
    existing["mcp"] = mcp;
  }
  env["OPENCODE_CONFIG_CONTENT"] = JSON.stringify(existing);
  return env;
}

function parseObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    return objectValue(JSON.parse(value));
  } catch {
    // Do not make an unrelated malformed inherited override fatal. OpenCode
    // would reject it too; replacing it lets this isolated run remain usable.
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}
