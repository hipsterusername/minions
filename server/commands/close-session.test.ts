/**
 * close_session — closes the SDK query, sets status=stopped, emits
 * session_status, and replies with a control_response.
 */
import { describe, expect, it, vi } from "vitest";
import { closeSession } from "./close-session.ts";
import { disablePersistence } from "../session-persist.ts";
import { setup, cmd } from "./test-harness.ts";

beforeEach(() => disablePersistence());

import { beforeEach } from "vitest";

describe("close_session", () => {
  it("closes the queryHandle, transitions status to 'stopped', and emits session_status", () => {
    const h = setup({ status: "running" });
    const close = vi.fn();
    h.setQueryHandle({ close });

    closeSession(h.ctx, cmd({ type: "close_session" }), h.ws);

    expect(close).toHaveBeenCalledTimes(1);
    expect(h.host.status).toBe("stopped");
    expect(h.host.queryHandle).toBeNull();

    // bus emission
    const statusEvent = h.busSent.find((e) => e.type === "session_status");
    expect(statusEvent).toBeDefined();
    expect(statusEvent!["sessionKey"]).toBe("leader-1");
    expect(statusEvent!["status"]).toBe("stopped");

    // event also pushed to host's eventBuffer
    expect(h.host.eventBuffer.some((e) => e.type === "session_status")).toBe(
      true,
    );

    // control_response back to the caller
    const ack = h.wsSent.find((e) => e["type"] === "control_response");
    expect(ack).toBeDefined();
    expect(ack!["success"]).toBe(true);
  });

  it("works when no queryHandle is attached (idle session)", () => {
    const h = setup({ status: "idle" });
    closeSession(h.ctx, cmd({ type: "close_session" }), h.ws);
    expect(h.host.status).toBe("stopped");
    expect(h.busSent.some((e) => e.type === "session_status")).toBe(true);
  });

  it("clears any active wait timer so the session does not auto-resume", () => {
    const h = setup({ status: "running" });
    h.host.waitTimerId = setTimeout(() => {
      throw new Error("wait timer should have been cleared");
    }, 1000);

    closeSession(h.ctx, cmd({ type: "close_session" }), h.ws);

    expect(h.host.waitTimerId).toBeNull();
  });

  it("replies with a session-scoped error when the session is not found", () => {
    const h = setup();
    closeSession(
      h.ctx,
      cmd({ type: "close_session", sessionKey: "ghost" }),
      h.ws,
    );
    expect(h.wsSent).toHaveLength(1);
    expect(h.wsSent[0]!["type"]).toBe("error");
    expect(h.wsSent[0]!["topic"]).toBe("session:ghost");
  });
});
