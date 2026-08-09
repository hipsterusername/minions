import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import type { WebSocketServer } from "ws";
import { createBus } from "../bus.ts";
import type { NormalizedToolDef } from "../harness/types.ts";
import { createRenderToolsForLeader } from "../render-tools.ts";
import { dispatchMethod } from "./dispatch.ts";

function makeDef(overrides: Partial<NormalizedToolDef> & { name: string }): NormalizedToolDef {
  return {
    description: `${overrides.name} tool`,
    inputSchema: z.object({ value: z.string() }),
    handler: async (input: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify(input) }],
    }),
    ...overrides,
  };
}

function renderTools() {
  const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
  return createRenderToolsForLeader({
    leaderSessionKey: "render-dispatch",
    bus,
  });
}

describe("MCP bridge dispatch", () => {
  it("validates tool arguments before invoking handlers", async () => {
    let called = false;
    const res = await dispatchMethod(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "needs_value",
          arguments: { value: 123 },
        },
      },
      [
        makeDef({
          name: "needs_value",
          handler: async () => {
            called = true;
            return { content: [{ type: "text", text: "unexpected" }] };
          },
        }),
      ],
    );

    expect(called).toBe(false);
    expect(res.result).toMatchObject({ isError: true });
  });

  it("exposes render components as objects for schema-limited harnesses", async () => {
    const { toolDefs } = renderTools();
    const res = await dispatchMethod(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      toolDefs,
    );
    const result = res.result as {
      tools: Array<{
        name: string;
        description: string;
        inputSchema: {
          properties?: Record<string, { items?: Record<string, unknown> }>;
        };
      }>;
    };
    const renderSet = result.tools.find((t) => t.name === "render_set");
    const componentItems = renderSet?.inputSchema.properties?.["components"]?.items as
      | { type?: string; description?: string; required?: string[]; properties?: Record<string, unknown> }
      | undefined;

    expect(componentItems?.type).toBe("object");
    expect(componentItems?.required).toEqual(["id", "type"]);
    expect(componentItems?.description).toContain("Dashboard component object");
    expect(componentItems?.properties?.["type"]).toMatchObject({
      enum: expect.arrayContaining(["metric", "chart", "section", "file-preview"]),
    });
    expect(renderSet?.description).toContain("live side panel");
    expect(renderSet?.description).toContain("JSON object");
    expect(renderSet?.description).toContain("form(fields)");
    expect(renderSet?.description).toContain("file-preview(source)");
  });

  it("rejects stringified render components before dashboard state mutation", async () => {
    const { toolDefs, renderState } = renderTools();
    const res = await dispatchMethod(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "render_set",
          arguments: { components: ['{"id":"x","type":"text","content":"bad"}'] },
        },
      },
      toolDefs,
    );

    expect(res.result).toMatchObject({ isError: true });
    expect(renderState.components).toEqual([]);
  });
});
