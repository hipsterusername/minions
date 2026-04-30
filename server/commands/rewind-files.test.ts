/**
 * rewind_files — delegate file rewind to the SDK; supports dryRun for
 * preview.
 */
import { describe, expect, it, vi } from "vitest";
import { rewindFiles } from "./rewind-files.ts";
import { setup, cmd } from "./test-harness.ts";

describe("rewind_files", () => {
  it("forwards userMessageId + dryRun to queryHandle.rewindFiles and returns the result", async () => {
    const h = setup();
    const rewind = vi.fn(async () => ({ filesAffected: 3 }));
    h.setQueryHandle({ rewindFiles: rewind });

    rewindFiles(
      h.ctx,
      cmd({
        type: "rewind_files",
        userMessageId: "user-42",
        dryRun: true,
      }),
      h.ws,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(rewind).toHaveBeenCalledWith("user-42", { dryRun: true });
    expect(h.wsSent[0]!["success"]).toBe(true);
    expect(h.wsSent[0]!["result"]).toEqual({ filesAffected: 3 });
  });

  it("forwards dryRun=undefined when not supplied (real apply, not a preview)", async () => {
    const h = setup();
    const rewind = vi.fn(async () => ({ filesAffected: 2 }));
    h.setQueryHandle({ rewindFiles: rewind });

    rewindFiles(
      h.ctx,
      cmd({ type: "rewind_files", userMessageId: "user-1" }),
      h.ws,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(rewind).toHaveBeenCalledWith("user-1", { dryRun: undefined });
  });

  it("rejects when userMessageId is missing", () => {
    const h = setup();
    h.setQueryHandle({ rewindFiles: vi.fn() });
    rewindFiles(
      h.ctx,
      cmd({ type: "rewind_files", userMessageId: undefined }),
      h.ws,
    );
    expect(h.wsSent[0]!["error"]).toContain("userMessageId required");
  });

  it("propagates SDK errors as control_error", async () => {
    const h = setup();
    h.setQueryHandle({
      rewindFiles: vi.fn(async () => {
        throw new Error("nothing to rewind");
      }),
    });
    rewindFiles(
      h.ctx,
      cmd({ type: "rewind_files", userMessageId: "x" }),
      h.ws,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toBe("nothing to rewind");
  });
});
