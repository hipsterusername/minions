/**
 * start_routine — kicks off a routine run by ID via the routine registry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup, cmd } from "./test-harness.ts";

let validateCwdReturn: string | null = "/proj";
vi.mock("../path-guard.ts", async () => {
  const actual = await vi.importActual<typeof import("../path-guard.ts")>(
    "../path-guard.ts",
  );
  return {
    ...actual,
    validateSessionCwd: vi.fn(() => validateCwdReturn),
  };
});

import { startRoutine } from "./start-routine.ts";

beforeEach(() => {
  validateCwdReturn = "/proj";
});

afterEach(() => {
  validateCwdReturn = "/proj";
});

describe("start_routine", () => {
  it("forwards routineId + cwd + inputs to the registry and unicasts routine_started with the new runId", () => {
    const h = setup();
    const startById = vi.fn(() => ({ runId: "run-100" }));
    h.ctx.routines = {
      list: () => [],
      get: () => null,
      register: () => {},
      remove: () => {},
      abort: () => false,
      startById,
    } as unknown as typeof h.ctx.routines;

    startRoutine(
      h.ctx,
      cmd({
        type: "start_routine",
        routineId: "research",
        cwd: "/proj",
        routineInputs: { topic: "fungi" },
        requestId: "req-7",
      }),
      h.ws,
    );

    expect(startById).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/proj",
        cwd: "/proj",
        routineId: "research",
        inputs: { topic: "fungi" },
      }),
    );

    expect(h.wsSent).toHaveLength(1);
    const env = h.wsSent[0]!;
    expect(env["topic"]).toBe("global");
    expect(env["type"]).toBe("routine_started");
    expect(env["runId"]).toBe("run-100");
    expect(env["routineId"]).toBe("research");
    expect(env["requestId"]).toBe("req-7");
  });

  it("emits routine_error when routineId is missing", () => {
    const h = setup();
    h.ctx.routines = {
      list: () => [],
      get: () => null,
      register: () => {},
      remove: () => {},
      abort: () => false,
      startById: vi.fn(),
    } as unknown as typeof h.ctx.routines;

    startRoutine(
      h.ctx,
      cmd({ type: "start_routine", routineId: undefined, cwd: "/proj" }),
      h.ws,
    );

    expect(h.wsSent).toHaveLength(1);
    expect(h.wsSent[0]!["type"]).toBe("routine_error");
    expect(h.wsSent[0]!["error"]).toContain("routineId");
  });

  it("emits routine_error when validateSessionCwd rejects the cwd", () => {
    validateCwdReturn = null;
    const h = setup();
    h.ctx.routines = {
      list: () => [],
      get: () => null,
      register: () => {},
      remove: () => {},
      abort: () => false,
      startById: vi.fn(),
    } as unknown as typeof h.ctx.routines;

    startRoutine(
      h.ctx,
      cmd({ type: "start_routine", routineId: "x", cwd: "/etc" }),
      h.ws,
    );

    expect(h.wsSent[0]!["type"]).toBe("routine_error");
    expect(h.wsSent[0]!["error"]).toContain("under home");
  });

  it("forwards the registry's error string when startById returns { error }", () => {
    const h = setup();
    h.ctx.routines = {
      list: () => [],
      get: () => null,
      register: () => {},
      remove: () => {},
      abort: () => false,
      startById: () => ({ error: "Routine 'x' not found" }),
    } as unknown as typeof h.ctx.routines;

    startRoutine(
      h.ctx,
      cmd({ type: "start_routine", routineId: "x", cwd: "/proj" }),
      h.ws,
    );

    expect(h.wsSent[0]!["type"]).toBe("routine_error");
    expect(h.wsSent[0]!["error"]).toBe("Routine 'x' not found");
  });
});
