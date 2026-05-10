/**
 * JSON-RPC envelope parsing and method dispatch for the bridge.
 *
 * Pure functions — no HTTP, no I/O of its own. The HTTP layer in
 * `server.ts` reads the request body, calls `parseJsonRpc` to validate the
 * envelope, and (when the message is a real request) hands it to
 * `dispatchMethod` together with the tool list resolved from the URL +
 * bearer. The dispatcher returns a JSON-RPC response object the HTTP layer
 * serializes.
 *
 * Keeping this split means the bridge can be unit-tested at two layers:
 * the wire-protocol behaviour at server.test.ts (against a live HTTP
 * listener), and any future protocol-level edge cases here without
 * spinning up the network stack.
 */

import { z } from "zod/v4";
import type { NormalizedToolDef, NormalizedToolResult } from "../harness/types.ts";

// MCP protocol version we implement and report from `initialize`.
export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "minions-bridge", version: "0.1.0" };

// JSON-RPC error codes we use. The 2.0 spec reserves -32700 .. -32603 for
// transport/protocol errors and lets servers define their own in -32000 ..
// -32099. We use -32001 for auth failures and -32601 for unknown methods.
export const ERR_PARSE = -32700;
export const ERR_INVALID_REQUEST = -32600;
export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;
export const ERR_INTERNAL = -32603;
export const ERR_UNAUTHORIZED = -32001;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── Envelope parsing ──────────────────────────────────────────────────────────

/**
 * Parse the raw HTTP body into a validated JSON-RPC request envelope.
 *
 * Per JSON-RPC 2.0, the two failure modes carry distinct codes:
 *   - `-32700 Parse error`     — the body wasn't valid JSON (or was empty).
 *   - `-32600 Invalid Request` — the JSON parsed, but its shape isn't a
 *     well-formed JSON-RPC request (missing/wrong `jsonrpc`, missing
 *     `method`, malformed `id`).
 *
 * The caller surfaces both `code` and `error` verbatim in the JSON-RPC
 * error response.
 */
export function parseJsonRpc(
  body: string,
):
  | { ok: true; value: JsonRpcRequest }
  | { ok: false; code: typeof ERR_PARSE | typeof ERR_INVALID_REQUEST; error: string } {
  if (body.length === 0) {
    return { ok: false, code: ERR_PARSE, error: "Empty request body" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return { ok: false, code: ERR_PARSE, error: `Invalid JSON: ${errorMessage(err)}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {
      ok: false,
      code: ERR_INVALID_REQUEST,
      error: "JSON-RPC request must be an object",
    };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["jsonrpc"] !== "2.0") {
    return {
      ok: false,
      code: ERR_INVALID_REQUEST,
      error: 'Missing or wrong "jsonrpc" field (must be "2.0")',
    };
  }
  if (typeof obj["method"] !== "string") {
    return {
      ok: false,
      code: ERR_INVALID_REQUEST,
      error: 'Missing "method" field',
    };
  }
  // `id` is optional (notifications); when present it must be string,
  // number, or null. Per JSON-RPC 2.0 §4 only the *absence* of `id` makes
  // a request a notification — `id: null` is a real (if discouraged)
  // request id, handled in `isNotification()` below.
  const id = obj["id"];
  if (id !== undefined && id !== null && typeof id !== "string" && typeof id !== "number") {
    return {
      ok: false,
      code: ERR_INVALID_REQUEST,
      error: '"id" must be string, number, or null',
    };
  }
  const req: JsonRpcRequest = {
    jsonrpc: "2.0",
    method: obj["method"],
    ...(id !== undefined ? { id: id as string | number | null } : {}),
    ...(obj["params"] !== undefined ? { params: obj["params"] } : {}),
  };
  return { ok: true, value: req };
}

/**
 * True iff the parsed envelope is a JSON-RPC notification.
 *
 * Per JSON-RPC 2.0 §4: "A Notification is a Request object without an `id`
 * member". Absence of `id` (including `id: undefined` after destructuring)
 * is a notification; `id: null` is a discouraged but valid *request* id
 * and must receive a response. Streamable-HTTP notifications are acked
 * with HTTP 202 and no body.
 */
export function isNotification(msg: JsonRpcRequest): boolean {
  return !("id" in msg) || msg.id === undefined;
}

// ── Method dispatch ───────────────────────────────────────────────────────────

/**
 * Dispatch a parsed request to one of the bridge's supported MCP methods.
 *
 * Supported methods:
 *   - `initialize`  — capability advertisement
 *   - `tools/list`  — reflect the registered NormalizedToolDefs
 *   - `tools/call`  — invoke NormalizedToolDef.handler
 *
 * Anything else returns a `-32601 method not found` error envelope.
 */
export async function dispatchMethod(
  msg: JsonRpcRequest,
  tools: NormalizedToolDef[],
): Promise<JsonRpcResponse> {
  const id = msg.id ?? null;
  switch (msg.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: tools.map(toMcpToolDescriptor) },
      };

    case "tools/call":
      return await handleToolsCall(id, msg.params, tools);

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: ERR_METHOD_NOT_FOUND, message: `Unknown method "${msg.method}"` },
      };
  }
}

async function handleToolsCall(
  id: number | string | null,
  params: unknown,
  tools: NormalizedToolDef[],
): Promise<JsonRpcResponse> {
  if (typeof params !== "object" || params === null) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: ERR_INVALID_PARAMS, message: '"tools/call" requires an object params field' },
    };
  }
  const { name, arguments: args } = params as { name?: unknown; arguments?: unknown };
  if (typeof name !== "string") {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: ERR_INVALID_PARAMS, message: '"tools/call" requires a string "name" param' },
    };
  }
  const def = tools.find((t) => t.name === name);
  if (def === undefined) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: ERR_METHOD_NOT_FOUND, message: `Unknown tool "${name}"` },
    };
  }

  let result: NormalizedToolResult;
  try {
    result = await def.handler(args ?? {});
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: `Tool "${name}" threw: ${errorMessage(err)}` }],
        isError: true,
      },
    };
  }
  return { jsonrpc: "2.0", id, result };
}

/**
 * Convert a NormalizedToolDef to the MCP `tools/list` descriptor shape:
 * `{ name, description, inputSchema: <JSON Schema> }`. Zod v4's
 * `z.toJSONSchema` is the canonical converter.
 */
function toMcpToolDescriptor(def: NormalizedToolDef): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
} {
  const inputSchema = z.toJSONSchema(def.inputSchema) as Record<string, unknown>;
  return {
    name: def.name,
    description: def.description,
    inputSchema,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
