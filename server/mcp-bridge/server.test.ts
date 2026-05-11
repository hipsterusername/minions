/**
 * Integration tests for the streamable HTTP MCP bridge (server.ts).
 *
 * Each test brings up its own bridge via `startBridgeServer()` (NOT the
 * process-wide singleton) so they can run in parallel without sharing
 * registrations or ports. We exercise the wire protocol with raw `fetch`
 * because that's what an external MCP client (Codex) will do.
 *
 * Pinned behaviour:
 *   - `initialize` returns the server's protocolVersion + capabilities.
 *   - `tools/list` returns the registered tools with their JSON Schema.
 *   - `tools/call` dispatches to NormalizedToolDef.handler and returns
 *     its NormalizedToolResult (including `isError`).
 *   - Missing bearer → 401.
 *   - Wrong bearer → 401.
 *   - Another session's valid bearer → 401 (token must match the URL).
 *   - Disposed registration → 401 (indistinguishable from bad token).
 *   - Unknown tool group → 404 with method-not-found.
 *   - Unknown method → JSON-RPC method-not-found error.
 *   - Notification (no `id`) → 202 with no body.
 *   - Tool handler that throws → JSON-RPC `result.isError === true`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod/v4";
import type { WebSocketServer } from "ws";
import { createBus } from "../bus.ts";
import { createRenderToolsForLeader } from "../render-tools.ts";
import { createMemoizedAttempt, startBridgeServer, type McpBridgeServer } from "./server.ts";
import type { McpBridgeRegistration } from "./registry.ts";
import type { NormalizedToolDef } from "../harness/types.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

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

interface JsonRpcEnvelope {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

async function postJsonRpc(
  url: string,
  body: object,
  init: { token?: string | null } = {},
): Promise<{ status: number; json: JsonRpcEnvelope | null; text: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.token !== null && init.token !== undefined) {
    headers["Authorization"] = `Bearer ${init.token}`;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: JsonRpcEnvelope | null = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text) as JsonRpcEnvelope;
    } catch {
      json = null;
    }
  }
  return { status: response.status, json, text };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

describe("MCP bridge HTTP server", () => {
  let bridge: McpBridgeServer;
  let registration: McpBridgeRegistration;

  beforeEach(async () => {
    bridge = await startBridgeServer();
    registration = bridge.register({
      sessionKey: "session-a",
      groups: {
        "task-manager": [
          makeDef({ name: "plan_task" }),
          makeDef({
            name: "throwing_tool",
            handler: async () => {
              throw new Error("boom");
            },
          }),
        ],
        "minion-status": [makeDef({ name: "report_step" })],
      },
    });
  });

  afterEach(async () => {
    await bridge.dispose();
  });

  // ── Happy-path JSON-RPC ────────────────────────────────────────────────────

  it("initialize returns protocolVersion and tools capability", async () => {
    const res = await postJsonRpc(
      registration.urlFor("task-manager"),
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { token: registration.bearerToken },
    );
    expect(res.status).toBe(200);
    const result = res.json?.result as {
      protocolVersion: string;
      capabilities: { tools?: unknown };
      serverInfo: { name: string };
    };
    expect(result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo.name).toBe("minions-bridge");
  });

  it("tools/list returns the registered tools for the correct group", async () => {
    const res = await postJsonRpc(
      registration.urlFor("task-manager"),
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { token: registration.bearerToken },
    );
    expect(res.status).toBe(200);
    const result = res.json?.result as {
      tools: Array<{
        name: string;
        description: string;
        inputSchema: { type: string };
        annotations: {
          readOnlyHint: boolean;
          destructiveHint: boolean;
          openWorldHint: boolean;
          idempotentHint?: boolean;
        };
      }>;
    };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["plan_task", "throwing_tool"]);
    // JSON Schema shape sanity check — z.toJSONSchema produces type:object.
    const planTask = result.tools.find((t) => t.name === "plan_task");
    expect(planTask?.inputSchema.type).toBe("object");
    expect(planTask?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it("tools/list preserves explicit tool annotations", async () => {
    const annotated = bridge.register({
      sessionKey: "session-c",
      groups: {
        "task-manager": [
          makeDef({
            name: "get_task_status",
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              openWorldHint: false,
              idempotentHint: true,
            },
          }),
        ],
      },
    });

    const res = await postJsonRpc(
      annotated.urlFor("task-manager"),
      { jsonrpc: "2.0", id: 20, method: "tools/list" },
      { token: annotated.bearerToken },
    );
    const result = res.json?.result as {
      tools: Array<{ name: string; annotations: Record<string, boolean> }>;
    };
    expect(result.tools[0]).toMatchObject({
      name: "get_task_status",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    });
  });

  it("tools/list for a different group returns that group's tools only", async () => {
    const res = await postJsonRpc(
      registration.urlFor("minion-status"),
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      { token: registration.bearerToken },
    );
    const result = res.json?.result as { tools: Array<{ name: string }> };
    expect(result.tools.map((t) => t.name)).toEqual(["report_step"]);
  });

  it("tools/list exposes render components as objects for schema-limited harnesses", async () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const { toolDefs } = createRenderToolsForLeader({
      leaderSessionKey: "render-schema",
      bus,
    });
    const renderRegistration = bridge.register({
      sessionKey: "render-schema",
      groups: { "render-dashboard": toolDefs },
    });

    const res = await postJsonRpc(
      renderRegistration.urlFor("render-dashboard"),
      { jsonrpc: "2.0", id: 30, method: "tools/list" },
      { token: renderRegistration.bearerToken },
    );

    expect(res.status).toBe(200);
    const result = res.json?.result as {
      tools: Array<{
        name: string;
        inputSchema: {
          properties?: Record<string, { items?: Record<string, unknown> }>;
        };
      }>;
    };
    const renderSet = result.tools.find((t) => t.name === "render_set");
    const componentItems = renderSet?.inputSchema.properties?.["components"]?.items as
      | { type?: string; required?: string[]; properties?: Record<string, unknown> }
      | undefined;

    expect(componentItems?.type).toBe("object");
    expect(componentItems?.required).toEqual(["id", "type"]);
    expect(componentItems?.properties?.["type"]).toMatchObject({
      enum: expect.arrayContaining(["metric", "chart", "section", "file-preview"]),
    });
  });

  it("tools/call invokes the handler and returns its result", async () => {
    const res = await postJsonRpc(
      registration.urlFor("task-manager"),
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "plan_task", arguments: { value: "hello" } },
      },
      { token: registration.bearerToken },
    );
    expect(res.status).toBe(200);
    const result = res.json?.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0]?.text).toBe('{"value":"hello"}');
  });

  it("tools/call rejects invalid render component arguments before state mutation", async () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const { toolDefs, renderState } = createRenderToolsForLeader({
      leaderSessionKey: "render-call",
      bus,
    });
    const renderRegistration = bridge.register({
      sessionKey: "render-call",
      groups: { "render-dashboard": toolDefs },
    });

    const res = await postJsonRpc(
      renderRegistration.urlFor("render-dashboard"),
      {
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: {
          name: "render_set",
          arguments: { components: ['{"id":"x","type":"text","content":"bad"}'] },
        },
      },
      { token: renderRegistration.bearerToken },
    );

    expect(res.status).toBe(200);
    const result = res.json?.result as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("invalid arguments");
    expect(renderState.components).toEqual([]);
  });

  it("tools/call surfaces a thrown handler as isError true", async () => {
    const res = await postJsonRpc(
      registration.urlFor("task-manager"),
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "throwing_tool", arguments: { value: "trigger" } },
      },
      { token: registration.bearerToken },
    );
    expect(res.status).toBe(200);
    const result = res.json?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/throwing_tool.*boom/);
  });

  it("tools/call for an unknown tool returns method-not-found", async () => {
    const res = await postJsonRpc(
      registration.urlFor("task-manager"),
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "nope", arguments: {} },
      },
      { token: registration.bearerToken },
    );
    expect(res.json?.error?.code).toBe(-32601);
  });

  it("unknown JSON-RPC method returns method-not-found", async () => {
    const res = await postJsonRpc(
      registration.urlFor("task-manager"),
      { jsonrpc: "2.0", id: 7, method: "resources/list" },
      { token: registration.bearerToken },
    );
    expect(res.json?.error?.code).toBe(-32601);
  });

  it("notification (no id) is acked with 202 and no body", async () => {
    const res = await postJsonRpc(
      registration.urlFor("task-manager"),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { token: registration.bearerToken },
    );
    expect(res.status).toBe(202);
    expect(res.text).toBe("");
  });

  // ── Auth gating ────────────────────────────────────────────────────────────

  it("missing bearer is rejected with 401", async () => {
    const res = await postJsonRpc(
      registration.urlFor("task-manager"),
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token: null },
    );
    expect(res.status).toBe(401);
    expect(res.json?.error?.code).toBe(-32001);
  });

  it("wrong bearer is rejected with 401", async () => {
    const res = await postJsonRpc(
      registration.urlFor("task-manager"),
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token: "0".repeat(64) },
    );
    expect(res.status).toBe(401);
    expect(res.json?.error?.code).toBe(-32001);
  });

  it("a token from another session is rejected with 401", async () => {
    const otherSession = bridge.register({
      sessionKey: "session-b",
      groups: { "task-manager": [makeDef({ name: "plan_task" })] },
    });
    const res = await postJsonRpc(
      registration.urlFor("task-manager"), // session-a's URL
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token: otherSession.bearerToken }, // session-b's token
    );
    expect(res.status).toBe(401);
  });

  it("disposed registration rejects further requests with 401", async () => {
    registration.dispose();
    const res = await postJsonRpc(
      registration.urlFor("task-manager"),
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token: registration.bearerToken },
    );
    expect(res.status).toBe(401);
  });

  // ── HTTP-shape errors ──────────────────────────────────────────────────────

  it("a path that does not match /mcp/<sessionKey>/<group> is rejected", async () => {
    const url = `${bridge.url}/health`;
    const res = await postJsonRpc(
      url,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token: registration.bearerToken },
    );
    expect(res.status).toBe(404);
  });

  it("unknown group with a valid token returns 404 method-not-found", async () => {
    const url = `${bridge.url}/mcp/session-a/no-such-group`;
    const res = await postJsonRpc(
      url,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token: registration.bearerToken },
    );
    expect(res.status).toBe(404);
    expect(res.json?.error?.code).toBe(-32601);
  });

  it("non-POST methods are rejected with 405", async () => {
    const response = await fetch(registration.urlFor("task-manager"), {
      method: "GET",
      headers: { Authorization: `Bearer ${registration.bearerToken}` },
    });
    expect(response.status).toBe(405);
    await response.text();
  });

  // ── Singleton failure-recovery (pure helper) ───────────────────────────────

  it("createMemoizedAttempt clears the cache when the factory rejects", async () => {
    // The bridge singleton uses this helper so a failed startup doesn't
    // poison every subsequent `getBridgeServer()` call. We exercise the
    // helper directly because mocking ESM internals to simulate an HTTP
    // bind failure is unsupported.
    let calls = 0;
    const factory = (): Promise<string> => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("startup failure"))
        : Promise.resolve(`ok#${calls.toString()}`);
    };
    const memo = createMemoizedAttempt(factory);

    await expect(memo.get()).rejects.toThrow(/startup failure/);
    // Allow microtasks to process the .catch() that clears the slot.
    await new Promise((r) => setTimeout(r, 0));
    expect(memo.peek()).toBeNull();

    // Second call retries from scratch.
    await expect(memo.get()).resolves.toBe("ok#2");
    expect(calls).toBe(2);
  });

  it("createMemoizedAttempt shares the in-flight promise with concurrent callers", async () => {
    let calls = 0;
    const factory = (): Promise<number> => {
      calls += 1;
      return Promise.resolve(calls);
    };
    const memo = createMemoizedAttempt(factory);

    const [a, b] = await Promise.all([memo.get(), memo.get()]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(calls).toBe(1);
  });

  it("invalid JSON body returns -32700 parse error", async () => {
    const response = await fetch(registration.urlFor("task-manager"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${registration.bearerToken}`,
      },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    const json = (await response.json()) as JsonRpcEnvelope;
    expect(json.error?.code).toBe(-32700);
  });

  it("missing jsonrpc field returns -32600 invalid request", async () => {
    const res = await postJsonRpc(
      registration.urlFor("task-manager"),
      { id: 1, method: "tools/list" },
      { token: registration.bearerToken },
    );
    expect(res.status).toBe(400);
    expect(res.json?.error?.code).toBe(-32600);
  });

  it("missing method field returns -32600 invalid request", async () => {
    const res = await postJsonRpc(
      registration.urlFor("task-manager"),
      { jsonrpc: "2.0", id: 1 },
      { token: registration.bearerToken },
    );
    expect(res.status).toBe(400);
    expect(res.json?.error?.code).toBe(-32600);
  });

  it("id: null is treated as a request, not a notification", async () => {
    // Per JSON-RPC 2.0 §4 only the *absence* of `id` is a notification —
    // `id: null` is a valid (if discouraged) request id and must receive
    // a full response, not an HTTP 202.
    const res = await postJsonRpc(
      registration.urlFor("task-manager"),
      { jsonrpc: "2.0", id: null, method: "tools/list" },
      { token: registration.bearerToken },
    );
    expect(res.status).toBe(200);
    expect(res.json?.id).toBeNull();
    expect(res.json?.result).toBeDefined();
  });

  // ── Path-segment hardening ─────────────────────────────────────────────────

  it("encoded slash (%2F) in the sessionKey segment is rejected as 404", async () => {
    // A malicious key cannot smuggle a path separator past the parser.
    const url = `${bridge.url}/mcp/session-a%2Fevil/task-manager`;
    const res = await postJsonRpc(
      url,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token: registration.bearerToken },
    );
    expect(res.status).toBe(404);
  });

  it("dot-segment (..) in the path is rejected as 404", async () => {
    const url = `${bridge.url}/mcp/../task-manager`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${registration.bearerToken}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    // Either Node normalises `..` and the path no longer matches, or our
    // regex rejects it — both paths produce 404, neither produces a hit.
    expect(response.status).toBe(404);
    await response.text();
  });
});
