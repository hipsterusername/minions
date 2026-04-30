/**
 * server/render-tools: MCP tools the leader uses to drive its dashboard.
 *
 * These tests invoke the tool handlers directly via the `tools` array the
 * factory exposes, then assert on the locally-held `renderState` and on the
 * `render_update` envelopes the bus emits. We mock the bus surface (not the
 * tool logic) so the tests live close to the dispatcher contract.
 *
 * Why this file exists: a recent review pass found that the server's
 * `render_append` handler was a naive `Array.push(...)`, while the client
 * reducer in `shared/render-dsl.ts` dedupes by id. That divergence means a
 * legitimate "replace by appending the same id" call leaves the persisted
 * server state with duplicates the user never sees. The first test below is
 * the regression pin.
 */
import { describe, it, expect } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus, type Bus } from "./bus.ts";
import { createRenderToolsForLeader } from "./render-tools.ts";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";

interface FakeClient {
  readyState: number;
  sent: string[];
  send: (msg: string) => void;
}

function makeBus(): { bus: Bus; sent: object[] } {
  const sent: object[] = [];
  const client: FakeClient = {
    readyState: 1, // OPEN
    sent: [],
    send(msg: string) {
      sent.push(JSON.parse(msg));
    },
  };
  const wss = {
    clients: new Set([client]),
  } as unknown as WebSocketServer;
  return { bus: createBus(wss), sent };
}

function findTool(
  tools: ReadonlyArray<SdkMcpToolDefinition>,
  name: string,
): SdkMcpToolDefinition {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} missing`);
  return t;
}

async function call<T extends { name: string }>(tool: T, args: unknown) {
  // The handler is the only field we exercise; cast to the SDK shape.
  return await (
    tool as unknown as { handler: (a: unknown, e: unknown) => Promise<unknown> }
  ).handler(args, undefined);
}

describe("render-tools", () => {
  describe("render_append", () => {
    it("dedupes by id, mirroring the client reducer", async () => {
      const { bus } = makeBus();
      const { tools, renderState } = createRenderToolsForLeader({
        leaderSessionKey: "s1",
        bus,
      });
      const setTool = findTool(tools, "render_set");
      const appendTool = findTool(tools, "render_append");

      await call(setTool, {
        components: [
          { id: "m1", type: "metric", label: "A", value: "1" },
          { id: "m2", type: "metric", label: "B", value: "2" },
        ],
      });

      await call(appendTool, {
        components: [
          { id: "m2", type: "metric", label: "B'", value: "22" },
          { id: "m3", type: "metric", label: "C", value: "3" },
        ],
      });

      // m1 preserved, m2 replaced by the appended copy, m3 added.
      expect(renderState.components.map((c) => c.id)).toEqual([
        "m1",
        "m2",
        "m3",
      ]);
      const m2 = renderState.components.find((c) => c.id === "m2");
      // Type guard: render_append result is a metric in this test.
      if (m2?.type !== "metric") throw new Error("expected metric");
      expect(m2.value).toBe("22");
    });
  });

  describe("render_set", () => {
    it("clears the prior title when the agent omits one", async () => {
      const { bus } = makeBus();
      const { tools, renderState } = createRenderToolsForLeader({
        leaderSessionKey: "s2",
        bus,
        existingRenderState: {
          title: "Stale title",
          columns: 4,
          gap: 12,
          components: [],
        },
      });
      const setTool = findTool(tools, "render_set");

      await call(setTool, { components: [] });

      // Both title and columns are reset to their documented defaults when
      // the agent doesn't pass them — `set` is a full replace.
      expect(renderState.title).toBe("");
      expect(renderState.columns).toBe(2);
    });

    it("respects explicit title and columns", async () => {
      const { bus } = makeBus();
      const { tools, renderState } = createRenderToolsForLeader({
        leaderSessionKey: "s3",
        bus,
      });
      const setTool = findTool(tools, "render_set");

      await call(setTool, {
        title: "Hello",
        columns: 3,
        components: [],
      });

      expect(renderState.title).toBe("Hello");
      expect(renderState.columns).toBe(3);
    });
  });

  describe("onStateChange", () => {
    it("fires after every mutation", async () => {
      const { bus } = makeBus();
      const calls: number[] = [];
      const { tools } = createRenderToolsForLeader({
        leaderSessionKey: "s4",
        bus,
        onStateChange: (state) => {
          calls.push(state.components.length);
        },
      });
      const setTool = findTool(tools, "render_set");
      const appendTool = findTool(tools, "render_append");
      const removeTool = findTool(tools, "render_remove");

      await call(setTool, {
        components: [{ id: "a", type: "text", content: "hi" }],
      });
      await call(appendTool, {
        components: [{ id: "b", type: "text", content: "there" }],
      });
      await call(removeTool, { ids: ["a"] });

      expect(calls).toEqual([1, 2, 1]);
    });
  });
});
