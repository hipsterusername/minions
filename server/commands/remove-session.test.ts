/**
 * remove_session — completely tear down a session: cancel the run,
 * remove the worktree if any, drop the row from SQLite, broadcast an
 * updated session_list.
 *
 * Phase A: updated to use setRunControl. close() is fire-and-forget on
 * teardown — absence produces no error.
 *
 * Mocks `removeWorktree` and `removePersistedSession` at the boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeInfo } from "../worktree-types.ts";
import { setup, cmd, fakeRunControl } from "../../tests/support/server-command-harness.ts";

const removeWorktreeCalls: { path: string; project: string }[] = [];
const removePersistedCalls: string[] = [];

vi.mock("../worktree.ts", () => ({
  removeWorktree: vi.fn(async (path: string, project: string) => {
    removeWorktreeCalls.push({ path, project });
  }),
}));

vi.mock("../session-persist.ts", async () => {
  const actual = await vi.importActual<
    typeof import("../session-persist.ts")
  >("../session-persist.ts");
  return {
    ...actual,
    removePersistedSession: vi.fn((key: string) => {
      removePersistedCalls.push(key);
    }),
  };
});

import { removeSession } from "./remove-session.ts";

const fakeWorktree: WorktreeInfo = {
  path: "/p/.canvas-worktrees/k",
  branch: "canvas/k",
  leaderSessionKey: "leader-1",
  createdAt: 0,
  projectPath: "/p",
  lifecycle: "active",
};

beforeEach(() => {
  removeWorktreeCalls.length = 0;
  removePersistedCalls.length = 0;
});

afterEach(() => {
  removeWorktreeCalls.length = 0;
  removePersistedCalls.length = 0;
});

describe("remove_session", () => {
  it("aborts the session, drops it from the registry, removes worktree + persisted row, broadcasts session_list", async () => {
    const h = setup({ status: "running" });
    h.host.worktree = fakeWorktree;
    const closeFn = vi.fn(async () => undefined);
    h.setRunControl(fakeRunControl({ close: closeFn }));

    removeSession(h.ctx, cmd({ type: "remove_session" }), h.ws);

    // Synchronous parts.
    expect(h.host.abortController.signal.aborted).toBe(true);
    expect(h.host.worktree).toBeNull();

    // Registry no longer has the session.
    expect(h.ctx.registry.get("leader-1")).toBeUndefined();

    // Persistence and worktree cleanup queued.
    expect(removeWorktreeCalls).toEqual([
      { path: "/p/.canvas-worktrees/k", project: "/p" },
    ]);
    expect(removePersistedCalls).toEqual(["leader-1"]);

    // session_list emitted globally.
    const listEvent = h.busSent.find((e) => e.type === "session_list");
    expect(listEvent).toBeDefined();
    expect(listEvent!["topic"]).toBe("global");
    expect(listEvent!["sessions"]).toEqual([]);
  });

  it("calls runControl.close() fire-and-forget when present", async () => {
    const h = setup({ status: "running" });
    const closeFn = vi.fn(async () => undefined);
    h.setRunControl(fakeRunControl({ close: closeFn }));

    removeSession(h.ctx, cmd({ type: "remove_session" }), h.ws);
    await Promise.resolve();

    expect(closeFn).toHaveBeenCalledTimes(1);
  });

  it("does not error when runControl has no close() method", () => {
    const h = setup({ status: "running" });
    h.setRunControl({ abort() {} });

    expect(() => {
      removeSession(h.ctx, cmd({ type: "remove_session" }), h.ws);
    }).not.toThrow();
  });

  it("rejects with a global error when sessionKey is missing", () => {
    const h = setup();
    removeSession(
      h.ctx,
      cmd({ type: "remove_session", sessionKey: undefined }),
      h.ws,
    );
    expect(h.wsSent).toHaveLength(1);
    expect(h.wsSent[0]!["type"]).toBe("error");
    expect(h.wsSent[0]!["topic"]).toBe("global");
    expect(removePersistedCalls).toEqual([]);
  });

  it("still broadcasts session_list when the session was already gone (idempotent on reload)", () => {
    const h = setup();
    // Drain the seeded session so the registry is empty.
    (h.ctx.registry as unknown as { map: Map<string, unknown> }).map.clear();

    removeSession(
      h.ctx,
      cmd({ type: "remove_session", sessionKey: "leader-1" }),
      h.ws,
    );

    expect(h.busSent.find((e) => e.type === "session_list")).toBeDefined();
    expect(removePersistedCalls).toEqual([]);
  });
});
