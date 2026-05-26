/**
 * discard_worktree — throw away the worktree branch without merging.
 * Mocks `removeWorktree` at the module boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeInfo } from "../worktree-types.ts";
import { setup, cmd } from "./test-harness.ts";

let removeShouldFail = false;
const removeCalls: { path: string; project: string }[] = [];

vi.mock("../worktree.ts", () => ({
  removeWorktree: vi.fn(async (path: string, project: string) => {
    removeCalls.push({ path, project });
    if (removeShouldFail) throw new Error("rm -rf failed");
  }),
}));

import { discardWorktree } from "./discard-worktree.ts";

const fakeWorktree: WorktreeInfo = {
  path: "/p/.canvas-worktrees/k",
  branch: "canvas/k",
  leaderSessionKey: "leader-1",
  createdAt: 0,
  projectPath: "/p",
  lifecycle: "active",
};

beforeEach(() => {
  removeCalls.length = 0;
  removeShouldFail = false;
});

afterEach(() => {
  removeCalls.length = 0;
});

describe("discard_worktree", () => {
  it("invokes removeWorktree with both path and projectPath, clears state, emits both envelopes", async () => {
    const h = setup();
    h.host.worktree = fakeWorktree;
    h.host.taskState = {
      tasks: new Map([
        [
          "t1",
          {
            taskId: "t1",
            title: "T1",
            description: "",
            priority: "medium",
            executor: "minion",
            minionSessionKey: "minion-1",
            leaderSessionKey: "leader-1",
            status: "running",
            createdAt: Date.now(),
            completedAt: null,
            result: null,
          },
        ],
      ]),
      pendingWait: null,
      approval: { requested: true, requestedAt: 0, summary: "x", diff: null },
    };

    discardWorktree(h.ctx, cmd({ type: "discard_worktree" }), h.ws);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(removeCalls).toEqual([
      { path: "/p/.canvas-worktrees/k", project: "/p" },
    ]);
    expect(h.host.worktree).toBeNull();
    expect(h.host.cwd).toBe("/p");
    expect(h.host.taskState!.approval).toBeNull();
    expect(h.host.taskState!.tasks.get("t1")!.status).toBe("cancelled");

    expect(h.busSent.find((e) => e.type === "worktree_removed")).toBeDefined();
    const resolved = h.busSent.find((e) => e.type === "approval_resolved");
    expect(resolved).toBeDefined();
    expect(resolved!["action"]).toBe("discarded");

    const ack = h.wsSent.find((e) => e["type"] === "control_response");
    expect(ack!["success"]).toBe(true);
  });

  it("rejects with control_error when no worktree is attached", () => {
    const h = setup();
    discardWorktree(h.ctx, cmd({ type: "discard_worktree" }), h.ws);
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toContain("No worktree");
    expect(removeCalls).toHaveLength(0);
  });

  it("propagates the removeWorktree error as control_error and does NOT mutate host state", async () => {
    removeShouldFail = true;
    const h = setup();
    h.host.worktree = fakeWorktree;

    discardWorktree(h.ctx, cmd({ type: "discard_worktree" }), h.ws);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.host.worktree).toBe(fakeWorktree);
    const errAck = h.wsSent.find((e) => e["type"] === "control_response");
    expect(errAck!["success"]).toBe(false);
    expect(errAck!["error"]).toBe("rm -rf failed");
  });
});
