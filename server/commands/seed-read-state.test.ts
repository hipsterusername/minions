/**
 * seed_read_state — tells the SDK that a file was already read at a given
 * mtime so subsequent Edit calls pass the safety check.
 */
import { describe, expect, it, vi } from "vitest";
import { seedReadState } from "./seed-read-state.ts";
import { setup, cmd } from "./test-harness.ts";

describe("seed_read_state", () => {
  it("forwards path + mtime to queryHandle.seedReadState and replies success", async () => {
    const h = setup();
    const seed = vi.fn(async () => undefined);
    h.setQueryHandle({ seedReadState: seed });

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

    expect(seed).toHaveBeenCalledWith("/p/src/x.ts", 12345);
    expect(h.wsSent[0]!["success"]).toBe(true);
  });

  it("rejects when path is missing", () => {
    const h = setup();
    h.setQueryHandle({ seedReadState: vi.fn() });
    seedReadState(
      h.ctx,
      cmd({ type: "seed_read_state", path: undefined, mtime: 1 }),
      h.ws,
    );
    expect(h.wsSent[0]!["error"]).toContain("path and mtime required");
  });

  it("rejects when mtime is missing (undefined, not zero)", () => {
    const h = setup();
    h.setQueryHandle({ seedReadState: vi.fn() });
    seedReadState(
      h.ctx,
      cmd({ type: "seed_read_state", path: "/p/x.ts", mtime: undefined }),
      h.ws,
    );
    expect(h.wsSent[0]!["error"]).toContain("path and mtime required");
  });

  it("propagates queryHandle errors as control_error", async () => {
    const h = setup();
    h.setQueryHandle({
      seedReadState: vi.fn(async () => {
        throw new Error("invalid path");
      }),
    });
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
