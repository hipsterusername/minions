/**
 * abort_routine — best-effort cancellation of an in-flight routine run.
 */
import { describe, expect, it, vi } from "vitest";
import { abortRoutine } from "./abort-routine.ts";
import { setup, cmd } from "./test-harness.ts";

describe("abort_routine", () => {
  it("forwards runId to the routine registry and unicasts routine_aborted with accepted=true", () => {
    const h = setup();
    const abort = vi.fn(() => true);
    h.ctx.routines = {
      list: () => [],
      get: () => null,
      register: () => {},
      remove: () => {},
      abort,
    } as unknown as typeof h.ctx.routines;

    abortRoutine(
      h.ctx,
      cmd({
        type: "abort_routine",
        runId: "run-42",
        requestId: "req-1",
      }),
      h.ws,
    );

    expect(abort).toHaveBeenCalledWith("run-42");
    expect(h.wsSent).toHaveLength(1);
    const env = h.wsSent[0]!;
    expect(env["topic"]).toBe("global");
    expect(env["type"]).toBe("routine_aborted");
    expect(env["runId"]).toBe("run-42");
    expect(env["accepted"]).toBe(true);
    expect(env["requestId"]).toBe("req-1");
  });

  it("returns accepted=false when the registry reports the run was unknown / already finished", () => {
    const h = setup();
    h.ctx.routines = {
      list: () => [],
      get: () => null,
      register: () => {},
      remove: () => {},
      abort: () => false,
    } as unknown as typeof h.ctx.routines;

    abortRoutine(h.ctx, cmd({ type: "abort_routine", runId: "stale" }), h.ws);

    expect(h.wsSent[0]!["type"]).toBe("routine_aborted");
    expect(h.wsSent[0]!["accepted"]).toBe(false);
  });

  it("emits routine_error when runId is missing", () => {
    const h = setup();
    h.ctx.routines = {
      list: () => [],
      get: () => null,
      register: () => {},
      remove: () => {},
      abort: vi.fn(),
    } as unknown as typeof h.ctx.routines;

    abortRoutine(
      h.ctx,
      cmd({ type: "abort_routine", runId: undefined }),
      h.ws,
    );

    expect(h.wsSent).toHaveLength(1);
    expect(h.wsSent[0]!["type"]).toBe("routine_error");
    expect(h.wsSent[0]!["error"]).toContain("runId");
  });
});
