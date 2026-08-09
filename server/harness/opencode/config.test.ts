import { describe, expect, it } from "vitest";
import type { McpBridgeRegistration } from "../../mcp-bridge/registry.ts";
import { buildOpenCodeEnv } from "./config.ts";

describe("buildOpenCodeEnv", () => {
  it("merges the system prompt and bridge servers with inherited inline config", () => {
    const bridge = {
      bearerToken: "secret-token",
      urlFor: (group: string) => `http://127.0.0.1/mcp/${group}`,
    } as McpBridgeRegistration;
    const env = buildOpenCodeEnv({
      baseEnv: { OPENCODE_CONFIG_CONTENT: '{"model":"local/base","agent":{"build":{"temperature":0}}}' },
      systemPrompt: "Minions system prompt",
      bridge,
      groups: ["task-manager"],
    });
    const config = JSON.parse(env["OPENCODE_CONFIG_CONTENT"]!) as Record<string, any>;
    expect(config["model"]).toBe("local/base");
    expect(config["agent"]["build"]).toMatchObject({ temperature: 0, prompt: "Minions system prompt" });
    expect(config["mcp"]["task-manager"]).toMatchObject({
      type: "remote",
      url: "http://127.0.0.1/mcp/task-manager",
      oauth: false,
      headers: { Authorization: "Bearer {env:MINIONS_BRIDGE_TOKEN_TASK_MANAGER}" },
    });
    expect(env["MINIONS_BRIDGE_TOKEN_TASK_MANAGER"]).toBe("secret-token");
    expect(env["OPENCODE_CONFIG_CONTENT"]).not.toContain("secret-token");
  });
});
