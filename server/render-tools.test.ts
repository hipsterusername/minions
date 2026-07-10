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
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  describe("html-artifact sanitization (security chokepoint)", () => {
    const MALICIOUS =
      '<div>hi</div><script>alert(1)</script>' +
      '<img src="x" onerror="alert(2)">' +
      '<a href="javascript:alert(3)">link</a>' +
      '<iframe src="https://evil.example"></iframe>';

    function lastEnvelope(sent: object[]): Record<string, unknown> {
      return sent[sent.length - 1] as Record<string, unknown>;
    }

    function assertSafe(html: string): void {
      expect(html).not.toContain("<script");
      expect(html).not.toContain("onerror");
      expect(html.toLowerCase()).not.toContain("javascript:");
      expect(html).not.toContain("<iframe");
      // Defense-in-depth: server wraps in a CSP-locked standalone document.
      expect(html).toContain("Content-Security-Policy");
      expect(html.toLowerCase()).toContain("<!doctype html>");
      // Benign content survives.
      expect(html).toContain("hi");
    }

    it("sanitizes html-artifact.html on render_set (state + wire)", async () => {
      const { bus, sent } = makeBus();
      const { toolDefs, renderState } = createRenderToolsForLeader({
        leaderSessionKey: "s-html-set",
        bus,
      });
      const setTool = findTool(toolDefs, "render_set");

      await call(setTool, {
        components: [{ id: "viz", type: "html-artifact", html: MALICIOUS }],
      });

      const stored = renderState.components[0] as { type: string; html: string };
      expect(stored.type).toBe("html-artifact");
      assertSafe(stored.html);

      const envelope = lastEnvelope(sent);
      const wire = (envelope["components"] as Array<{ html: string }>)[0]!;
      assertSafe(wire.html);
    });

    it("sanitizes html-artifact.html on render_append and render_patch", async () => {
      const { bus, sent } = makeBus();
      const { toolDefs, renderState } = createRenderToolsForLeader({
        leaderSessionKey: "s-html-patch",
        bus,
      });
      const appendTool = findTool(toolDefs, "render_append");
      const patchTool = findTool(toolDefs, "render_patch");

      await call(appendTool, {
        components: [{ id: "viz", type: "html-artifact", html: "<p>ok</p>" }],
      });

      // A patch that swaps in malicious html must be sanitized both in state
      // AND in the patch envelope (which ships updates verbatim to clients).
      await call(patchTool, {
        updates: [{ id: "viz", html: MALICIOUS }],
      });

      const stored = renderState.components[0] as { html: string };
      assertSafe(stored.html);

      const envelope = lastEnvelope(sent);
      const update = (envelope["updates"] as Array<{ html: string }>)[0]!;
      assertSafe(update.html);
    });
  });

  describe("publish_html tool", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "minions-render-html-"));
      process.env["MINIONS_ARTIFACTS_DIR"] = dir;
    });
    afterEach(() => {
      delete process.env["MINIONS_ARTIFACTS_DIR"];
      rmSync(dir, { recursive: true, force: true });
    });

    it("sanitizes, writes a session-scoped temp file, and appends a sandboxed artifact", async () => {
      const { bus, sent } = makeBus();
      const { toolDefs, renderState } = createRenderToolsForLeader({
        leaderSessionKey: "sess-pub",
        bus,
      });
      const publishTool = findTool(toolDefs, "publish_html");
      expect(publishTool).toBeTruthy();

      await call(publishTool, {
        html: '<h1>Report</h1><script>alert(1)</script>',
        title: "My report",
      });

      // Appended to the dashboard as a sanitized html-artifact.
      const comp = renderState.components[0] as {
        type: string;
        html: string;
        title?: string;
        artifactId?: string;
      };
      expect(comp.type).toBe("html-artifact");
      expect(comp.title).toBe("My report");
      expect(comp.artifactId).toBeTruthy();
      expect(comp.html).not.toContain("<script");
      expect(comp.html).toContain("Report");

      // Emitted append envelope carries the sanitized document.
      const envelope = sent[sent.length - 1] as Record<string, unknown>;
      expect(envelope["action"]).toBe("append");

      // A temp file was written under the session-scoped dir, sanitized.
      const sessionDir = join(dir, "sess-pub");
      const files = readdirSync(sessionDir).filter((f) => f.endsWith(".html"));
      expect(files).toHaveLength(1);
      const onDisk = readFileSync(join(sessionDir, files[0]!), "utf8");
      expect(onDisk).not.toContain("<script");
      expect(onDisk).toContain("Content-Security-Policy");
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
