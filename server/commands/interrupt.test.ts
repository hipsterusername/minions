/**
 * interrupt / interrupt_session — cancel the in-flight turn without stopping
 * the session.
 *
 * Phase A: updated to use setRunControl / fakeRunControl. Adds tests for the
 * two-step check: "No active query" and "unsupported by harness".
 */
import { describe, expect, it, vi } from "vitest";
import { interrupt, interruptSession } from "./interrupt.ts";
import { setup, cmd, fakeRunControl } from "./test-harness.ts";

describe.each([
  { name: "interrupt", handler: interrupt },
  { name: "interrupt_session", handler: interruptSession },
])("$name", ({ name, handler }) => {
  it("calls runControl.interrupt() and replies with a successful control_response", async () => {
    const h = setup();
    const interruptFn = vi.fn(async () => undefined);
    h.setRunControl(fakeRunControl({ interrupt: interruptFn }));

    handler(h.ctx, cmd({ type: name as never }), h.ws);
    await Promise.resolve();
    await Promise.resolve();

    expect(interruptFn).toHaveBeenCalledTimes(1);
    expect(h.wsSent).toHaveLength(1);
    expect(h.wsSent[0]!["type"]).toBe("control_response");
    expect(h.wsSent[0]!["command"]).toBe(name);
    expect(h.wsSent[0]!["success"]).toBe(true);
  });

  it("replies with control_error when no runControl is attached (No active query)", () => {
    const h = setup();
    handler(h.ctx, cmd({ type: name as never }), h.ws);
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toContain("No active query");
  });

  it("replies with 'unsupported by harness' when interrupt is absent on the control", () => {
    const h = setup();
    h.host.harnessName = "echo";
    // runControl with abort() only — no interrupt method
    h.setRunControl({ abort() {} });

    handler(h.ctx, cmd({ type: name as never }), h.ws);

    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toMatch(/"echo"/);
    expect(h.wsSent[0]!["error"]).toMatch(new RegExp(`"${name}"`));
  });

  it("propagates runControl rejection as control_error", async () => {
    const h = setup();
    h.setRunControl(fakeRunControl({
      interrupt: vi.fn(async () => { throw new Error("interrupted hard"); }),
    }));

    handler(h.ctx, cmd({ type: name as never }), h.ws);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toBe("interrupted hard");
  });
});
