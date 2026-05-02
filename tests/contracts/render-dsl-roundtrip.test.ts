/**
 * Render-DSL producer ↔ consumer round-trip — the §2.1 Wave 2 rewrite
 * called for in `docs/testing-strategy.md` and `docs/testing-gaps-...md`.
 *
 * The shared test in `shared/render-dsl.test.ts` only exercises the
 * client-side `applyRenderMessage` reducer. This contract test joins
 * the real **server** producer (`createRenderToolsForLeader`) to the
 * real **client** consumer (`applyRenderMessage`) so a regression in
 * either side surfaces with a targeted failure.
 *
 * Per `docs/testing-strategy.md` §5.4, NO part of this test
 * hand-constructs a payload and parses it through its own schema —
 * every payload originates from the real producer.
 */

import { describe, expect, it } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus } from "../../server/bus.ts";
import { createRenderToolsForLeader } from "../../server/render-tools.ts";
import type { NormalizedToolDef } from "../../server/harness/types.ts";
import {
  applyRenderMessage,
  emptyRenderState,
  type RenderMessage,
  type RenderState,
} from "../../shared/render-dsl.ts";

interface CapturedEnvelope {
  topic?: string;
  type?: string;
  [key: string]: unknown;
}

function rig() {
  const captured: CapturedEnvelope[] = [];
  const wss = { clients: new Set() } as unknown as WebSocketServer;
  const bus = createBus(wss);
  bus.subscribe((env) => {
    captured.push(env as CapturedEnvelope);
  });
  return { bus, captured };
}

/**
 * Pull the most recent envelope, strip the bus's transport-only fields
 * (topic/leaderSessionKey), and return the RenderMessage shape the
 * client reducer consumes.
 */
function lastRenderMessage(envelopes: CapturedEnvelope[]): RenderMessage {
  const env = envelopes.at(-1);
  if (!env) throw new Error("no envelope captured");
  const { topic: _topic, type: _type, leaderSessionKey: _l, ...payload } = env;
  return payload as unknown as RenderMessage;
}

async function callTool(def: NormalizedToolDef, args: unknown): Promise<unknown> {
  return await def.handler(args);
}

function findTool(defs: ReadonlyArray<NormalizedToolDef>, name: string): NormalizedToolDef {
  const t = defs.find((d) => d.name === name);
  if (!t) throw new Error(`tool ${name} missing`);
  return t;
}

describe("render-DSL producer↔consumer round-trip", () => {
  it("render_set ⇒ applyRenderMessage replays the dashboard onto a fresh client", async () => {
    const { bus, captured } = rig();
    const { toolDefs } = createRenderToolsForLeader({
      leaderSessionKey: "leader-1",
      bus,
    });
    const setTool = findTool(toolDefs, "render_set");

    await callTool(setTool, {
      title: "My dashboard",
      columns: 3,
      components: [
        { id: "m1", type: "metric", label: "Files", value: "12" },
        { id: "t1", type: "text", content: "Hello" },
      ],
    });

    // Consumer fed the bus's actual envelope.
    const message = lastRenderMessage(captured);
    const next = applyRenderMessage(emptyRenderState(), message);

    expect(next.layout.columns).toBe(3);
    expect(next.components.map((c) => c.id)).toEqual(["m1", "t1"]);
  });

  it("render_set → render_patch composes by id on the consumer side", async () => {
    const { bus, captured } = rig();
    const { toolDefs } = createRenderToolsForLeader({
      leaderSessionKey: "leader-1",
      bus,
    });
    const setTool = findTool(toolDefs, "render_set");
    const patchTool = findTool(toolDefs, "render_patch");

    let state: RenderState = emptyRenderState();

    await callTool(setTool, {
      components: [
        { id: "m1", type: "metric", label: "A", value: "1" },
        { id: "m2", type: "metric", label: "B", value: "2" },
      ],
    });
    state = applyRenderMessage(state, lastRenderMessage(captured));

    await callTool(patchTool, {
      updates: [{ id: "m1", value: "99" }],
    });
    state = applyRenderMessage(state, lastRenderMessage(captured));

    const m1 = state.components.find((c) => c.id === "m1")!;
    if (m1.type !== "metric") throw new Error("expected metric");
    expect(m1.value).toBe("99");
    // m2 untouched.
    const m2 = state.components.find((c) => c.id === "m2")!;
    if (m2.type !== "metric") throw new Error("expected metric");
    expect(m2.value).toBe("2");
  });

  it("render_append dedupes by id on both producer and consumer sides", async () => {
    const { bus, captured } = rig();
    const { toolDefs, renderState } = createRenderToolsForLeader({
      leaderSessionKey: "leader-1",
      bus,
    });
    const setTool = findTool(toolDefs, "render_set");
    const appendTool = findTool(toolDefs, "render_append");

    await callTool(setTool, {
      components: [
        { id: "m1", type: "metric", label: "A", value: "1" },
        { id: "m2", type: "metric", label: "B", value: "2" },
      ],
    });
    let consumer = applyRenderMessage(emptyRenderState(), lastRenderMessage(captured));

    await callTool(appendTool, {
      components: [
        // m2 already exists on both sides → should replace, not duplicate.
        { id: "m2", type: "metric", label: "B'", value: "22" },
        { id: "m3", type: "metric", label: "C", value: "3" },
      ],
    });
    consumer = applyRenderMessage(consumer, lastRenderMessage(captured));

    // Server producer state and client consumer state agree on the id list.
    const serverIds = renderState.components.map((c) => c.id);
    const clientIds = consumer.components.map((c) => c.id);
    expect(serverIds).toEqual(clientIds);
    expect(clientIds).toEqual(["m1", "m2", "m3"]);

    // m2's value updated on the client.
    const m2 = consumer.components.find((c) => c.id === "m2")!;
    if (m2.type !== "metric") throw new Error("expected metric");
    expect(m2.value).toBe("22");
  });

  it("render_remove drops the same ids from server state and client state", async () => {
    const { bus, captured } = rig();
    const { toolDefs, renderState } = createRenderToolsForLeader({
      leaderSessionKey: "leader-1",
      bus,
    });
    const setTool = findTool(toolDefs, "render_set");
    const removeTool = findTool(toolDefs, "render_remove");

    await callTool(setTool, {
      components: [
        { id: "a", type: "text", content: "A" },
        { id: "b", type: "text", content: "B" },
        { id: "c", type: "text", content: "C" },
      ],
    });
    let consumer = applyRenderMessage(emptyRenderState(), lastRenderMessage(captured));

    await callTool(removeTool, { ids: ["a", "c"] });
    consumer = applyRenderMessage(consumer, lastRenderMessage(captured));

    expect(renderState.components.map((c) => c.id)).toEqual(["b"]);
    expect(consumer.components.map((c) => c.id)).toEqual(["b"]);
  });

  it("every component variant emitted by the producer parses cleanly on the consumer", async () => {
    const { bus, captured } = rig();
    const { toolDefs } = createRenderToolsForLeader({
      leaderSessionKey: "leader-1",
      bus,
    });
    const setTool = findTool(toolDefs, "render_set");

    // One representative of each major component family. If any of these
    // diverge between the server and client schemas, the consumer's parse
    // would throw — caught here.
    await callTool(setTool, {
      components: [
        { id: "k1", type: "metric", label: "L", value: "V" },
        { id: "k2", type: "text", content: "para" },
        { id: "k3", type: "code", content: "console.log(1)", language: "ts" },
        { id: "k4", type: "list", items: ["one", "two"] },
        {
          id: "k5",
          type: "table",
          headers: ["A", "B"],
          rows: [["1", "2"]],
        },
        { id: "k6", type: "status", label: "OK", state: "success" },
        { id: "k7", type: "progress", label: "p", value: 42 },
      ],
    });

    const next = applyRenderMessage(emptyRenderState(), lastRenderMessage(captured));
    expect(next.components.map((c) => c.id)).toEqual([
      "k1", "k2", "k3", "k4", "k5", "k6", "k7",
    ]);
  });
});
