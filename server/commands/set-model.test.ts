import { describe, expect, it, vi } from "vitest";
import { setModel } from "./set-model.ts";
import { setup, cmd, fakeRunControl } from "../../tests/support/server-command-harness.ts";

describe("set_model", () => {
  it("invokes runControl.setModel and mirrors the value onto host.model on resolve", async () => {
    const h = setup();
    const setModelFn = vi.fn(async () => undefined);
    h.setRunControl(fakeRunControl({ setModel: setModelFn }));

    setModel(h.ctx, cmd({ type: "set_model", model: "opus" }), h.ws);
    await Promise.resolve();
    await Promise.resolve();

    expect(setModelFn).toHaveBeenCalledWith("opus");
    expect(h.host.model).toBe("opus");
    expect(h.wsSent[0]!["success"]).toBe(true);
    expect(h.wsSent[0]!["model"]).toBe("opus");
  });

  it("replies with control_error when no runControl is attached (No active query)", () => {
    const h = setup();
    setModel(h.ctx, cmd({ type: "set_model", model: "x" }), h.ws);
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toContain("No active query");
  });

  it("replies 'unsupported by harness' when setModel is absent on the control", () => {
    const h = setup();
    h.host.harnessName = "echo";
    h.setRunControl({ abort() {} });

    setModel(h.ctx, cmd({ type: "set_model", model: "opus" }), h.ws);

    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toMatch(/"set_model"/);
    expect(h.wsSent[0]!["error"]).toMatch(/"echo"/);
  });

  it("propagates the SDK rejection as a control_error and does NOT mirror the model", async () => {
    const h = setup();
    h.host.model = "sonnet";
    h.setRunControl(fakeRunControl({
      setModel: vi.fn(async () => { throw new Error("model not allowed"); }),
    }));

    setModel(h.ctx, cmd({ type: "set_model", model: "opus" }), h.ws);
    await Promise.resolve();
    await Promise.resolve();

    // Mirror only happens in the .then; on reject the host stays unchanged.
    expect(h.host.model).toBe("sonnet");
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toBe("model not allowed");
  });
});
