/**
 * list_sessions — unicasts a `session_list` global message with the
 * registry snapshot.
 */
import { describe, expect, it } from "vitest";
import { listSessions } from "./list-sessions.ts";
import { SessionHost } from "../session-host.ts";
import { setup, cmd } from "../../tests/support/server-command-harness.ts";

describe("listSessions", () => {
  it("emits a session_list with the live registry snapshot scoped to the global topic", () => {
    const h = setup({ sessionKey: "first" });
    const second = new SessionHost("second", "/p");
    second.status = "running";
    (h.ctx.registry as unknown as {
      map: Map<string, SessionHost>;
    }).map.set("second", second);

    listSessions(h.ctx, cmd({ type: "list_sessions" }), h.ws);

    expect(h.wsSent).toHaveLength(1);
    const env = h.wsSent[0]!;
    expect(env["topic"]).toBe("global");
    expect(env["type"]).toBe("session_list");
    const sessions = env["sessions"] as Array<{ sessionKey: string }>;
    expect(sessions.map((s) => s.sessionKey).sort()).toEqual([
      "first",
      "second",
    ]);
  });

  it("includes harness + harnessCapabilities on each snapshot entry (Phase B)", () => {
    const h = setup({ sessionKey: "default-claude" });
    const echoHost = new SessionHost("echo-one", "/p");
    echoHost.status = "running";
    echoHost.harnessName = "echo";
    const ghostHost = new SessionHost("ghost", "/p");
    ghostHost.status = "running";
    ghostHost.harnessName = "definitely-not-registered";
    (h.ctx.registry as unknown as {
      map: Map<string, SessionHost>;
    }).map.set("echo-one", echoHost);
    (h.ctx.registry as unknown as {
      map: Map<string, SessionHost>;
    }).map.set("ghost", ghostHost);

    listSessions(h.ctx, cmd({ type: "list_sessions" }), h.ws);

    const sessions = h.wsSent[0]!["sessions"] as Array<{
      sessionKey: string;
      harness: string;
      harnessCapabilities: Record<string, unknown> | null;
    }>;
    const byKey = new Map(sessions.map((s) => [s.sessionKey, s]));

    // Default seeded host falls back to harnessName = "claude".
    expect(byKey.get("default-claude")?.harness).toBe("claude");

    // Registered harness yields a real capabilities snapshot.
    const echo = byKey.get("echo-one");
    expect(echo?.harness).toBe("echo");
    expect(echo?.harnessCapabilities).not.toBeNull();
    expect(echo?.harnessCapabilities?.["mcp"]).toBe(false);

    // Unknown harness comes back as null capabilities, not throw.
    const ghost = byKey.get("ghost");
    expect(ghost?.harness).toBe("definitely-not-registered");
    expect(ghost?.harnessCapabilities).toBeNull();
  });

  it("includes lastActivityAt from the most recent assistant response", () => {
    const h = setup({ sessionKey: "older" });
    h.host.eventBuffer = [
      {
        type: "sdk_event",
        sessionKey: "older",
        event: { kind: "text", role: "assistant", text: "older reply" },
        timestamp: 100,
      },
      {
        type: "session_status",
        sessionKey: "older",
        status: "stopped",
        timestamp: 300,
      },
    ];
    const newer = new SessionHost("newer", "/p");
    newer.status = "stopped";
    newer.eventBuffer = [
      {
        type: "sdk_event",
        sessionKey: "newer",
        event: { kind: "text", role: "assistant", text: "newer reply" },
        timestamp: 200,
      },
      {
        type: "session_status",
        sessionKey: "newer",
        status: "stopped",
        timestamp: 250,
      },
    ];
    (h.ctx.registry as unknown as {
      map: Map<string, SessionHost>;
    }).map.set("newer", newer);

    listSessions(h.ctx, cmd({ type: "list_sessions" }), h.ws);

    const sessions = h.wsSent[0]!["sessions"] as Array<{
      sessionKey: string;
      lastActivityAt: number | null;
    }>;
    const byKey = new Map(sessions.map((s) => [s.sessionKey, s]));
    expect(byKey.get("older")?.lastActivityAt).toBe(100);
    expect(byKey.get("newer")?.lastActivityAt).toBe(200);
  });

  it("emits an empty session list when the registry is empty", () => {
    const h = setup();
    // Drain the seeded session.
    (h.ctx.registry as unknown as {
      map: Map<string, SessionHost>;
    }).map.clear();

    listSessions(h.ctx, cmd({ type: "list_sessions" }), h.ws);

    expect(h.wsSent[0]!["sessions"]).toEqual([]);
  });
});
