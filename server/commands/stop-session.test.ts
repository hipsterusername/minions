/**
 * stop_session — aborts the SDK query, sets status=stopped, cancels any
 * wait_and_continue timer, and emits the appropriate events.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { stopSession } from "./stop-session.ts";
import { disablePersistence } from "../session-persist.ts";
import { setup, cmd } from "./test-harness.ts";

beforeEach(() => disablePersistence());

describe("stop_session", () => {
  it("aborts the abortController, sets status=stopped, and emits session_status", () => {
    const h = setup({ status: "running" });
    expect(h.host.abortController.signal.aborted).toBe(false);

    stopSession(h.ctx, cmd({ type: "stop_session" }), h.ws);

    expect(h.host.abortController.signal.aborted).toBe(true);
    expect(h.host.status).toBe("stopped");

    const statusEvent = h.busSent.find((e) => e.type === "session_status");
    expect(statusEvent).toBeDefined();
    expect(statusEvent!["status"]).toBe("stopped");
  });

  it("cancels the wait timer and emits wait_state(cancelled) when one was pending", () => {
    const h = setup({ status: "running" });
    h.host.waitTimerId = setTimeout(() => {
      throw new Error("timer should have been cancelled");
    }, 1000);

    stopSession(h.ctx, cmd({ type: "stop_session" }), h.ws);

    expect(h.host.waitTimerId).toBeNull();
    const waitCancel = h.busSent.find(
      (e) => e.type === "wait_state" && e["action"] === "cancelled",
    );
    expect(waitCancel).toBeDefined();
    expect(waitCancel!["sessionKey"]).toBe("leader-1");
  });

  it("does NOT emit a wait_state when no timer was pending", () => {
    const h = setup({ status: "running" });
    stopSession(h.ctx, cmd({ type: "stop_session" }), h.ws);
    expect(h.busSent.some((e) => e.type === "wait_state")).toBe(false);
  });

  it("is a no-op when sessionKey is missing or the session is unknown", () => {
    const h = setup({ status: "running" });
    stopSession(
      h.ctx,
      cmd({ type: "stop_session", sessionKey: undefined }),
      h.ws,
    );
    stopSession(
      h.ctx,
      cmd({ type: "stop_session", sessionKey: "ghost" }),
      h.ws,
    );
    expect(h.host.status).toBe("running");
    expect(h.busSent).toHaveLength(0);
    expect(h.wsSent).toHaveLength(0);
  });
});
