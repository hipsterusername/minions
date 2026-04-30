/**
 * list_sessions — unicasts a `session_list` global message with the
 * registry snapshot.
 */
import { describe, expect, it } from "vitest";
import { listSessions } from "./list-sessions.ts";
import { SessionHost } from "../session-host.ts";
import { setup, cmd } from "./test-harness.ts";

describe("listSessions", () => {
  it("emits a session_list with the live registry snapshot scoped to the global topic", () => {
    const h = setup({ sessionKey: "first" });
    // Seed a second host so the snapshot has more than one entry.
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
