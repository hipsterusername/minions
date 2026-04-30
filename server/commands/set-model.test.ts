/**
 * set_model — calls queryHandle.setModel(...) and mirrors the new model
 * onto the host before replying with control_response.
 */
import { describe, expect, it, vi } from "vitest";
import { setModel } from "./set-model.ts";
import { setup, cmd } from "./test-harness.ts";

describe("set_model", () => {
  it("invokes queryHandle.setModel and mirrors the value onto host.model on resolve", async () => {
    const h = setup();
    const setModelFn = vi.fn(async () => undefined);
    h.setQueryHandle({ setModel: setModelFn });

    setModel(h.ctx, cmd({ type: "set_model", model: "opus" }), h.ws);
    await Promise.resolve();
    await Promise.resolve();

    expect(setModelFn).toHaveBeenCalledWith("opus");
    expect(h.host.model).toBe("opus");
    expect(h.wsSent[0]!["success"]).toBe(true);
    expect(h.wsSent[0]!["model"]).toBe("opus");
  });

  it("replies with control_error when no queryHandle is attached", () => {
    const h = setup();
    setModel(h.ctx, cmd({ type: "set_model", model: "x" }), h.ws);
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toContain("No active query");
  });

  it("propagates the SDK rejection as a control_error and does NOT mirror the model", async () => {
    const h = setup();
    h.host.model = "sonnet";
    h.setQueryHandle({
      setModel: vi.fn(async () => {
        throw new Error("model not allowed");
      }),
    });

    setModel(h.ctx, cmd({ type: "set_model", model: "opus" }), h.ws);
    await Promise.resolve();
    await Promise.resolve();

    // Mirror only happens in the .then; on reject the host stays unchanged.
    expect(h.host.model).toBe("sonnet");
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toBe("model not allowed");
  });
});
