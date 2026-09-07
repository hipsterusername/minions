import { beforeEach, describe, it, expect, vi } from "vitest";
import { z } from "zod/v4";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { wrapTools } from "./tools.ts";
import type { NormalizedToolDef } from "../types.ts";

// Observe the SDK boundary while still constructing real SDK tools and servers.
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...sdk, tool: vi.fn(sdk.tool), createSdkMcpServer: vi.fn(sdk.createSdkMcpServer) };
});

beforeEach(() => vi.clearAllMocks());

describe("wrapTools", () => {
  it.each([0, 1, 3])("registers exactly %i tools and forwards their schemas and handlers", async (count) => {
    const schema = z.object({
      taskId: z.string(),
      title: z.string(),
      priority: z.enum(["low", "medium", "high"]),
    });
    const defs: NormalizedToolDef[] = Array.from({ length: count }, (_, index) => ({
      name: `tool_${index}`,
      description: `Tool ${index} description`,
      inputSchema: schema,
      handler: vi.fn(async () => ({ content: [{ type: "text" as const, text: `result_${index}` }] })),
    }));
    const server = wrapTools("test-server", defs);

    expect(server).toMatchObject({ type: "sdk", name: "test-server" });
    expect(tool).toHaveBeenCalledTimes(count);
    expect(createSdkMcpServer).toHaveBeenCalledExactlyOnceWith({
      name: "test-server",
      tools: vi.mocked(tool).mock.results.map((result) => result.value),
    });
    for (const [index, def] of defs.entries()) {
      expect(tool).toHaveBeenNthCalledWith(index + 1, def.name, def.description, schema.shape, expect.any(Function));
      // The spy erases the SDK's schema generic; this adapter accepts unknown
      // input and forwards it to the normalized handler.
      const callback = vi.mocked(tool).mock.calls[index]![3] as (
        args: unknown, extra: unknown,
      ) => Promise<unknown>;
      const input = { taskId: `task_${index}`, title: "Example", priority: "high" };
      await expect(callback(input, {})).resolves.toEqual({
        content: [{ type: "text", text: `result_${index}` }],
      });
      expect(def.handler).toHaveBeenCalledExactlyOnceWith(input);
    }
  });

  it.each([
    ["bad_tool", z.string()],
    ["number_tool", z.number()],
  ])("rejects non-object schema for %s with an actionable diagnostic", (name, inputSchema) => {
    const def: NormalizedToolDef = {
      name,
      description: "Invalid schema",
      inputSchema,
      handler: async () => ({ content: [] }),
    };
    expect(() => wrapTools("s", [def])).toThrow(
      new RegExp(`${name}.*ZodObject.*\\.shape`),
    );
    expect(createSdkMcpServer).not.toHaveBeenCalled();
  });
});
