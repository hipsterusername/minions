/**
 * rewind_files — delegate file rewind to the harness; supports dryRun for
 * preview.
 *
 * Phase A: updated to use setRunControl / fakeRunControl. Call signature
 * updated: rewindFiles({ userMessageId, dryRun }) instead of positional args.
 * Adds tests for "No active query" and "unsupported by harness".
 */
import { describe, expect, it, vi } from "vitest";
import { rewindFiles } from "./rewind-files.ts";
import { setup, cmd, fakeRunControl } from "./test-harness.ts";

describe("rewind_files", () => {
  it("forwards { userMessageId, dryRun } to runControl.rewindFiles and returns the result", async () => {
    const h = setup();
    const rewind = vi.fn(async () => ({ filesAffected: 3 }));
    h.setRunControl(fakeRunControl({ rewindFiles: rewind }));

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

    expect(rewind).toHaveBeenCalledWith({ userMessageId: "user-42", dryRun: true });
    expect(h.wsSent[0]!["success"]).toBe(true);
    expect(h.wsSent[0]!["result"]).toEqual({ filesAffected: 3 });
  });

  it("forwards dryRun=undefined when not supplied (real apply, not a preview)", async () => {
    const h = setup();
    const rewind = vi.fn(async () => ({ filesAffected: 2 }));
    h.setRunControl(fakeRunControl({ rewindFiles: rewind }));

    rewindFiles(
      h.ctx,
      cmd({ type: "rewind_files", userMessageId: "user-1" }),
      h.ws,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(rewind).toHaveBeenCalledWith({ userMessageId: "user-1", dryRun: undefined });
  });

  it("rejects when userMessageId is missing", () => {
    const h = setup();
    h.setRunControl(fakeRunControl({ rewindFiles: vi.fn() }));
    rewindFiles(
      h.ctx,
      cmd({ type: "rewind_files", userMessageId: undefined }),
      h.ws,
    );
    expect(h.wsSent[0]!["error"]).toContain("userMessageId required");
  });

  it("replies with control_error when no runControl is attached (No active query)", () => {
    const h = setup();
    rewindFiles(
      h.ctx,
      cmd({ type: "rewind_files", userMessageId: "x" }),
      h.ws,
    );
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toContain("No active query");
  });

  it("replies 'unsupported by harness' when rewindFiles is absent on the control", () => {
    const h = setup();
    h.host.harnessName = "echo";
    h.setRunControl({ abort() {} });

    rewindFiles(
      h.ctx,
      cmd({ type: "rewind_files", userMessageId: "x" }),
      h.ws,
    );

    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toMatch(/"rewind_files"/);
    expect(h.wsSent[0]!["error"]).toMatch(/"echo"/);
  });

  it("propagates SDK errors as control_error", async () => {
    const h = setup();
    h.setRunControl(fakeRunControl({
      rewindFiles: vi.fn(async () => { throw new Error("nothing to rewind"); }),
    }));
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
