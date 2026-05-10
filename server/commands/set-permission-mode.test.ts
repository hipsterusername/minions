/**
 * set_permission_mode — calls runControl.setPermissionMode(...) then
 * mirrors the new mode onto host.permissionMode.
 *
 * Phase A: updated to use setRunControl / fakeRunControl. Adds tests for
 * "No active query" and "unsupported by harness".
 */
import { describe, expect, it, vi } from "vitest";
import { setPermissionMode } from "./set-permission-mode.ts";
import { setup, cmd, fakeRunControl } from "./test-harness.ts";

describe("set_permission_mode", () => {
  it("invokes setPermissionMode and mirrors the value onto host.permissionMode", async () => {
    const h = setup();
    const setMode = vi.fn(async () => undefined);
    h.setRunControl(fakeRunControl({ setPermissionMode: setMode }));

    setPermissionMode(
      h.ctx,
      cmd({ type: "set_permission_mode", permissionMode: "review" }),
      h.ws,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(setMode).toHaveBeenCalledWith("review");
    expect(h.host.permissionMode).toBe("review");
    expect(h.wsSent[0]!["success"]).toBe(true);
    expect(h.wsSent[0]!["permissionMode"]).toBe("review");
  });

  it("rejects when permissionMode is missing", () => {
    const h = setup();
    h.setRunControl(fakeRunControl());
    setPermissionMode(
      h.ctx,
      cmd({ type: "set_permission_mode", permissionMode: undefined }),
      h.ws,
    );
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toContain("permissionMode required");
  });

  it("replies with control_error when no runControl is attached (No active query)", () => {
    const h = setup();
    setPermissionMode(
      h.ctx,
      cmd({ type: "set_permission_mode", permissionMode: "auto" }),
      h.ws,
    );
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toContain("No active query");
  });

  it("replies 'unsupported by harness' when setPermissionMode is absent on the control", () => {
    const h = setup();
    h.host.harnessName = "echo";
    h.setRunControl({ abort() {} });

    setPermissionMode(
      h.ctx,
      cmd({ type: "set_permission_mode", permissionMode: "auto" }),
      h.ws,
    );

    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toMatch(/"set_permission_mode"/);
    expect(h.wsSent[0]!["error"]).toMatch(/"echo"/);
  });

  it("propagates SDK rejection without mirroring the value", async () => {
    const h = setup();
    h.host.permissionMode = "auto";
    h.setRunControl(fakeRunControl({
      setPermissionMode: vi.fn(async () => { throw new Error("invalid mode"); }),
    }));

    setPermissionMode(
      h.ctx,
      cmd({ type: "set_permission_mode", permissionMode: "review" }),
      h.ws,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(h.host.permissionMode).toBe("auto");
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toBe("invalid mode");
  });
});
