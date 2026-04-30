/**
 * set_permission_mode — calls queryHandle.setPermissionMode(...) then
 * mirrors the new mode onto host.permissionMode.
 */
import { describe, expect, it, vi } from "vitest";
import { setPermissionMode } from "./set-permission-mode.ts";
import { setup, cmd } from "./test-harness.ts";

describe("set_permission_mode", () => {
  it("invokes setPermissionMode and mirrors the value onto host.permissionMode", async () => {
    const h = setup();
    const setMode = vi.fn(async () => undefined);
    h.setQueryHandle({ setPermissionMode: setMode });

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
    h.setQueryHandle({ setPermissionMode: vi.fn() });
    setPermissionMode(
      h.ctx,
      cmd({ type: "set_permission_mode", permissionMode: undefined }),
      h.ws,
    );
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toContain("permissionMode required");
  });

  it("replies with control_error when no queryHandle is attached", () => {
    const h = setup();
    setPermissionMode(
      h.ctx,
      cmd({ type: "set_permission_mode", permissionMode: "auto" }),
      h.ws,
    );
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toContain("No active query");
  });

  it("propagates SDK rejection without mirroring the value", async () => {
    const h = setup();
    h.host.permissionMode = "auto";
    h.setQueryHandle({
      setPermissionMode: vi.fn(async () => {
        throw new Error("invalid mode");
      }),
    });

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
