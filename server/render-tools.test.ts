/**
 * server/render-tools: MCP tools the leader uses to drive its dashboard.
 *
 * These tests invoke the tool handlers directly via the `toolDefs` array the
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
import type { NormalizedToolDef } from "./harness/types.ts";

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
  toolDefs: ReadonlyArray<NormalizedToolDef>,
  name: string,
): NormalizedToolDef {
  const t = toolDefs.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} missing`);
  return t;
}

async function call(def: NormalizedToolDef, args: unknown) {
  return await def.handler(args);
}

describe("render-tools", () => {
  describe("render_append", () => {
    it("dedupes by id, mirroring the client reducer", async () => {
      const { bus } = makeBus();
      const { toolDefs, renderState } = createRenderToolsForLeader({
        leaderSessionKey: "s1",
        bus,
      });
      const setTool = findTool(toolDefs, "render_set");
      const appendTool = findTool(toolDefs, "render_append");

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
      const { toolDefs, renderState } = createRenderToolsForLeader({
        leaderSessionKey: "s2",
        bus,
        existingRenderState: {
          layout: { title: "Stale title", columns: 4, gap: 12 },
          components: [],
        },
      });
      const setTool = findTool(toolDefs, "render_set");

      await call(setTool, { components: [] });

      // Both title and columns are reset to their documented defaults when
      // the agent doesn't pass them — `set` is a full replace.
      expect(renderState.layout.title).toBe("");
      expect(renderState.layout.columns).toBe(2);
    });

    it("respects explicit title and columns", async () => {
      const { bus } = makeBus();
      const { toolDefs, renderState } = createRenderToolsForLeader({
        leaderSessionKey: "s3",
        bus,
      });
      const setTool = findTool(toolDefs, "render_set");

      await call(setTool, {
        title: "Hello",
        columns: 3,
        components: [],
      });

      expect(renderState.layout.title).toBe("Hello");
      expect(renderState.layout.columns).toBe(3);
    });

    it("rejects garbage input before mutating state — parse guard", async () => {
      const { bus } = makeBus();
      const { toolDefs, renderState } = createRenderToolsForLeader({
        leaderSessionKey: "s-parse-set",
        bus,
      });
      const setTool = findTool(toolDefs, "render_set");

      // Null is not a valid object — zod should reject it.
      await expect(call(setTool, null)).rejects.toThrow();
      // Missing required 'components' field.
      await expect(call(setTool, { title: "ok" })).rejects.toThrow();
      expect(renderState.components).toEqual([]);
    });

    it("rejects non-object components before mutating state", async () => {
      const { bus, sent } = makeBus();
      const { toolDefs, renderState } = createRenderToolsForLeader({
        leaderSessionKey: "s-bad",
        bus,
      });
      const setTool = findTool(toolDefs, "render_set");

      await expect(
        call(setTool, { components: ['{"id":"x","type":"text","content":"bad"}'] }),
      ).rejects.toThrow();

      expect(renderState.components).toEqual([]);
      expect(sent).toEqual([]);
    });

    it("rejects non-object child components inside containers", async () => {
      const { bus, sent } = makeBus();
      const { toolDefs, renderState } = createRenderToolsForLeader({
        leaderSessionKey: "s-bad-nested",
        bus,
      });
      const setTool = findTool(toolDefs, "render_set");

      await expect(
        call(setTool, {
          components: [
            {
              id: "section",
              type: "section",
              title: "Bad nested payload",
              components: ['{"id":"x","type":"text","content":"bad"}'],
            },
          ],
        }),
      ).rejects.toThrow();

      expect(renderState.components).toEqual([]);
      expect(sent).toEqual([]);
    });
  });

  describe("default elision", () => {
    it("strips fields equal to documented defaults from render_set inputs", async () => {
      const { bus } = makeBus();
      const { toolDefs, renderState } = createRenderToolsForLeader({
        leaderSessionKey: "s-elide-set",
        bus,
      });
      const setTool = findTool(toolDefs, "render_set");

      await call(setTool, {
        components: [
          {
            id: "m",
            type: "metric",
            label: "Builds",
            value: "1",
            trend: "flat",
            span: "auto",
          },
          {
            id: "c",
            type: "callout",
            variant: "info",
            content: "hi",
            span: "auto",
          },
        ],
      });

      // trend=flat, span=auto, variant=info are all dropped by the
      // elider. The rest of the component shape is untouched.
      const [metric, callout] = renderState.components;
      expect(metric).toEqual({
        id: "m",
        type: "metric",
        label: "Builds",
        value: "1",
      });
      expect(callout).toEqual({ id: "c", type: "callout", content: "hi" });
    });

    it("does not re-introduce defaults via render_patch", async () => {
      const { bus } = makeBus();
      const { toolDefs, renderState } = createRenderToolsForLeader({
        leaderSessionKey: "s-elide-patch",
        bus,
      });
      const setTool = findTool(toolDefs, "render_set");
      const patchTool = findTool(toolDefs, "render_patch");

      await call(setTool, {
        components: [
          { id: "m", type: "metric", label: "L", value: "1", trend: "up" },
        ],
      });

      // Agent restates trend=flat in the patch — should be elided.
      await call(patchTool, {
        updates: [{ id: "m", value: "2", trend: "flat" }],
      });

      expect(renderState.components[0]).toEqual({
        id: "m",
        type: "metric",
        label: "L",
        value: "2",
      });
    });
  });

  describe("render_patch parse guard", () => {
    it("rejects garbage input without mutating state", async () => {
      const { bus } = makeBus();
      const { toolDefs, renderState } = createRenderToolsForLeader({
        leaderSessionKey: "s-parse-patch",
        bus,
      });
      const setTool = findTool(toolDefs, "render_set");
      const patchTool = findTool(toolDefs, "render_patch");

      await call(setTool, {
        components: [{ id: "m1", type: "metric", label: "A", value: "1" }],
      });

      // Null and missing 'updates' field are both invalid.
      await expect(call(patchTool, null)).rejects.toThrow();
      await expect(call(patchTool, {})).rejects.toThrow();
      // 'updates' must be an array — a plain object is invalid.
      await expect(call(patchTool, { updates: "bad" })).rejects.toThrow();

      // State is unchanged after all the bad calls.
      expect(renderState.components).toHaveLength(1);
    });
  });

  describe("render_remove parse guard", () => {
    it("rejects garbage input without mutating state", async () => {
      const { bus } = makeBus();
      const { toolDefs, renderState } = createRenderToolsForLeader({
        leaderSessionKey: "s-parse-remove",
        bus,
      });
      const setTool = findTool(toolDefs, "render_set");
      const removeTool = findTool(toolDefs, "render_remove");

      await call(setTool, {
        components: [
          { id: "a", type: "text", content: "A" },
          { id: "b", type: "text", content: "B" },
        ],
      });

      // Null and missing 'ids' field are both invalid.
      await expect(call(removeTool, null)).rejects.toThrow();
      await expect(call(removeTool, {})).rejects.toThrow();
      // 'ids' must be an array of strings — a number array is invalid.
      await expect(call(removeTool, { ids: [1, 2] })).rejects.toThrow();

      // Both components remain after all invalid calls.
      expect(renderState.components).toHaveLength(2);
    });
  });

  describe("onStateChange", () => {
    it("fires after every mutation", async () => {
      const { bus } = makeBus();
      const calls: number[] = [];
      const { toolDefs } = createRenderToolsForLeader({
        leaderSessionKey: "s4",
        bus,
        onStateChange: (state) => {
          calls.push(state.components.length);
        },
      });
      const setTool = findTool(toolDefs, "render_set");
      const appendTool = findTool(toolDefs, "render_append");
      const removeTool = findTool(toolDefs, "render_remove");

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
