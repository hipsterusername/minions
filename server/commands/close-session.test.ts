import { describe, expect, it, vi } from "vitest";
import { closeSession } from "./close-session.ts";
import { disablePersistence } from "../session-persist.ts";
import { setup, cmd, fakeRunControl } from "../../tests/support/server-command-harness.ts";

beforeEach(() => disablePersistence());

import { beforeEach } from "vitest";

describe("close_session", () => {
  it("calls runControl.close(), transitions status to 'stopped', and emits session_status", async () => {
    const h = setup({ status: "running" });
    const closeFn = vi.fn(async () => undefined);
    h.setRunControl(fakeRunControl({ close: closeFn }));

    closeSession(h.ctx, cmd({ type: "close_session" }), h.ws);

    // close() is fire-and-forget — let it settle
    await Promise.resolve();

    expect(closeFn).toHaveBeenCalledTimes(1);
    expect(h.host.status).toBe("stopped");
    expect(h.host.runControl).toBeNull();
    expect(h.host.eventStream).toBeNull();

    // bus emission
    const statusEvent = h.busSent.find((e) => e.type === "session_status");
    expect(statusEvent).toBeDefined();
    expect(statusEvent!["sessionKey"]).toBe("leader-1");
    expect(statusEvent!["status"]).toBe("stopped");

    // event also pushed to host's eventBuffer
    expect(h.host.eventBuffer.some((e) => e.type === "session_status")).toBe(true);

    // control_response back to the caller
    const ack = h.wsSent.find((e) => e["type"] === "control_response");
    expect(ack).toBeDefined();
    expect(ack!["success"]).toBe(true);
  });

  it("works when no runControl is attached (idle session) — close absence is a no-op", () => {
    const h = setup({ status: "idle" });
    closeSession(h.ctx, cmd({ type: "close_session" }), h.ws);
    expect(h.host.status).toBe("stopped");
    expect(h.host.runControl).toBeNull();
    expect(h.busSent.some((e) => e.type === "session_status")).toBe(true);
  });

  it("does NOT emit 'unsupported by harness' when close() is absent — it is best-effort", () => {
    const h = setup({ status: "running" });
    // runControl with abort() only, no close()
    const abort = vi.fn();
    h.setRunControl({ abort });

    closeSession(h.ctx, cmd({ type: "close_session" }), h.ws);

    // Only one message: the control_response success — no error
    const errors = h.wsSent.filter((e) => e["success"] === false);
    expect(errors).toHaveLength(0);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(h.host.status).toBe("stopped");
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
