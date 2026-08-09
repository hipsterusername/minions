/**
 * Singleton streamable-HTTP MCP server bound to loopback.
 *
 * Codex runs as its own process and reaches Minions-internal tools through
 * this endpoint. Claude keeps its in-process `wrapTools()` path.
 *
 * Wire protocol: streamable HTTP MCP per
 * https://modelcontextprotocol.io/specification/2025-06-18/basic/transports.
 *
 * The bridge implements the minimum the spec requires for a tools-only server:
 *
 *   - `POST /mcp/<sessionKey>/<group>` — JSON-RPC 2.0 envelope. Supported
 *     methods: `initialize`, `tools/list`, `tools/call` (see `./dispatch.ts`).
 *     Notifications get a 202 with no body. Responses are `application/json`
 *     (single response) — SSE streaming is allowed by the spec but unused.
 *   - `Authorization: Bearer <token>` is required on every request. Missing
 *     or wrong tokens get `401 Unauthorized` with a JSON-RPC `-32001` error.
 *   - Disposed registrations are indistinguishable from rejected tokens
 *     (intentional — we don't want a probe to learn whether a session ever
 *     existed).
 *
 * The HTTP listener binds to `127.0.0.1:0` so the OS picks a free port. The
 * full URL is exposed via `McpBridgeServer.url`. There is one process-wide
 * server (lazy-started by `getBridgeServer()`); per-session state lives in
 * the `BridgeRegistry` from `./registry.ts`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { NormalizedToolDef } from "../harness/types.ts";
import { BridgeRegistry, type McpBridgeRegistration } from "./registry.ts";
import {
  dispatchMethod,
  ERR_INTERNAL,
  ERR_INVALID_REQUEST,
  ERR_METHOD_NOT_FOUND,
  ERR_UNAUTHORIZED,
  isNotification,
  parseJsonRpc,
  type JsonRpcResponse,
} from "./dispatch.ts";

/** Hard cap for the loopback bridge. Tool arguments must not be able to grow
 * the server process without bound, even when a local child is compromised. */
export const MAX_MCP_REQUEST_BYTES = 1024 * 1024;

// ── Public surface ────────────────────────────────────────────────────────────

export interface McpBridgeServer {
  /** Base URL — e.g. `http://127.0.0.1:54231`. Stable until `dispose()`. */
  readonly url: string;
  /** Mint a session-scoped registration with its own bearer token. */
  register(opts: {
    sessionKey: string;
    groups: Record<string, NormalizedToolDef[]>;
  }): McpBridgeRegistration;
  /** Stop accepting requests and clear every registration. Idempotent. */
  dispose(): Promise<void>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Build a fresh bridge server bound to a free loopback port. Resolves once
 * the listener is ready and the URL builder is wired into the registry.
 *
 * Most callers should use `getBridgeServer()` instead of building their own;
 * tests use this directly so each test owns its own port.
 */
export async function startBridgeServer(): Promise<McpBridgeServer> {
  const registry = new BridgeRegistry();
  const httpServer = createServer((req, res) => {
    handleRequest(req, res, registry).catch((err: unknown) => {
      // Belt-and-braces: handleRequest catches its own errors, but if the
      // promise rejects for any reason we still want a response, not a hang.
      writeJsonRpcError(res, null, ERR_INTERNAL, errorMessage(err), 500);
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("MCP bridge server: unexpected listen address");
  }
  const url = `http://127.0.0.1:${address.port.toString()}`;
  registry.setUrlBuilder((sessionKey, group) => `${url}/mcp/${sessionKey}/${group}`);

  let disposed = false;
  return {
    url,
    register: (opts) => registry.register(opts),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      registry.clear();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}

// ── Singleton ─────────────────────────────────────────────────────────────────

const bridgeSingleton = createMemoizedAttempt(startBridgeServer);

/**
 * Lazily start (or return) the process-wide bridge server. Harnesses that
 * need to mint a registration call this; tests that want isolation use
 * `startBridgeServer()` directly.
 *
 * If startup rejects (e.g. address-in-use, no loopback interface), the
 * cached promise is cleared so a subsequent caller gets a fresh attempt
 * rather than re-receiving the rejected promise forever.
 */
export function getBridgeServer(): Promise<McpBridgeServer> {
  return bridgeSingleton.get();
}

/**
 * Test-only helper: dispose the singleton and forget it so the next call to
 * `getBridgeServer()` creates a fresh one. Production code does not call this.
 */
export async function resetBridgeServerForTests(): Promise<void> {
  const cached = bridgeSingleton.peek();
  bridgeSingleton.reset();
  if (cached === null) return;
  try {
    const server = await cached;
    await server.dispose();
  } catch {
    // A previously-rejected cached attempt has nothing to dispose — swallow.
  }
}

/**
 * Test-only entry point for exercising the HTTP bridge handler without binding
 * a socket. Contract tests use this in sandboxed environments that disallow
 * listen(2), while production callers go through `startBridgeServer()`.
 */
export async function handleBridgeRequestForTests(
  req: IncomingMessage,
  res: ServerResponse,
  registry: BridgeRegistry,
): Promise<void> {
  await handleRequest(req, res, registry);
}

/**
 * Memoize an async factory so successful results are cached and rejections
 * are *not*. Public for tests; internal callers go through `bridgeSingleton`.
 *
 * Behaviour:
 *   - First `get()` call invokes `factory()` and caches the resulting promise.
 *   - While that promise is pending, concurrent `get()` calls receive the
 *     same in-flight promise (no thundering herd).
 *   - If the promise rejects, the cache slot is cleared so the next `get()`
 *     starts a fresh attempt. The rejection still propagates to the caller
 *     that triggered the failure.
 *   - `reset()` drops whatever is cached without disposing it (the caller
 *     owns disposal — see `resetBridgeServerForTests`).
 */
export function createMemoizedAttempt<T>(factory: () => Promise<T>): {
  get(): Promise<T>;
  reset(): void;
  peek(): Promise<T> | null;
} {
  let cached: Promise<T> | null = null;
  return {
    get(): Promise<T> {
      if (cached !== null) return cached;
      const attempt = factory();
      cached = attempt;
      attempt.catch(() => {
        // Only clear when *this* attempt still occupies the slot — a later
        // success or a test reset must not be evicted by a stale rejection.
        if (cached === attempt) cached = null;
      });
      return attempt;
    },
    reset(): void {
      cached = null;
    },
    peek(): Promise<T> | null {
      return cached;
    },
  };
}

// ── HTTP request handling ─────────────────────────────────────────────────────

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  registry: BridgeRegistry,
): Promise<void> {
  if (req.method !== "POST") {
    // The streamable HTTP spec also defines GET (for SSE) and DELETE (for
    // session termination). We don't need either: clients send single
    // request/response pairs and we never push server-initiated messages.
    writeJsonRpcError(res, null, ERR_INVALID_REQUEST, `Method ${req.method ?? ""} not supported`, 405);
    return;
  }

  const route = parseMcpPath(req.url ?? "");
  if (route === null) {
    writeJsonRpcError(res, null, ERR_INVALID_REQUEST, "Path must match /mcp/<sessionKey>/<group>", 404);
    return;
  }

  const bearer = extractBearer(req.headers["authorization"]);
  if (bearer === null) {
    writeJsonRpcError(res, null, ERR_UNAUTHORIZED, "Missing Authorization: Bearer <token>", 401);
    return;
  }

  const lookup = registry.lookup({
    sessionKey: route.sessionKey,
    group: route.group,
    bearerToken: bearer,
  });
  if (!lookup.ok) {
    // Treat every miss as 401 so a probe cannot distinguish "wrong token"
    // from "session never existed". `unknown_group` with a valid token is
    // the one case where we leak existence — it's safe because the token
    // already proves the caller owns the session.
    if (lookup.reason === "unknown_group") {
      writeJsonRpcError(res, null, ERR_METHOD_NOT_FOUND, `Unknown tool group "${route.group}"`, 404);
      return;
    }
    writeJsonRpcError(res, null, ERR_UNAUTHORIZED, "Unauthorized", 401);
    return;
  }

  const bodyResult = await readBody(req, MAX_MCP_REQUEST_BYTES);
  if (!bodyResult.ok) {
    writeJsonRpcError(res, null, ERR_INVALID_REQUEST, bodyResult.error, 413);
    return;
  }
  const body = bodyResult.body;
  const parsed = parseJsonRpc(body);
  if (!parsed.ok) {
    // parseJsonRpc reports `-32700 Parse error` for invalid JSON / empty
    // body and `-32600 Invalid Request` for envelope-shape problems —
    // pass the code through verbatim so clients can branch.
    writeJsonRpcError(res, null, parsed.code, parsed.error, 400);
    return;
  }
  const message = parsed.value;

  // Notifications (no `id`) return 202 with no body per the streamable HTTP spec.
  if (isNotification(message)) {
    res.writeHead(202).end();
    return;
  }

  const response = await dispatchMethod(message, lookup.tools);
  writeJsonRpcResult(res, response);
}

// ── Request parsing helpers ───────────────────────────────────────────────────

function parseMcpPath(rawUrl: string): { sessionKey: string; group: string } | null {
  // Strip query string and fragment (neither expected, but be defensive).
  const path = (rawUrl.split("?", 1)[0] ?? "").split("#", 1)[0] ?? "";
  // Match exactly /mcp/<sessionKey>/<group>. The path-segment charset is
  // pinned to `[A-Za-z0-9_-]+` (mirrors `isUrlSafeIdentifier()` in
  // registry.ts) so encoded slashes (`%2F`), `.`, `..`, or other URL-
  // sensitive characters cannot land in either segment. Anything that
  // doesn't match becomes a 404 — there's no decoding step to second-guess.
  const match = /^\/mcp\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/?$/.exec(path);
  if (match === null) return null;
  const sessionKey = match[1];
  const group = match[2];
  if (sessionKey === undefined || group === undefined) return null;
  return { sessionKey, group };
}

function extractBearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  if (match === null) return null;
  const token = match[1];
  return token === undefined || token.length === 0 ? null : token;
}

async function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; body: string } | { ok: false; error: string }> {
  const declaredLength = req.headers["content-length"];
  if (typeof declaredLength === "string") {
    const parsed = Number(declaredLength);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      // Drain the request so keep-alive connections remain usable.
      req.resume();
      return { ok: false, error: `MCP request body exceeds ${maxBytes} bytes` };
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buffer.length;
    if (total > maxBytes) {
      return { ok: false, error: `MCP request body exceeds ${maxBytes} bytes` };
    }
    chunks.push(buffer);
  }
  return { ok: true, body: Buffer.concat(chunks, total).toString("utf8") };
}

// ── Response helpers ──────────────────────────────────────────────────────────

function writeJsonRpcResult(res: ServerResponse, response: JsonRpcResponse): void {
  const body = JSON.stringify(response);
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body).toString(),
  });
  res.end(body);
}

function writeJsonRpcError(
  res: ServerResponse,
  id: number | string | null,
  code: number,
  message: string,
  status: number,
): void {
  const body = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  // Auth failures send WWW-Authenticate per RFC 6750 so generic HTTP clients
  // know to attach a bearer token on retry.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body).toString(),
  };
  if (status === 401) headers["WWW-Authenticate"] = 'Bearer realm="minions-bridge"';
  res.writeHead(status, headers);
  res.end(body);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
