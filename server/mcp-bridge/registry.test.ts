/**
 * Unit tests for BridgeRegistry (server/mcp-bridge/registry.ts).
 *
 * These exercise the in-memory registration store directly — no HTTP
 * involvement. The HTTP-side behaviour (auth headers, JSON-RPC envelope,
 * tool-call dispatch) lives in `server.test.ts`.
 *
 * Behaviour pinned here:
 *   - register/lookup happy path with multiple groups
 *   - bearer-token mismatch surfaces as `bad_token`, not as a missing entry
 *   - dispose is idempotent and invalidates the token
 *   - re-registering the same sessionKey replaces the prior entry and
 *     invalidates the prior token
 *   - urlBuilder must be installed before register()
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod/v4";
import { BridgeRegistry } from "./registry.ts";
import type { NormalizedToolDef } from "../harness/types.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDef(name: string): NormalizedToolDef {
  return {
    name,
    description: `${name} tool`,
    inputSchema: z.object({ value: z.string() }),
    handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
  };
}

function buildRegistry(): BridgeRegistry {
  const reg = new BridgeRegistry();
  reg.setUrlBuilder((sessionKey, group) => `http://test/mcp/${sessionKey}/${group}`);
  return reg;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("BridgeRegistry", () => {
  let registry: BridgeRegistry;

  beforeEach(() => {
    registry = buildRegistry();
  });

  it("register() returns a registration with a token and urlFor()", () => {
    const r = registry.register({
      sessionKey: "s1",
      groups: { "task-manager": [makeDef("plan_task")] },
    });
    expect(r.sessionKey).toBe("s1");
    expect(r.bearerToken).toMatch(/^[0-9a-f]{64}$/);
    expect(r.urlFor("task-manager")).toBe("http://test/mcp/s1/task-manager");
  });

  it("two registrations for distinct sessions get different tokens", () => {
    const a = registry.register({ sessionKey: "a", groups: { g: [] } });
    const b = registry.register({ sessionKey: "b", groups: { g: [] } });
    expect(a.bearerToken).not.toBe(b.bearerToken);
  });

  it("lookup() returns the tool defs when bearer matches", () => {
    const def = makeDef("plan_task");
    const r = registry.register({
      sessionKey: "s1",
      groups: { "task-manager": [def] },
    });
    const result = registry.lookup({
      sessionKey: "s1",
      group: "task-manager",
      bearerToken: r.bearerToken,
    });
    expect(result).toEqual({ ok: true, tools: [def] });
  });

  it("lookup() rejects with bad_token when the token does not match", () => {
    registry.register({ sessionKey: "s1", groups: { g: [] } });
    expect(
      registry.lookup({ sessionKey: "s1", group: "g", bearerToken: "wrong" }),
    ).toEqual({ ok: false, reason: "bad_token" });
  });

  it("lookup() rejects with bad_token when using another session's token", () => {
    const a = registry.register({ sessionKey: "a", groups: { g: [makeDef("x")] } });
    registry.register({ sessionKey: "b", groups: { g: [makeDef("y")] } });
    // Use session a's token to access session b — must fail.
    expect(
      registry.lookup({ sessionKey: "b", group: "g", bearerToken: a.bearerToken }),
    ).toEqual({ ok: false, reason: "bad_token" });
  });

  it("lookup() returns unknown_session for sessions never registered", () => {
    expect(
      registry.lookup({ sessionKey: "ghost", group: "g", bearerToken: "anything" }),
    ).toEqual({ ok: false, reason: "unknown_session" });
  });

  it("lookup() returns unknown_group when the token is valid but the group is missing", () => {
    const r = registry.register({
      sessionKey: "s1",
      groups: { "task-manager": [] },
    });
    expect(
      registry.lookup({
        sessionKey: "s1",
        group: "render-dashboard",
        bearerToken: r.bearerToken,
      }),
    ).toEqual({ ok: false, reason: "unknown_group" });
  });

  it("dispose() invalidates the token (lookup returns disposed)", () => {
    const r = registry.register({ sessionKey: "s1", groups: { g: [] } });
    r.dispose();
    expect(
      registry.lookup({ sessionKey: "s1", group: "g", bearerToken: r.bearerToken }),
    ).toEqual({ ok: false, reason: "disposed" });
  });

  it("dispose() is idempotent — second call is a no-op", () => {
    const r = registry.register({ sessionKey: "s1", groups: { g: [] } });
    r.dispose();
    expect(() => r.dispose()).not.toThrow();
    expect(
      registry.lookup({ sessionKey: "s1", group: "g", bearerToken: r.bearerToken }),
    ).toEqual({ ok: false, reason: "disposed" });
  });

  it("re-registering the same sessionKey invalidates the prior token", () => {
    const first = registry.register({ sessionKey: "s1", groups: { g: [makeDef("a")] } });
    const second = registry.register({ sessionKey: "s1", groups: { g: [makeDef("b")] } });
    expect(second.bearerToken).not.toBe(first.bearerToken);

    // Old token no longer works.
    expect(
      registry.lookup({ sessionKey: "s1", group: "g", bearerToken: first.bearerToken }),
    ).toEqual({ ok: false, reason: "bad_token" });

    // New token returns the new tool defs.
    const result = registry.lookup({
      sessionKey: "s1",
      group: "g",
      bearerToken: second.bearerToken,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tools.map((t) => t.name)).toEqual(["b"]);
  });

  it("disposing a stale registration after re-register is a no-op for the live one", () => {
    const first = registry.register({ sessionKey: "s1", groups: { g: [] } });
    const second = registry.register({ sessionKey: "s1", groups: { g: [] } });
    first.dispose();
    // The second (live) registration must still resolve.
    expect(
      registry.lookup({ sessionKey: "s1", group: "g", bearerToken: second.bearerToken }).ok,
    ).toBe(true);
  });

  it("groupsFor() reflects the registered groups", () => {
    registry.register({
      sessionKey: "s1",
      groups: { a: [], b: [], "task-manager": [] },
    });
    expect(registry.groupsFor("s1")).toEqual(["a", "b", "task-manager"]);
    expect(registry.groupsFor("missing")).toBeNull();
  });

  it("clear() removes every registration", () => {
    registry.register({ sessionKey: "s1", groups: { g: [] } });
    registry.register({ sessionKey: "s2", groups: { g: [] } });
    registry.clear();
    expect(registry.groupsFor("s1")).toBeNull();
    expect(registry.groupsFor("s2")).toBeNull();
  });

  it("register() throws when sessionKey is empty", () => {
    expect(() => registry.register({ sessionKey: "", groups: {} })).toThrow(/sessionKey/);
  });

  it("register() rejects sessionKeys with characters that break URL routing", () => {
    // Slash, percent, dot, whitespace, hash, query — none of these can be
    // allowed: they would land verbatim in /mcp/<sessionKey>/<group> and
    // either change the route or make path parsing ambiguous.
    for (const bad of [
      "with/slash",
      "with space",
      "with.dot",
      "with%2Fencoded",
      "with#hash",
      "with?query",
      "..",
    ]) {
      expect(() => registry.register({ sessionKey: bad, groups: {} })).toThrow(/sessionKey/);
    }
  });

  it("register() rejects group names that contain unsafe characters", () => {
    expect(() =>
      registry.register({ sessionKey: "s1", groups: { "bad name": [] } }),
    ).toThrow(/group name/);
    expect(() =>
      registry.register({ sessionKey: "s1", groups: { "with/slash": [] } }),
    ).toThrow(/group name/);
    expect(() =>
      registry.register({ sessionKey: "s1", groups: { "": [] } }),
    ).toThrow(/group name/);
  });

  it("register() accepts URL-safe identifiers (alphanumeric, '-', '_')", () => {
    expect(() =>
      registry.register({
        sessionKey: "Session_42-x",
        groups: { "task-manager": [], minion_status: [], A1: [] },
      }),
    ).not.toThrow();
  });

  it("register() throws if no urlBuilder is installed", () => {
    const bare = new BridgeRegistry();
    expect(() => bare.register({ sessionKey: "s1", groups: {} })).toThrow(/urlBuilder/);
  });
});
