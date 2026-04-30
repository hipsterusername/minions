/**
 * list_routines — read routine files from the project sidecar and merge in
 * live runs from the registry. Mocks `listRoutines` from routine-store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup, cmd } from "./test-harness.ts";

let storedReturn: { routines: unknown[]; invalid: unknown[] } = {
  routines: [{ id: "demo", name: "Demo" }],
  invalid: [],
};
const listCalls: string[] = [];

vi.mock("../routine-store.ts", () => ({
  listRoutines: vi.fn((projectPath: string) => {
    listCalls.push(projectPath);
    return storedReturn;
  }),
}));

import { listRoutinesCommand } from "./list-routines.ts";

beforeEach(() => {
  listCalls.length = 0;
  storedReturn = {
    routines: [{ id: "demo", name: "Demo" }],
    invalid: [],
  };
});

afterEach(() => {
  listCalls.length = 0;
});

describe("list_routines", () => {
  it("reads from the cwd-derived sidecar and unicasts routine_list with the merged payload", () => {
    const h = setup();
    const fakeRuns = [{ runId: "r1", state: "running" }];
    h.ctx.routines = {
      list: () => fakeRuns,
      get: () => null,
      register: () => {},
      remove: () => {},
      abort: () => false,
    } as unknown as typeof h.ctx.routines;

    listRoutinesCommand(
      h.ctx,
      cmd({ type: "list_routines", cwd: "/proj" }),
      h.ws,
    );

    expect(listCalls).toEqual(["/proj"]);
    expect(h.wsSent).toHaveLength(1);
    const env = h.wsSent[0]!;
    expect(env["topic"]).toBe("global");
    expect(env["type"]).toBe("routine_list");
    expect(env["projectPath"]).toBe("/proj");
    expect(env["routines"]).toEqual([{ id: "demo", name: "Demo" }]);
    expect(env["invalid"]).toEqual([]);
    expect(env["runs"]).toEqual(fakeRuns);
  });

  it("falls back to process.cwd() when cwd is omitted", () => {
    const h = setup();
    h.ctx.routines = {
      list: () => [],
      get: () => null,
      register: () => {},
      remove: () => {},
      abort: () => false,
    } as unknown as typeof h.ctx.routines;

    listRoutinesCommand(h.ctx, cmd({ type: "list_routines", cwd: undefined }), h.ws);

    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]!).toBe(process.cwd());
  });

  it("forwards `invalid` entries from listRoutines so the UI can surface parse errors", () => {
    storedReturn = {
      routines: [],
      invalid: [{ file: "broken.json", errors: [{ path: "id", message: "bad" }] }],
    };
    const h = setup();
    h.ctx.routines = {
      list: () => [],
      get: () => null,
      register: () => {},
      remove: () => {},
      abort: () => false,
    } as unknown as typeof h.ctx.routines;

    listRoutinesCommand(h.ctx, cmd({ type: "list_routines", cwd: "/p" }), h.ws);

    const env = h.wsSent[0]!;
    expect(env["invalid"]).toHaveLength(1);
  });
});
