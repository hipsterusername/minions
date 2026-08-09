/**
 * Per-session registration store for the MCP bridge.
 *
 * Holds the in-memory mapping `sessionKey → { token, groups }` that the HTTP
 * dispatcher in `server.ts` consults on every incoming request. This module
 * is the single source of truth for registration lifecycle:
 *
 *   - `register()` mints a fresh bearer token and stores the tool groups
 *     keyed by sessionKey. Re-registering the same sessionKey replaces the
 *     prior entry and invalidates the prior token (idempotent semantics for
 *     restarts on the same session).
 *   - `lookup()` resolves a (sessionKey, group) pair to the matching tool
 *     definitions iff the supplied bearer token matches the registration's
 *     token. Disposed registrations always miss.
 *   - `dispose()` is idempotent — calling it twice on the same registration
 *     is a no-op rather than an error, so harness teardown paths can be
 *     wired in `finally` blocks without bookkeeping.
 *
 * No HTTP code lives here. `server.ts` owns the listener and translates
 * registry misses into 401/404 responses.
 */

import { randomBytes } from "node:crypto";
import type { NormalizedToolDef } from "../harness/types.ts";

/**
 * What a caller receives from `BridgeRegistry.register()`. Stable for the
 * lifetime of the registration; `dispose()` is the explicit teardown.
 */
export interface McpBridgeRegistration {
  /** Stable session identity — matches the URL path segment. */
  readonly sessionKey: string;
  /** Random per-session bearer token clients must send. */
  readonly bearerToken: string;
  /** Build the URL a harness should hand to its MCP client for one group. */
  urlFor(group: string): string;
  /** Idempotent. Removes the registration and invalidates the token. */
  dispose(): void;
}

/** Outcome of a bearer-checked group lookup. */
export type LookupResult =
  | { ok: true; tools: NormalizedToolDef[] }
  | { ok: false; reason: "unknown_session" | "unknown_group" | "bad_token" | "disposed" };

/**
 * Internal registry — exported for the singleton HTTP server in `server.ts`
 * and for direct unit testing. The HTTP listener calls `lookup()` to gate
 * each request; harnesses call `register()`/`dispose()` around their runs.
 */
export class BridgeRegistry {
  /** sessionKey → entry. `null` after dispose; we keep the key briefly so
   *  callers that forget to drop their `McpBridgeRegistration` reference get
   *  a `disposed` reason instead of a generic `unknown_session` miss. */
  private readonly entries = new Map<string, RegistryEntry | null>();

  /** Hook the HTTP server installs so registrations can build their URLs. */
  private urlBuilder: ((sessionKey: string, group: string) => string) | null = null;

  /**
   * Install the URL builder used by `register()` to compute `urlFor()`.
   * Called once by the bridge HTTP server when it has an active address.
   * Re-installing replaces the previous builder.
   */
  setUrlBuilder(builder: (sessionKey: string, group: string) => string): void {
    this.urlBuilder = builder;
  }

  /**
   * Register a new (or replacement) session. If the same sessionKey is
   * registered twice, the prior entry is disposed first so the prior
   * bearer token stops working immediately.
   */
  register(opts: {
    sessionKey: string;
    groups: Record<string, NormalizedToolDef[]>;
  }): McpBridgeRegistration {
    const { sessionKey, groups } = opts;
    if (!sessionKey) {
      throw new Error("BridgeRegistry.register: sessionKey is required");
    }
    // sessionKey and group names land verbatim in the URL path
    // (`/mcp/<sessionKey>/<group>`). Reject anything outside a narrow
    // URL-safe charset so a client cannot inject `/`, `?`, `#`, percent
    // escapes, or whitespace and produce ambiguous routes the listener
    // would have to disambiguate. The charset matches what
    // `renderBridgeServers()` already enforces on group names.
    if (!isUrlSafeIdentifier(sessionKey)) {
      throw new Error(
        `BridgeRegistry.register: sessionKey "${sessionKey}" must match ${URL_SAFE_PATTERN_DESCRIPTION}`,
      );
    }
    for (const group of Object.keys(groups)) {
      if (!isUrlSafeIdentifier(group)) {
        throw new Error(
          `BridgeRegistry.register: group name "${group}" must match ${URL_SAFE_PATTERN_DESCRIPTION}`,
        );
      }
    }
    if (this.urlBuilder === null) {
      throw new Error(
        "BridgeRegistry.register: urlBuilder not installed — call setUrlBuilder() first " +
          "(usually done by the bridge HTTP server when it starts).",
      );
    }

    // Replace any prior registration for this sessionKey (and invalidate its token).
    const prior = this.entries.get(sessionKey);
    if (prior !== undefined && prior !== null) {
      this.entries.set(sessionKey, null);
    }

    const token = mintToken();
    const entry: RegistryEntry = {
      sessionKey,
      bearerToken: token,
      groups: { ...groups },
    };
    this.entries.set(sessionKey, entry);

    const builder = this.urlBuilder;
    let disposed = false;

    return {
      sessionKey,
      bearerToken: token,
      urlFor: (group: string): string => builder(sessionKey, group),
      dispose: (): void => {
        if (disposed) return;
        disposed = true;
        // Only clear if this exact entry is still installed (a later register()
        // for the same sessionKey already replaced and invalidated us).
        const current = this.entries.get(sessionKey);
        if (current === entry) {
          this.entries.set(sessionKey, null);
        }
      },
    };
  }

  /**
   * Bearer-checked tool lookup for the HTTP dispatcher.
   *
   * The token is compared in constant time so a busy attacker cannot use
   * response timing to brute-force one byte at a time.
   */
  lookup(opts: {
    sessionKey: string;
    group: string;
    bearerToken: string;
  }): LookupResult {
    const slot = this.entries.get(opts.sessionKey);
    if (slot === undefined) return { ok: false, reason: "unknown_session" };
    if (slot === null) return { ok: false, reason: "disposed" };
    if (!constantTimeEqual(opts.bearerToken, slot.bearerToken)) {
      return { ok: false, reason: "bad_token" };
    }
    const tools = slot.groups[opts.group];
    if (!tools) return { ok: false, reason: "unknown_group" };
    return { ok: true, tools };
  }

  /** Test/diagnostic helper. Returns the live group names for a session. */
  groupsFor(sessionKey: string): string[] | null {
    const slot = this.entries.get(sessionKey);
    if (!slot) return null;
    return Object.keys(slot.groups);
  }

  /** Remove every registration. Used by `BridgeServer.dispose()` on shutdown. */
  clear(): void {
    this.entries.clear();
  }
}

interface RegistryEntry {
  sessionKey: string;
  bearerToken: string;
  groups: Record<string, NormalizedToolDef[]>;
}

/** 32 random bytes hex-encoded → 64-char token. */
function mintToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * URL-safe identifier charset shared by sessionKey and group names. Matches
 * the conservative subset that lands literally in `/mcp/<x>/<y>` paths
 * without needing percent-encoding: alphanumerics plus `-` and `_`. We
 * deliberately exclude `.` so a malicious key cannot produce path segments
 * like `..`. The same pattern is enforced on group names by
 * `renderBridgeServers()`; sharing the constant keeps the two surfaces in
 * sync.
 */
const URL_SAFE_PATTERN = /^[A-Za-z0-9_-]+$/;
const URL_SAFE_PATTERN_DESCRIPTION =
  "a non-empty string of letters, digits, '-', or '_'";

/** True iff `value` is a non-empty URL-safe identifier. */
export function isUrlSafeIdentifier(value: string): boolean {
  return value.length > 0 && URL_SAFE_PATTERN.test(value);
}

/**
 * Constant-time string equality. Returns false immediately on length mismatch
 * (length is not secret), then XOR-folds every byte so timing depends only on
 * the longer of the two strings, not on where they diverge.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
