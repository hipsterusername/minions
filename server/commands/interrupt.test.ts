/**
 * interrupt / interrupt_session — both delegate to queryHandle.interrupt()
 * via the shared `runQueryOp` helper.
 */
import { describe, expect, it, vi } from "vitest";
import { interrupt, interruptSession } from "./interrupt.ts";
import { setup, cmd, fakeQueryHandle } from "./test-harness.ts";

describe.each([
  { name: "interrupt", handler: interrupt },
  { name: "interrupt_session", handler: interruptSession },
])("$name", ({ name, handler }) => {
  it("calls queryHandle.interrupt() and replies with a successful control_response", async () => {
    const h = setup();
    const interruptFn = vi.fn(async () => undefined);
    h.setQueryHandle(fakeQueryHandle({ interrupt: interruptFn }));

    handler(h.ctx, cmd({ type: name as never }), h.ws);
    await Promise.resolve();
    await Promise.resolve();

    expect(interruptFn).toHaveBeenCalledTimes(1);
    expect(h.wsSent).toHaveLength(1);
    expect(h.wsSent[0]!["type"]).toBe("control_response");
    expect(h.wsSent[0]!["command"]).toBe(name);
    expect(h.wsSent[0]!["success"]).toBe(true);
  });

  it("replies with control_error when no queryHandle is attached", () => {
    const h = setup();
    handler(h.ctx, cmd({ type: name as never }), h.ws);
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toContain("No active query");
  });
});
