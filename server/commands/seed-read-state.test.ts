import { describe, expect, it, vi } from "vitest";
import { seedReadState } from "./seed-read-state.ts";
import { setup, cmd, fakeRunControl } from "../../tests/support/server-command-harness.ts";

describe("seed_read_state", () => {
  it("forwards { path, mtime } to runControl.seedReadState and replies success", async () => {
    const h = setup();
    const seed = vi.fn(async () => undefined);
    h.setRunControl(fakeRunControl({ seedReadState: seed }));

    seedReadState(
      h.ctx,
      cmd({
        type: "seed_read_state",
        path: "/p/src/x.ts",
        mtime: 12345,
      }),
      h.ws,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(seed).toHaveBeenCalledWith({ path: "/p/src/x.ts", mtime: 12345 });
    expect(h.wsSent[0]!["success"]).toBe(true);
  });

  it("rejects when path is missing", () => {
    const h = setup();
    h.setRunControl(fakeRunControl({ seedReadState: vi.fn() }));
    seedReadState(
      h.ctx,
      cmd({ type: "seed_read_state", path: undefined, mtime: 1 }),
      h.ws,
    );
    expect(h.wsSent[0]!["error"]).toContain("path and mtime required");
  });

  it("rejects when mtime is missing (undefined, not zero)", () => {
    const h = setup();
    h.setRunControl(fakeRunControl({ seedReadState: vi.fn() }));
    seedReadState(
      h.ctx,
      cmd({ type: "seed_read_state", path: "/p/x.ts", mtime: undefined }),
      h.ws,
    );
    expect(h.wsSent[0]!["error"]).toContain("path and mtime required");
  });

  it("replies with control_error when no runControl is attached (No active query)", () => {
    const h = setup();
    seedReadState(
      h.ctx,
      cmd({ type: "seed_read_state", path: "/p/x.ts", mtime: 1 }),
      h.ws,
    );
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toContain("No active query");
  });

  it("replies 'unsupported by harness' when seedReadState is absent on the control", () => {
    const h = setup();
    h.host.harnessName = "echo";
    h.setRunControl({ abort() {} });

    seedReadState(
      h.ctx,
      cmd({ type: "seed_read_state", path: "/p/x.ts", mtime: 1 }),
      h.ws,
    );

    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toMatch(/"seed_read_state"/);
    expect(h.wsSent[0]!["error"]).toMatch(/"echo"/);
  });

  it("propagates runControl errors as control_error", async () => {
    const h = setup();
    h.setRunControl(fakeRunControl({
      seedReadState: vi.fn(async () => { throw new Error("invalid path"); }),
    }));
    seedReadState(
      h.ctx,
      cmd({ type: "seed_read_state", path: "/p/x.ts", mtime: 1 }),
      h.ws,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toBe("invalid path");
  });
});
