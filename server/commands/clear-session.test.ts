/**
 * clear_session — wipes in-memory event buffer, resets cost/turns, emits
 * session_cleared to the bus.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { clearSession } from "./clear-session.ts";
import { disablePersistence } from "../session-persist.ts";
import { setup, cmd } from "../../tests/support/server-command-harness.ts";
import type { BufferedEvent } from "../session-host-config.ts";

beforeEach(() => disablePersistence());

const fakeEvent = (sessionKey: string): BufferedEvent => ({
  type: "sdk_event",
  sessionKey,
  timestamp: Date.now(),
});

describe("clear_session", () => {
  it("empties the event buffer and resets cost/turns", () => {
    const h = setup({ status: "idle" });
    h.host.eventBuffer = [fakeEvent("leader-1"), fakeEvent("leader-1")];
    h.host.totalCost = 1.23;
    h.host.turns = 5;

    clearSession(h.ctx, cmd({ type: "clear_session" }), h.ws);

    expect(h.host.eventBuffer).toHaveLength(0);
    expect(h.host.totalCost).toBe(0);
    expect(h.host.turns).toBe(0);
  });

  it("emits session_cleared to the bus", () => {
    const h = setup({ status: "idle" });

    clearSession(h.ctx, cmd({ type: "clear_session" }), h.ws);

    const cleared = h.busSent.find((e) => e.type === "session_cleared");
    expect(cleared).toBeDefined();
    expect(cleared!["sessionKey"]).toBe("leader-1");
  });

  it("is a no-op when the session is running", () => {
    const h = setup({ status: "running" });
    h.host.eventBuffer = [fakeEvent("leader-1")];

    clearSession(h.ctx, cmd({ type: "clear_session" }), h.ws);

    expect(h.host.eventBuffer).toHaveLength(1);
    expect(h.busSent).toHaveLength(0);
  });

  it("is a no-op when sessionKey is missing", () => {
    const h = setup({ status: "idle" });
    h.host.eventBuffer = [fakeEvent("leader-1")];

    clearSession(
      h.ctx,
      cmd({ type: "clear_session", sessionKey: undefined }),
      h.ws,
    );

    expect(h.host.eventBuffer).toHaveLength(1);
    expect(h.busSent).toHaveLength(0);
  });

  it("is a no-op for an unknown session key", () => {
    const h = setup({ status: "idle" });

    clearSession(
      h.ctx,
      cmd({ type: "clear_session", sessionKey: "ghost" }),
      h.ws,
    );

    expect(h.busSent).toHaveLength(0);
  });
});
